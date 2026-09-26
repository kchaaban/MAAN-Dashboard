// Fits the optimizer's congestion model to the Hajj 1446 GPS history.
//
//   node scripts/calibrate-congestion.js [--min-length 300] [--interval 9] [--profile v1|v2]
//
// --profile v2 uses the stop-inclusive speeds of step 08 (what the routing
// costs use since step 09); v1 the moving-only speeds of 02b.
//
// For each edge, direction and 15-min slot of 7–9 Dhul Hijjah 1446 it takes
//   slowdown  y = free-flow time / observed time − 1
//             (free flow = the edge's 85th-percentile slot speed)
//   load      x = buses on the edge in the slot / lane capacity per slot
//             (lane capacity = lanes × 1800 pcu/h ÷ 4 ÷ 2.5 pcu per bus, as in
//             optimize-routes.js with --capacity-share 1)
// and fits the BPR curve y = K · x^β on binned medians, per road class and
// overall. In the optimizer K = α / share^β, so α and capacity-share are not
// separately identifiable: only K and β matter. The script reports the
// capacity-share that gives K at the optimizer's α.
//
// Buses report every ~9 s when moving, so one crossing an edge in T seconds is
// seen with probability ≈ min(1, T / interval); counts are divided by that.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { Pool } = require('pg');

const args = { 'min-length': 300, interval: 9, alpha: 0.5, bins: 20, profile: 'v1' };
process.argv.slice(2).forEach((a, i, all) => {
    const key = a.replace(/^--/, '');
    if (key in args) args[key] = key === 'profile' ? all[i + 1] : Number(all[i + 1]);
});
// Speed table and the condition for a slot to count, per profile.
const SPEEDS = args.profile === 'v2'
    ? { table: 'routing.edge_speed_profile_v2', ok: 'time_s >= 120 AND dist_m >= 200 AND speed_kmh >= 1' }
    : { table: 'routing.edge_speed_profile', ok: 'n_points >= 10 AND speed_kmh >= 2' };

const LANE_BUSES_PER_SLOT = 1800 / 4 / 2.5;
const DEFAULT_LANES = { motorway: 3, trunk: 3, primary: 2, secondary: 2, tertiary: 1 };
const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];

const net = new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT) || 5431,
    database: process.env.ROUTING_PGDATABASE || 'your_db',
    user: process.env.ROUTING_PGUSER || process.env.PGUSER,
    password: process.env.ROUTING_PGPASSWORD || process.env.PGPASSWORD,
    statement_timeout: 300000,
});

async function loadObservations() {
    const { rows } = await net.query(`
        WITH ff AS (
            SELECT edge_id, dir, percentile_cont(0.85) WITHIN GROUP (ORDER BY speed_kmh) AS ff_kmh
            FROM ${SPEEDS.table}
            WHERE ${SPEEDS.ok}
            GROUP BY 1, 2
            HAVING count(*) >= 20
        )
        SELECT e.highway, e.lanes, e.length_m, p.speed_kmh, ff.ff_kmh, coalesce(f.n_buses, 0) AS n_buses
        FROM ${SPEEDS.table} p
        JOIN ff USING (edge_id, dir)
        JOIN routing.edge e ON e.id = p.edge_id
        LEFT JOIN routing.edge_flow f USING (edge_id, dir, slot)
        WHERE e.length_m >= $1
          AND e.highway = ANY($2)
          AND ${SPEEDS.ok.replace(/(time_s|dist_m|speed_kmh|n_points)/g, 'p.$1')}
          AND p.slot >= TIMESTAMPTZ '2025-06-03 00:00+03' AND p.slot < TIMESTAMPTZ '2025-06-06 00:00+03'`,
        [args['min-length'], CLASSES]);
    return rows.map(r => {
        const lanes = r.lanes || DEFAULT_LANES[r.highway] || 1;
        const crossS = Number(r.length_m) / (Number(r.speed_kmh) / 3.6);
        const seen = Math.min(1, crossS / args.interval);
        return {
            cls: r.highway,
            x: (Number(r.n_buses) / seen) / (lanes * LANE_BUSES_PER_SLOT),
            y: Math.max(0, Number(r.ff_kmh) / Number(r.speed_kmh) - 1),
        };
    }).filter(o => o.x > 0);
}

function median(values) {
    const s = values.slice().sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
}
function quantile(values, q) {
    const s = values.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

// Bins of equal width in log(x), so the sparse high-load tail keeps its own
// bins instead of being averaged into the crowd of light-load slots.
function logBins(obs, count = 24) {
    const xs = obs.map(o => o.x);
    const lo = Math.log(quantile(xs, 0.01));
    const hi = Math.log(quantile(xs, 0.999));
    const bins = Array.from({ length: count }, () => []);
    for (const o of obs) {
        const i = Math.floor((Math.log(o.x) - lo) / (hi - lo) * count);
        if (i >= 0 && i < count) bins[i].push(o);
    }
    return bins.filter(b => b.length >= 30).map(b => ({
        x: median(b.map(o => o.x)), y: median(b.map(o => o.y)), n: b.length,
    }));
}

// y = y0 + K·x^β. y0 is the slowdown at negligible load: the definition of
// free flow (85th percentile) plus causes the bus GPS cannot see (cars,
// signals, closures). Only the part above y0 is congestion from buses.
// For a fixed β, K is fitted by weighted least squares on bins with x ≥ xMin.
function fitFixedBeta(bins, y0, beta, xMin) {
    const pts = bins.filter(b => b.x >= xMin);
    const num = pts.reduce((a, b) => a + b.n * (b.y - y0) * Math.pow(b.x, beta), 0);
    const den = pts.reduce((a, b) => a + b.n * Math.pow(b.x, 2 * beta), 0);
    return Math.max(0, num / den);
}

// Median absolute error of the predicted slowdown factor on the observations
// in the busiest tail, where congestion matters to the optimizer.
function tailError(obs, y0, K, beta, xMin) {
    const tail = obs.filter(o => o.x >= xMin);
    return median(tail.map(o => Math.abs((1 + y0 + K * Math.pow(o.x, beta)) / (1 + o.y) - 1)));
}

function shareFor(K, beta) {
    return K > 0 ? Math.pow(args.alpha / K, 1 / beta) : Infinity;
}

async function main() {
    const obs = await loadObservations();
    const xs = obs.map(o => o.x);
    console.log(`${obs.length} edge-slot observations (edges ≥ ${args['min-length']} m, 7–9 Dhul Hijjah 1446)`);
    console.log(`load x (buses / lane capacity per slot): median ${median(xs).toFixed(3)}, ` +
                `p90 ${quantile(xs, 0.9).toFixed(3)}, p99 ${quantile(xs, 0.99).toFixed(3)}, max ${Math.max(...xs).toFixed(2)}\n`);

    const groups = [['all', obs], ...CLASSES.map(c => [c, obs.filter(o => o.cls === c)])];
    const rows = [];
    let chosen = null;
    for (const [name, list] of groups) {
        if (list.length < 500) continue;
        const bins = logBins(list);
        const lx = list.map(o => o.x);
        const q25 = quantile(lx, 0.25);
        const q50 = quantile(lx, 0.5);
        const y0 = median(list.filter(o => o.x <= q25).map(o => o.y));
        const xMin = quantile(lx, 0.9);
        const row = { class: name, obs: list.length, y0: +y0.toFixed(3) };
        // Pick β by how well the curve follows the binned medians over the
        // upper half of loads (weighted RMSE); the per-slot tail error is
        // reported too but is dominated by noise the bus GPS cannot explain.
        let best = null;
        for (const beta of [1, 2, 3, 4]) {
            const K = fitFixedBeta(bins, y0, beta, q50);
            const upper = bins.filter(b => b.x >= q50);
            const w = upper.reduce((a, b) => a + b.n, 0);
            const rmse = Math.sqrt(upper.reduce((a, b) => a + b.n * (b.y - y0 - K * Math.pow(b.x, beta)) ** 2, 0) / w);
            row[`β${beta}: share`] = +shareFor(K, beta).toFixed(2);
            row[`β${beta}: curve rmse`] = +rmse.toFixed(4);
            if (!best || rmse < best.rmse) best = { beta, K, rmse, share: shareFor(K, beta) };
        }
        row.best = `β${best.beta}, share ${best.share.toFixed(2)}`;
        rows.push(row);
        if (name === 'all') chosen = { ...best, y0, bins };
    }
    console.table(rows);

    console.log(`\nBinned curve, all classes (y − y0 is the part attributed to bus load; y0 = ${chosen.y0.toFixed(3)}):`);
    console.table(chosen.bins.map(b => ({
        x: +b.x.toFixed(3), 'observed y': +b.y.toFixed(3),
        [`fitted β${chosen.beta}`]: +(chosen.y0 + chosen.K * Math.pow(b.x, chosen.beta)).toFixed(3),
        'default β4 share.4': +(chosen.y0 + 0.5 / Math.pow(0.4, 4) * Math.pow(b.x, 4)).toFixed(3),
        n: b.n,
    })));
    console.log(`\nSuggested optimizer settings (α = ${args.alpha}): --beta ${chosen.beta} --capacity-share ${chosen.share.toFixed(2)}`);
}

main()
    .catch(err => { console.error(err); process.exitCode = 1; })
    .finally(() => net.end());
