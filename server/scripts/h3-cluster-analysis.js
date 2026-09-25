// Phase 1 of clustering residences into H3 cells: measures, changes nothing.
//
//   node scripts/h3-cluster-analysis.js [--resolutions 8,9,10]
//
// For each resolution it reports how residences group into cells, how far each
// residence is from its cell's start point by road (the "first mile"), and — on
// the residence → entrance pairs routed today — how much a cell-level route
// (first mile + cell start → entrance) costs against the residence's own
// fastest route. Travel times use routing.edge_cost (1446 observed speeds,
// all-day average), the same basis as the candidates' rank 1.
//
// Needs the h3 extension in transport (h3_latlng_to_cell) and the network of
// sql/routing/01–02b in your_db.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { Pool } = require('pg');

const resolutions = (process.argv.includes('--resolutions')
    ? process.argv[process.argv.indexOf('--resolutions') + 1] : '8,9,10').split(',').map(Number);

// A first mile longer than this, or this many times the straight distance,
// suggests the residence reaches the road network differently from its cell.
const FIRST_MILE_FLAG_S = 180;
const DETOUR_FLAG = 3;

const common = {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT) || 5431,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 2,
    statement_timeout: 600000,
};
const transport = new Pool({ ...common, database: process.env.PGDATABASE || 'transport' });
const net = new Pool({ ...common, database: process.env.ROUTING_PGDATABASE || 'your_db' });

const EDGES_SQL = 'SELECT id, source, target, cost_s AS cost, reverse_cost_s AS reverse_cost FROM routing.edge_cost';

function quantile(values, q) {
    if (!values.length) return NaN;
    const s = values.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
const round = (v, d = 0) => Number.isFinite(v) ? +v.toFixed(d) : null;

async function loadResidences() {
    const cellCols = resolutions.map(r => `h3_latlng_to_cell(point(r.longitude, r.latitude), ${r})::text AS c${r}`).join(', ');
    const { rows } = await transport.query(`
        SELECT r.id, r.longitude AS lon, r.latitude AS lat, ${cellCols},
               EXISTS (SELECT 1 FROM assign_residences a WHERE a.residence_id = r.id) AS assigned,
               EXISTS (SELECT 1 FROM routing.od_pair od WHERE od.residence_id = r.id) AS routed
        FROM residences r
        WHERE r.longitude IS NOT NULL AND r.latitude IS NOT NULL`);
    return rows;
}

// Nearest junction of the main network component for each point.
async function snap(points) {
    const { rows } = await net.query(`
        SELECT p.i::int AS i, v.id AS vertex, v.dist
        FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS p(lon, lat, i)
        CROSS JOIN LATERAL (
            SELECT id, ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)::geography) AS dist
            FROM routing.vertex WHERE in_main
            ORDER BY geom <-> ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326) LIMIT 1) v`,
        [points.map(p => p.lon), points.map(p => p.lat)]);
    const out = new Array(points.length);
    rows.forEach(r => { out[r.i - 1] = { vertex: String(r.vertex), dist: Number(r.dist) }; });
    return out;
}

// Travel time (s) for each [from, to] vertex pair, directed.
async function costs(pairs) {
    const unique = [...new Map(pairs.filter(([a, b]) => a !== b).map(([a, b]) => [`${a}|${b}`, [a, b]])).values()];
    const result = new Map();
    pairs.filter(([a, b]) => a === b).forEach(([a, b]) => result.set(`${a}|${b}`, 0));
    for (let i = 0; i < unique.length; i += 4000) {
        const chunk = unique.slice(i, i + 4000);
        const { rows } = await net.query(`
            SELECT start_vid, end_vid, agg_cost FROM pgr_dijkstraCost($1,
                'SELECT * FROM unnest(ARRAY[${chunk.map(p => p[0]).join(',')}]::bigint[], ARRAY[${chunk.map(p => p[1]).join(',')}]::bigint[]) AS t(source, target)',
                directed => true)`, [EDGES_SQL]);
        rows.forEach(r => result.set(`${r.start_vid}|${r.end_vid}`, Number(r.agg_cost)));
    }
    return result;
}

function metresBetween(a, b) {
    const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    return Math.hypot(x, b.lat - a.lat) * 111320;
}

async function main() {
    const residences = await loadResidences();
    const active = residences.filter(r => r.assigned || r.routed);
    console.log(`${residences.length} residences, ${active.length} assigned or routed (analysed below)\n`);

    const snapped = await snap(active);
    active.forEach((r, i) => { r.vertex = snapped[i].vertex; r.snapM = snapped[i].dist; });

    const { rows: pairs } = await transport.query(`
        SELECT od.residence_id, od.destination_vertex::text AS dest, c.travel_s AS own_s
        FROM routing.od_pair od
        JOIN routing.route_candidate c ON c.od_pair_id = od.id AND c.rank = 1`);
    const byId = new Map(active.map(r => [r.id, r]));

    const summary = [];
    for (const res of resolutions) {
        const key = `c${res}`;
        const cells = new Map();
        for (const r of active) {
            if (!cells.has(r[key])) cells.set(r[key], []);
            cells.get(r[key]).push(r);
        }
        // Start point: the junction nearest to the middle of the cell's residences.
        const cellList = [...cells.entries()].map(([id, members]) => ({
            id, members,
            centre: {
                lon: members.reduce((a, m) => a + m.lon, 0) / members.length,
                lat: members.reduce((a, m) => a + m.lat, 0) / members.length,
            },
        }));
        const starts = await snap(cellList.map(c => c.centre));
        cellList.forEach((c, i) => { c.start = starts[i].vertex; });
        const cellOf = new Map();
        cellList.forEach(c => c.members.forEach(m => cellOf.set(m.id, c)));

        // First mile: residence → its cell's start point.
        const fm = await costs(active.map(r => [r.vertex, cellOf.get(r.id).start]));
        const firstMile = active.map(r => {
            const c = cellOf.get(r.id);
            const s = fm.get(`${r.vertex}|${c.start}`);
            const straight = metresBetween(r, c.centre);
            return { r, s: Number.isFinite(s) ? s : Infinity, straight };
        });
        const flagged = firstMile.filter(f => f.s > FIRST_MILE_FLAG_S
            || (f.straight > 50 && f.s * 8 > f.straight * DETOUR_FLAG));   // ~8 m/s urban: time vs distance
        const radius = cellList.map(c => Math.max(...c.members.map(m => metresBetween(m, c.centre))));
        const sizes = cellList.map(c => c.members.length);

        // Validation on today's pairs: own fastest vs first mile + cell start → entrance.
        const routedPairs = pairs.filter(p => byId.has(p.residence_id));
        const trunk = await costs(routedPairs.map(p => [cellOf.get(p.residence_id).start, p.dest]));
        const errors = routedPairs.map(p => {
            const r = byId.get(p.residence_id);
            const c = cellOf.get(r.id);
            const viaCell = (fm.get(`${r.vertex}|${c.start}`) ?? Infinity) + (trunk.get(`${c.start}|${p.dest}`) ?? Infinity);
            return viaCell - Number(p.own_s);
        }).filter(Number.isFinite);
        const abs = errors.map(Math.abs);
        const cellPairs = new Set(routedPairs.map(p => `${cellOf.get(p.residence_id).id}|${p.dest}`)).size;

        summary.push({
            resolution: res,
            cells: cellList.length,
            'residences / cell (median)': quantile(sizes, 0.5),
            'residences / cell (max)': Math.max(...sizes),
            'cells with 1 residence': sizes.filter(n => n === 1).length,
            'cell radius p90 (m)': round(quantile(radius, 0.9)),
            'first mile median (min)': round(quantile(firstMile.map(f => f.s), 0.5) / 60, 1),
            'first mile p90 (min)': round(quantile(firstMile.map(f => f.s), 0.9) / 60, 1),
            'residences flagged': flagged.length,
            'pairs today → cell pairs': `${routedPairs.length} → ${cellPairs}`,
            'error median (min)': round(quantile(abs, 0.5) / 60, 1),
            'error p90 (min)': round(quantile(abs, 0.9) / 60, 1),
            'within 1 min': `${Math.round(100 * abs.filter(e => e <= 60).length / abs.length)}%`,
            'within 2 min': `${Math.round(100 * abs.filter(e => e <= 120).length / abs.length)}%`,
            'avg error (min)': round(errors.reduce((a, e) => a + e, 0) / errors.length / 60, 2),
        });
    }

    const keys = Object.keys(summary[0]).filter(k => k !== 'resolution');
    console.log('Per resolution:');
    console.table(Object.fromEntries(keys.map(k => [k, Object.fromEntries(summary.map(s => [`res ${s.resolution}`, s[k]]))])));
    console.log(`\nfirst mile = drive from the residence to its cell's start point (1446 speeds).`);
    console.log(`flagged = first mile > ${FIRST_MILE_FLAG_S / 60} min, or a road detour > ${DETOUR_FLAG}× the straight distance.`);
    console.log('error = (first mile + cell start → entrance) − the residence\'s own fastest route, on today\'s routed pairs.');
}

main()
    .catch(err => { console.error(err); process.exitCode = 1; })
    .finally(() => Promise.all([transport.end(), net.end()]));
