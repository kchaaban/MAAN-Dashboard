// Back-tests the travel-time model on real Hajj 1446 bus trips
// (routing.backtest_trip, from sql/routing/07_backtest_trips.sql).
//
//   node scripts/backtest-travel-times.js [--profile v1|v2]
//
// --profile v1 (default): speed profiles of 02b (moving buses only).
// --profile v2: stop-inclusive travel times of 08 (standing in queues counted).
//
// For each trip — a bus leaving its loading stop in Makkah and entering a
// Mina or Arafat entrance — it predicts the duration of the fastest route
// three ways and compares with what the bus actually took:
//   slot     the optimizer's model: every road at its 1446 speed in the
//            departure slot (all-day speed where the slot has no data)
//   all-day  every road at its all-day 1446 speed (how candidates are ranked)
//   freeflow speed limits / road-type defaults, no traffic
// Trips with a stationary spell of 20+ minutes on the way (a holding area or
// a long queue) are reported apart: no route model can predict a hold.
// Results go to routing.backtest_result for further analysis.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { Pool } = require('pg');

const LONG_STOP_S = 1200;
const PROFILE = process.argv.includes('--profile') ? process.argv[process.argv.indexOf('--profile') + 1] : 'v1';
if (!['v1', 'v2'].includes(PROFILE)) { console.error('--profile must be v1 or v2'); process.exit(1); }
const net = new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT) || 5431,
    database: process.env.ROUTING_PGDATABASE || 'your_db',
    user: process.env.PGW_USER,
    password: process.env.PGW_PASSWORD,
    max: 2,
    statement_timeout: 600000,
});

// v2 speeds count only where the history is substantial: ≥ 2 bus-minutes and
// ≥ 200 m of progress in the slot (≥ 10 bus-minutes all-day).
const V2_SPEED = (alias, dir, minTime) => `(SELECT e.length_m / (v.speed_kmh / 3.6) FROM routing.${alias} v
     WHERE v.edge_id = e.id AND v.dir = ${dir} AND v.time_s >= ${minTime} AND v.dist_m >= 200 AND v.speed_kmh >= 1`;
const STATIC_SQL = PROFILE === 'v1'
    ? 'SELECT id, source, target, cost_s AS cost, reverse_cost_s AS reverse_cost FROM routing.edge_cost_v1'
    : `SELECT e.id, e.source, e.target,
              CASE WHEN c.cost_s < 0 THEN -1 ELSE coalesce(${V2_SPEED('edge_speed_static_v2', 1, 600)}), c.cost_s) END AS cost,
              CASE WHEN c.reverse_cost_s < 0 THEN -1 ELSE coalesce(${V2_SPEED('edge_speed_static_v2', -1, 600)}), c.reverse_cost_s) END AS reverse_cost
       FROM routing.edge e JOIN routing.edge_cost c ON c.id = e.id`;
const FREEFLOW_SQL = 'SELECT id, source, target, cost_s AS cost, reverse_cost_s AS reverse_cost FROM routing.edge';
// The optimizer's per-slot costs: the slot's observed speed where it has
// ≥ 5 points (as route_candidate_slot), else the all-day cost.
const slotSql = (slotIso) => PROFILE === 'v2' ? `
    SELECT e.id, e.source, e.target,
           CASE WHEN c.cost_s < 0 THEN -1 ELSE coalesce(${V2_SPEED('edge_speed_profile_v2', 1, 120)} AND v.slot = '${slotIso}'),
                                                        ${V2_SPEED('edge_speed_static_v2', 1, 600)}), c.cost_s) END AS cost,
           CASE WHEN c.reverse_cost_s < 0 THEN -1 ELSE coalesce(${V2_SPEED('edge_speed_profile_v2', -1, 120)} AND v.slot = '${slotIso}'),
                                                        ${V2_SPEED('edge_speed_static_v2', -1, 600)}), c.reverse_cost_s) END AS reverse_cost
    FROM routing.edge e JOIN routing.edge_cost c ON c.id = e.id` : `
    SELECT e.id, e.source, e.target,
           CASE WHEN c.cost_s < 0 THEN -1 ELSE coalesce(e.length_m / (pf.speed_kmh / 3.6), c.cost_s) END AS cost,
           CASE WHEN c.reverse_cost_s < 0 THEN -1 ELSE coalesce(e.length_m / (pr.speed_kmh / 3.6), c.reverse_cost_s) END AS reverse_cost
    FROM routing.edge e
    JOIN routing.edge_cost_v1 c ON c.id = e.id
    LEFT JOIN routing.edge_speed_profile pf ON pf.edge_id = e.id AND pf.dir = 1 AND pf.slot = '${slotIso}'
         AND pf.n_points >= 5 AND pf.speed_kmh >= 3
    LEFT JOIN routing.edge_speed_profile pr ON pr.edge_id = e.id AND pr.dir = -1 AND pr.slot = '${slotIso}'
         AND pr.n_points >= 5 AND pr.speed_kmh >= 3`;

function quantile(values, q) {
    const s = values.filter(Number.isFinite).sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
}
const r1 = v => Number.isFinite(v) ? +v.toFixed(1) : null;

async function costs(edgesSql, pairs) {
    const out = new Map();
    if (!pairs.length) return out;
    const { rows } = await net.query(`
        SELECT start_vid, end_vid, agg_cost FROM pgr_dijkstraCost($1,
            'SELECT * FROM unnest(ARRAY[${pairs.map(p => p[0]).join(',')}]::bigint[], ARRAY[${pairs.map(p => p[1]).join(',')}]::bigint[]) AS t(source, target)',
            directed => true)`, [edgesSql]);
    rows.forEach(r => out.set(`${r.start_vid}|${r.end_vid}`, Number(r.agg_cost)));
    return out;
}

function summarize(label, trips, key) {
    const err = trips.map(t => (t[key] - t.observed_s) / 60).filter(Number.isFinite);
    const rel = trips.map(t => t[key] / t.observed_s).filter(Number.isFinite);
    return {
        model: label,
        trips: err.length,
        'bias median (min)': r1(quantile(err, 0.5)),
        'abs error median (min)': r1(quantile(err.map(Math.abs), 0.5)),
        'abs error p90 (min)': r1(quantile(err.map(Math.abs), 0.9)),
        'predicted / observed (median)': r1(quantile(rel, 0.5) * 10) / 10,
        'within 20%': `${Math.round(100 * rel.filter(x => x >= 0.8 && x <= 1.2).length / rel.length)}%`,
    };
}

async function main() {
    const { rows: trips } = await net.query(`
        SELECT t.zone_id, t.bus_id, t.entry_ts, t.depart_ts, t.observed_s, t.longest_stop_s,
               date_bin('15 minutes', t.depart_ts, TIMESTAMPTZ '2025-06-01 00:00+03') AS slot,
               o.id AS origin_vertex, o.dist AS origin_snap_m, d.id AS dest_vertex
        FROM routing.backtest_trip t
        CROSS JOIN LATERAL (
            SELECT v.id, ST_Distance(v.geom::geography, t.origin::geography) AS dist
            FROM routing.vertex v WHERE v.in_main ORDER BY v.geom <-> t.origin LIMIT 1) o
        JOIN routing.entrance_zone z ON z.zone_id = t.zone_id
        CROSS JOIN LATERAL (
            SELECT v.id FROM routing.vertex v WHERE v.in_main ORDER BY v.geom <-> z.geom LIMIT 1) d`);
    trips.forEach(t => {
        t.observed_s = Number(t.observed_s);
        t.longest_stop_s = Number(t.longest_stop_s);
        t.origin_vertex = String(t.origin_vertex);
        t.dest_vertex = String(t.dest_vertex);
    });
    const usable = trips.filter(t => Number(t.origin_snap_m) <= 300);
    console.log(`${trips.length} trips; ${usable.length} with the loading stop within 300 m of the road network`);

    const pairs = usable.map(t => [t.origin_vertex, t.dest_vertex]);
    const stat = await costs(STATIC_SQL, pairs);
    const free = await costs(FREEFLOW_SQL, pairs);
    const bySlot = new Map();
    usable.forEach(t => {
        const k = new Date(t.slot).toISOString();
        if (!bySlot.has(k)) bySlot.set(k, []);
        bySlot.get(k).push(t);
    });
    let done = 0;
    for (const [slot, list] of bySlot) {
        const c = await costs(slotSql(slot), list.map(t => [t.origin_vertex, t.dest_vertex]));
        list.forEach(t => { t.slot_s = c.get(`${t.origin_vertex}|${t.dest_vertex}`); });
        done += list.length;
    }
    usable.forEach(t => {
        const key = `${t.origin_vertex}|${t.dest_vertex}`;
        t.static_s = stat.get(key);
        t.free_s = free.get(key);
    });
    console.log(`predicted ${done} trips over ${bySlot.size} departure slots (profile ${PROFILE})\n`);

    // Direct trips (07b): the bus's first entrance is the sampled one and it
    // drove at most 2× the straight distance — true residence → entrance trips.
    const { rows: detail } = await net.query(`
        SELECT zone_id, bus_id, entry_ts FROM routing.backtest_trip_detail
        WHERE first_zone = zone_id AND driven_m <= 2 * straight_m`).catch(() => ({ rows: [] }));
    const directKeys = new Set(detail.map(d => `${d.zone_id}|${d.bus_id}|${new Date(d.entry_ts).getTime()}`));
    const direct = usable.filter(t => directKeys.has(`${t.zone_id}|${t.bus_id}|${new Date(t.entry_ts).getTime()}`) && Number.isFinite(t.slot_s));
    if (direct.length) {
        console.log(`Direct trips (${direct.length}):`);
        console.table([summarize('slot (optimizer)', direct, 'slot_s'), summarize('all-day (ranking)', direct, 'static_s'),
                       summarize('free-flow', direct, 'free_s')]);
        const byLen = (lo, hi) => direct.filter(t => t.observed_s >= lo * 60 && t.observed_s < hi * 60);
        console.table([[0, 20], [20, 40], [40, 60], [60, 999]].map(([lo, hi]) => {
            const l = byLen(lo, hi);
            return { observed: hi === 999 ? '60+ min' : `${lo}-${hi} min`, ...summarize('slot', l, 'slot_s') };
        }).map(({ model, ...r }) => r));
    }

    const clean = usable.filter(t => t.longest_stop_s < LONG_STOP_S && Number.isFinite(t.slot_s));
    const held = usable.filter(t => t.longest_stop_s >= LONG_STOP_S && Number.isFinite(t.slot_s));
    console.log(`Trips without a 20+ min stop on the way (${clean.length}):`);
    console.table([summarize('slot (optimizer)', clean, 'slot_s'), summarize('all-day (ranking)', clean, 'static_s'),
                   summarize('free-flow', clean, 'free_s')]);
    console.log(`\nTrips with a 20+ min stop on the way (${held.length}) — slot model:`);
    console.table([summarize('slot (optimizer)', held, 'slot_s')]);

    // Where the optimizer's model is off: by departure hour, entrance, trip length.
    const group = (fn) => {
        const g = new Map();
        clean.forEach(t => { const k = fn(t); if (!g.has(k)) g.set(k, []); g.get(k).push(t); });
        return [...g.entries()].filter(([, l]) => l.length >= 25).sort().map(([k, l]) => ({ group: k, ...summarize('slot', l, 'slot_s') }));
    };
    const hourOf = (t) => {
        const local = new Date(new Date(t.depart_ts).getTime() + 3 * 3600e3);
        const day = local.getUTCDate() - 27 + (local.getUTCMonth() === 5 ? 31 : 0);   // Hijri day (1 DH = 28 May)
        return `${day} DH ${String(local.getUTCHours()).padStart(2, '0')}h`;
    };
    console.log('\nSlot model by departure hour (clean trips):');
    console.table(group(hourOf).map(({ group: g, trips: n, ...m }) => ({ hour: g, trips: n, bias: m['bias median (min)'], 'abs median': m['abs error median (min)'], 'within 20%': m['within 20%'] })));
    console.log('\nSlot model by entrance (clean trips):');
    console.table(group(t => t.zone_id).map(({ group: g, trips: n, ...m }) => ({ entrance: g, trips: n, bias: m['bias median (min)'], 'abs median': m['abs error median (min)'], 'within 20%': m['within 20%'] })));
    console.log('\nSlot model by observed trip length (clean trips):');
    console.table(group(t => { const m = t.observed_s / 60; return m < 20 ? 'a < 20 min' : m < 40 ? 'b 20-40 min' : m < 60 ? 'c 40-60 min' : 'd 60+ min'; })
        .map(({ group: g, trips: n, ...m }) => ({ length: g.slice(2), trips: n, bias: m['bias median (min)'], 'abs median': m['abs error median (min)'], 'within 20%': m['within 20%'] })));

    // Keep the per-trip results for further analysis.
    const client = await net.connect();
    try {
        await client.query('BEGIN');
        const table = PROFILE === 'v1' ? 'routing.backtest_result' : 'routing.backtest_result_v2';
        await client.query(`DROP TABLE IF EXISTS ${table}`);
        await client.query(`
            CREATE TABLE ${table} (
                zone_id text, bus_id int, entry_ts timestamptz, depart_ts timestamptz,
                observed_s double precision, longest_stop_s double precision,
                slot_s double precision, static_s double precision, freeflow_s double precision)`);
        await client.query(`
            INSERT INTO ${table}
            SELECT * FROM unnest($1::text[], $2::int[], $3::timestamptz[], $4::timestamptz[],
                                 $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::float8[])`,
            [usable.map(t => t.zone_id), usable.map(t => t.bus_id), usable.map(t => t.entry_ts), usable.map(t => t.depart_ts),
             usable.map(t => t.observed_s), usable.map(t => t.longest_stop_s), usable.map(t => t.slot_s ?? null),
             usable.map(t => t.static_s ?? null), usable.map(t => t.free_s ?? null)]);
        await client.query(`GRANT SELECT ON ${table} TO ro_user`);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
    console.log(`\nPer-trip results saved to your_db.${PROFILE === 'v1' ? 'routing.backtest_result' : 'routing.backtest_result_v2'}`);
}

main()
    .catch(err => { console.error(err); process.exitCode = 1; })
    .finally(() => net.end());
