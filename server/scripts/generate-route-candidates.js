// Generates diverse candidate routes from each residence to the entrance its
// plans are assigned to, for the route/departure optimizer to choose from.
//
//   node scripts/generate-route-candidates.js [--k 5] [--cost observed|freeflow]
//        [--penalty 1.4] [--max-overlap 0.7] [--max-detour 0.5] [--limit N] [--dry-run]
//
// Reads the network and speeds from ROUTING_PGDATABASE (default your_db, built
// by sql/routing/01 and 02) and writes od_pair / route_candidate /
// route_candidate_slot into the transport database (sql/routing/03).
//
// Diversity uses the penalty method: after each shortest path, the cost of
// its edges is multiplied by --penalty and the search repeats. A path is kept
// when it shares at most --max-overlap of its length with every kept path and
// is at most --max-detour slower than the fastest. k-shortest-path (Yen)
// would return near-identical variants differing by one side street.
//
// --avoid <geojson>: zones to keep routes out of (the Mashaer: Mina, Arafat).
// Default data/geofences_to_avoid_v2.geojson; '' = off. By default
// (--avoid-penalty 0) road segments touching them are banned outright; a
// positive --avoid-penalty instead makes them cost that × their time in the
// search and ranking, so routes cross only when going around costs more.
// Origins and destinations snap to junctions outside the zones.
// Road hierarchy, one rule everywhere: major roads (--major-classes, default
// motorway, trunk, primary and their links) are priced in the search by their
// observed 1446 time; every other road by its free-flow time × --local-weight
// (default 3), never by 1446 speeds — on local streets those mostly reflect
// buses loading at hotels, not through traffic, and sent routes on loops. So a
// route takes the shortest way onto the major network, stays on it, and uses a
// local road only when it is much shorter than the major alternative. Stored
// travel times stay real (1446 speeds on every road). Alternatives using over
// 300 m more local road than the preferred route are not kept.
// --residence <uuid>: only that residence's pairs (for testing).
// --geojson-out <file>: dry run also writes the candidates as GeoJSON.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { Pool } = require('pg');

const args = parseArgs(process.argv.slice(2), {
    k: 5, cost: 'observed', penalty: 1.4, 'max-overlap': 0.7, 'max-detour': 0.5,
    'max-iterations': 12, 'max-snap': 400, limit: 0, 'dry-run': false,
    avoid: 'data/geofences_to_avoid_v2.geojson', 'avoid-penalty': 0,
    'major-classes': 'motorway,trunk,primary', 'local-weight': 3,
    residence: '', 'geojson-out': '',
});

// Zones to avoid, as an SQL geometry expression (null when --avoid '').
const AVOID_SQL = (() => {
    if (!args.avoid) return null;
    const file = require('path').resolve(__dirname, '..', args.avoid);
    const gj = JSON.parse(require('fs').readFileSync(file, 'utf8'));
    const geometry = gj.type === 'Feature' ? gj.geometry
        : gj.type === 'FeatureCollection' ? { type: 'GeometryCollection', geometries: gj.features.map(f => f.geometry) }
        : gj;
    const json = JSON.stringify(geometry).replace(/'/g, "''");
    return `ST_SetSRID(ST_GeomFromGeoJSON('${json}'), 4326)`;
})();

// Search multiplier for the avoid zones on a geometry column: the penalty
// inside, 1 outside (a ban is a WHERE filter instead, see edgesSql).
// Edges touching the zones are listed once in routing.avoid_edge at startup
// (refreshAvoidEdges): testing each edge against the polygon in every search
// parsed the GeoJSON per edge and made a full run many times slower.
const inZoneSql = (idCol) => `EXISTS (SELECT 1 FROM routing.avoid_edge a WHERE a.edge_id = ${idCol})`;
const zoneSql = (idCol) => AVOID_SQL && args['avoid-penalty'] > 0
    ? `(CASE WHEN ${inZoneSql(idCol)} THEN ${Number(args['avoid-penalty'])} ELSE 1 END)`
    : '1';
const MAJOR_CLASSES = `(${String(args['major-classes']).split(',').map(c => `'${c.trim().replace(/'/g, "''")}'`).join(', ')})`;
const isMajorSql = (highwayCol) => `(regexp_replace(${highwayCol}, '_link$', '') IN ${MAJOR_CLASSES})`;
// Search cost of one direction of an edge: observed time on major roads,
// free-flow time × --local-weight elsewhere; × the avoid-zone penalty.
const searchCostSql = (observed, freeflow, highwayCol, idCol) =>
    `(CASE WHEN ${observed} < 0 THEN ${observed}
           WHEN ${isMajorSql(highwayCol)} THEN ${observed}
           ELSE ${freeflow} * ${Number(args['local-weight'])} END) * ${zoneSql(idCol)}`;

const common = {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT) || 5431,
    max: 2,
    connectionTimeoutMillis: 10000,
};
// Network reads only need SELECT on the routing schema.
const net = new Pool({
    ...common,
    database: process.env.ROUTING_PGDATABASE || 'your_db',
    user: process.env.ROUTING_PGUSER || process.env.PGUSER,
    password: process.env.ROUTING_PGPASSWORD || process.env.PGPASSWORD,
    statement_timeout: 120000,
});
// DEBUG_TIMING=1: log every network query slower than 0.5 s (for profiling).
if (process.env.DEBUG_TIMING) {
    const q = net.query.bind(net);
    net.query = async (text, params) => {
        const t = Date.now();
        try { return await q(text, params); } finally {
            const ms = Date.now() - t;
            if (ms > 500) console.log(`[${(ms / 1000).toFixed(1)} s] ${String(text).replace(/\s+/g, ' ').slice(0, 90)}`);
        }
    };
}
const out = new Pool({
    ...common,
    database: process.env.PGDATABASE || 'transport',
    user: process.env.PGW_USER,
    password: process.env.PGW_PASSWORD,
    statement_timeout: 120000,
});

function parseArgs(argv, defaults) {
    const opts = { ...defaults };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i].replace(/^--/, '');
        if (!(key in defaults)) throw new Error(`Unknown option --${key}`);
        if (typeof defaults[key] === 'boolean') opts[key] = true;
        else opts[key] = typeof defaults[key] === 'number' ? Number(argv[++i]) : argv[++i];
    }
    if (!['observed', 'freeflow'].includes(opts.cost)) throw new Error('--cost must be observed or freeflow');
    return opts;
}

// ── Inputs ──────────────────────────────────────────────────────────────────

// Every residence → entrance pair a plan needs, with the path the plans use
// today (the most common one when plans of one pair disagree).
async function loadOdPairs() {
    const { rows } = await out.query(`
        -- plans.residence_id is not populated; a residence start is start_point_id.
        WITH pairs AS (
            SELECT p.start_point_id AS residence_id, p.entrance_id,
                   coalesce(p.path_gis, pa.gis) AS path_geom
            FROM public.plans p
            LEFT JOIN public.paths pa ON pa.id = p.path_id
            WHERE p.start_point_type = 'residence'
              AND p.start_point_id IS NOT NULL AND p.entrance_id IS NOT NULL
        ), current_path AS (
            SELECT DISTINCT ON (residence_id, entrance_id)
                   residence_id, entrance_id, path_geom
            FROM (
                SELECT residence_id, entrance_id, path_geom, count(*) AS n
                FROM pairs WHERE path_geom IS NOT NULL
                GROUP BY 1, 2, 3
            ) c
            ORDER BY residence_id, entrance_id, n DESC
        )
        SELECT DISTINCT pr.residence_id, pr.entrance_id,
               r.longitude AS o_lon, r.latitude AS o_lat,
               coalesce(e.longitude, ST_X(ST_PointOnSurface(e.gis))) AS d_lon,
               coalesce(e.latitude,  ST_Y(ST_PointOnSurface(e.gis))) AS d_lat,
               ST_AsGeoJSON(ST_LineMerge(cp.path_geom)) AS current_path
        FROM pairs pr
        JOIN public.residences r ON r.id = pr.residence_id
        JOIN public.entrances  e ON e.id = pr.entrance_id
        LEFT JOIN current_path cp USING (residence_id, entrance_id)
        WHERE r.longitude IS NOT NULL AND r.latitude IS NOT NULL
    `);
    const picked = args.residence ? rows.filter(r => r.residence_id === args.residence) : rows;
    return args.limit > 0 ? picked.slice(0, args.limit) : picked;
}

async function snap(lon, lat) {
    const { rows } = await net.query(`
        SELECT id, ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS dist_m
        FROM routing.vertex
        WHERE in_main ${AVOID_SQL ? `AND NOT ST_Intersects(geom, ${AVOID_SQL})` : ''}
        ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
        LIMIT 1`, [lon, lat]);
    return rows[0] || null;
}

// ── Routing ─────────────────────────────────────────────────────────────────

const costColumns = args.cost === 'observed'
    ? { table: 'routing.edge_cost', cost: 'cost_s', reverse: 'reverse_cost_s' }
    : { table: 'routing.edge', cost: 'cost_s', reverse: 'reverse_cost_s' };

// Edges within a box around the pair: routes never leave it in practice, and
// pgRouting rebuilds its graph from this query on every call. Search cost =
// road-hierarchy cost (see searchCostSql) × diversity penalty (or, with
// --avoid-penalty 0, edges in the zones are left out).
function edgesSql(bbox, penalties) {
    const [minX, minY, maxX, maxY] = bbox.map(Number);
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) throw new Error('bad bbox');
    const pen = penalties.size
        ? `(CASE c.id ${Array.from(penalties, ([id, n]) => `WHEN ${Number(id)} THEN ${Math.pow(args.penalty, n)}`).join(' ')} ELSE 1 END)`
        : '1';
    const col = (obs, free) => `CASE WHEN c.${obs} < 0 THEN c.${obs} ELSE ${searchCostSql(`c.${obs}`, `h.${free}`, 'h.highway', 'c.id')} * ${pen} END`;
    const ban = AVOID_SQL && !(args['avoid-penalty'] > 0);
    return `SELECT c.id, c.source, c.target, ${col(costColumns.cost, 'cost_s')} AS cost, ${col(costColumns.reverse, 'reverse_cost_s')} AS reverse_cost
            FROM ${costColumns.table} c
            JOIN routing.edge h ON h.id = c.id
            WHERE c.geom && ST_MakeEnvelope(${minX}, ${minY}, ${maxX}, ${maxY}, 4326)
              ${ban ? `AND NOT ${inZoneSql('c.id')}` : ''}`;
}

async function shortestPath(from, to, bbox, penalties) {
    const { rows } = await net.query(
        `SELECT d.path_seq, d.node, d.edge, e.source, e.length_m
         FROM pgr_dijkstra($1, $2::bigint, $3::bigint, directed => true) d
         JOIN routing.edge e ON e.id = d.edge
         ORDER BY d.path_seq`,
        [edgesSql(bbox, penalties), from, to]);
    if (!rows.length) return null;
    return {
        edgeIds: rows.map(r => Number(r.edge)),
        edgeDirs: rows.map(r => (String(r.node) === String(r.source) ? 1 : -1)),
        lengths: rows.map(r => Number(r.length_m)),
    };
}

let speedProfileExists = null;
async function hasSpeedProfile() {
    if (speedProfileExists === null) {
        const { rows: [r] } = await net.query(`SELECT to_regclass('routing.edge_slot_speed') IS NOT NULL AS ok`);
        speedProfileExists = r.ok;
    }
    return speedProfileExists;
}

// Travel time, free-flow time, geometry and search cost of a path (per-slot
// times: slotTimes).
async function describePath(path) {
    const { rows: [summary] } = await net.query(`
        WITH p AS (
            SELECT * FROM unnest($1::bigint[], $2::smallint[]) WITH ORDINALITY AS t(edge_id, dir, seq)
        )
        SELECT ST_AsGeoJSON(ST_RemoveRepeatedPoints(ST_MakeLine(
                   CASE WHEN p.dir = 1 THEN e.geom ELSE ST_Reverse(e.geom) END ORDER BY p.seq))) AS geom,
               sum(e.length_m) AS length_m,
               sum(CASE WHEN p.dir = 1 THEN e.cost_s ELSE e.reverse_cost_s END) AS freeflow_s,
               sum(CASE WHEN p.dir = 1 THEN c.cost_s ELSE c.reverse_cost_s END) AS travel_s,
               sum(${searchCostSql('CASE WHEN p.dir = 1 THEN c.cost_s ELSE c.reverse_cost_s END',
                                   'CASE WHEN p.dir = 1 THEN e.cost_s ELSE e.reverse_cost_s END', 'e.highway', 'e.id')}) AS weighted_s,
               coalesce(sum(e.length_m) FILTER (WHERE NOT ${isMajorSql('e.highway')}), 0) AS local_m,
               ${AVOID_SQL ? `coalesce(sum(e.length_m) FILTER (WHERE ${inZoneSql('e.id')}), 0) / sum(e.length_m)` : '0'} AS zone_share,
               coalesce(sum(e.length_m) FILTER (WHERE ${isMajorSql('e.highway')}), 0) / sum(e.length_m) AS major_share
        FROM p
        JOIN routing.edge e ON e.id = p.edge_id
        JOIN ${costColumns.table} c ON c.id = p.edge_id`,
        [path.edgeIds, path.edgeDirs]);

    return summary;

}

// Travel time of a path for every departure slot. Only for routes that are
// kept: it is the expensive part, and a route rejected by the checks above
// used to pay for it anyway.
async function slotTimes(path) {
    let slots = [];
    if (await hasSpeedProfile()) {
        ({ rows: slots } = await net.query(`
            WITH p AS (
                SELECT * FROM unnest($1::bigint[], $2::smallint[]) AS t(edge_id, dir)
            ), slots AS (
                SELECT DISTINCT slot FROM routing.edge_speed_profile
            )
            -- Per-slot stop-inclusive speed (routing.edge_slot_speed, step 09) where the
            -- slot has enough history, else the edge's all-day cost.
            SELECT s.slot,
                   sum(CASE WHEN sp.speed_kmh IS NOT NULL
                            THEN e.length_m / (sp.speed_kmh / 3.6)
                            ELSE CASE WHEN p.dir = 1 THEN c.cost_s ELSE c.reverse_cost_s END END) AS travel_s,
                   coalesce(sum(e.length_m) FILTER (WHERE sp.speed_kmh IS NOT NULL), 0) / sum(e.length_m) AS observed_share
            FROM p
            CROSS JOIN slots s
            JOIN routing.edge e ON e.id = p.edge_id
            JOIN ${costColumns.table} c ON c.id = p.edge_id
            LEFT JOIN routing.edge_slot_speed sp
                   ON sp.edge_id = p.edge_id AND sp.dir = p.dir AND sp.slot = s.slot
            GROUP BY s.slot`,
            [path.edgeIds, path.edgeDirs]));
    }
    return slots;
}

// Geodesic length of the plans' current path, for the dry-run comparison.
function currentLengthM(od) {
    const coords = JSON.parse(od.current_path).coordinates || [];
    let m = 0;
    for (let i = 1; i < coords.length; i++) {
        const [lon1, lat1] = coords[i - 1];
        const [lon2, lat2] = coords[i];
        const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
        m += Math.hypot(x, lat2 - lat1) * 111320;
    }
    return m;
}

function overlapShare(path, kept) {
    const own = new Set(kept.edgeIds);
    let shared = 0;
    let total = 0;
    path.edgeIds.forEach((id, i) => {
        total += path.lengths[i];
        if (own.has(id)) shared += path.lengths[i];
    });
    return total ? shared / total : 1;
}

async function candidatesFor(od) {
    const pad = 0.03; // ~3 km
    const bbox = [
        Math.min(od.o_lon, od.d_lon) - pad, Math.min(od.o_lat, od.d_lat) - pad,
        Math.max(od.o_lon, od.d_lon) + pad, Math.max(od.o_lat, od.d_lat) + pad,
    ];
    const penalties = new Map();
    const kept = [];
    let fastest = null;

    for (let iter = 0; iter < args['max-iterations'] && kept.length < args.k; iter++) {
        const path = await shortestPath(od.origin_vertex, od.destination_vertex, bbox, penalties);
        if (!path) break;
        path.edgeIds.forEach(id => penalties.set(id, (penalties.get(id) || 0) + 1));

        const maxOverlap = kept.reduce((m, k) => Math.max(m, overlapShare(path, k)), 0);
        if (kept.length && maxOverlap > args['max-overlap']) continue;

        const described = await describePath(path);
        const travel = Number(described.travel_s);
        // The search keeps the preferred route out of the avoid zones and on
        // major roads; alternatives must not cross the zones (more than 200 m
        // inside) or use notably more local road, or the optimizer, which picks
        // by time, would take them.
        if (kept.length && Number(described.zone_share) * Number(described.length_m) > 200) continue;
        if (kept.length && Number(described.local_m) > Number(kept[0].local_m) + 300) continue;
        if (fastest === null) fastest = travel;
        else if (travel > fastest * (1 + args['max-detour'])) continue;

        kept.push({ ...path, ...described, slots: await slotTimes(path), maxOverlap });
    }
    // Ranked by the weighted (road-type preferring) cost, not by the order the
    // penalty search found them: rank 1 is the preferred route.
    return kept.sort((a, b) => a.weighted_s - b.weighted_s);
}

// ── Output ──────────────────────────────────────────────────────────────────

async function upsertOdPair(client, od) {
    const { rows: [row] } = await client.query(`
        INSERT INTO routing.od_pair (residence_id, entrance_id, origin, destination, straight_m,
                                     origin_vertex, destination_vertex, origin_snap_m, destination_snap_m)
        SELECT $1, $2, o, d, ST_Distance(o::geography, d::geography), $7, $8, $9, $10
        FROM (SELECT ST_SetSRID(ST_MakePoint($3, $4), 4326) AS o,
                     ST_SetSRID(ST_MakePoint($5, $6), 4326) AS d) pts
        ON CONFLICT (residence_id, entrance_id) DO UPDATE SET
            origin = EXCLUDED.origin, destination = EXCLUDED.destination,
            straight_m = EXCLUDED.straight_m,
            origin_vertex = EXCLUDED.origin_vertex, destination_vertex = EXCLUDED.destination_vertex,
            origin_snap_m = EXCLUDED.origin_snap_m, destination_snap_m = EXCLUDED.destination_snap_m,
            updated_at = now()
        RETURNING id`,
        [od.residence_id, od.entrance_id, od.o_lon, od.o_lat, od.d_lon, od.d_lat,
         od.origin_vertex, od.destination_vertex, od.origin_snap_m, od.destination_snap_m]);
    return row.id;
}

async function insertCandidate(client, runId, odPairId, rank, c) {
    const { rows: [row] } = await client.query(`
        INSERT INTO routing.route_candidate (run_id, od_pair_id, rank, source, geom, length_m,
                                             travel_s, freeflow_s, edge_ids, edge_dirs, max_overlap)
        VALUES ($1, $2, $3, $4, ST_SetSRID(ST_GeomFromGeoJSON($5), 4326), $6, $7, $8, $9, $10, $11)
        RETURNING id`,
        [runId, odPairId, rank, c.source, c.geom, c.length_m, c.travel_s ?? null, c.freeflow_s ?? null,
         c.edgeIds ?? null, c.edgeDirs ?? null, c.maxOverlap ?? null]);
    if (c.slots?.length) {
        await client.query(`
            INSERT INTO routing.route_candidate_slot (candidate_id, slot, travel_s, observed_share)
            SELECT $1, s, t, coalesce(o, 0) FROM unnest($2::timestamptz[], $3::float8[], $4::float8[]) AS u(s, t, o)`,
            [row.id, c.slots.map(s => s.slot), c.slots.map(s => s.travel_s), c.slots.map(s => s.observed_share)]);
    }
}

// List the edges touching the avoid zones (writes routing.avoid_edge in the
// network database, so it needs the write login there).
async function refreshAvoidEdges() {
    if (!AVOID_SQL) return;
    const w = new Pool({ ...common, database: process.env.ROUTING_PGDATABASE || 'your_db',
                         user: process.env.PGW_USER, password: process.env.PGW_PASSWORD });
    try {
        await w.query('CREATE TABLE IF NOT EXISTS routing.avoid_edge (edge_id bigint PRIMARY KEY)');
        await w.query('BEGIN');
        await w.query('TRUNCATE routing.avoid_edge');
        const { rowCount } = await w.query(`INSERT INTO routing.avoid_edge SELECT id FROM routing.edge WHERE ST_Intersects(geom, ${AVOID_SQL})`);
        await w.query('COMMIT');
        await w.query('GRANT SELECT ON routing.avoid_edge TO ro_user').catch(() => {});
        console.log(`avoid zones: ${rowCount} road segments listed in routing.avoid_edge`);
    } finally {
        await w.end();
    }
}

async function main() {
    await refreshAvoidEdges();
    const ods = await loadOdPairs();
    console.log(`${ods.length} residence → entrance pairs; cost basis: ${args.cost}`);

    const results = [];
    const skipped = [];
    for (const [i, od] of ods.entries()) {
        const [o, d] = await Promise.all([snap(od.o_lon, od.o_lat), snap(od.d_lon, od.d_lat)]);
        if (!o || !d || o.dist_m > args['max-snap'] || d.dist_m > args['max-snap']) {
            skipped.push({ od, reason: `snap ${Math.round(o?.dist_m)} / ${Math.round(d?.dist_m)} m` });
            continue;
        }
        Object.assign(od, {
            origin_vertex: o.id, destination_vertex: d.id,
            origin_snap_m: o.dist_m, destination_snap_m: d.dist_m,
        });
        const candidates = await candidatesFor(od);
        if (!candidates.length) skipped.push({ od, reason: 'no path' });
        results.push({ od, candidates });
        if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${ods.length}`);
    }

    const generated = results.reduce((n, r) => n + r.candidates.length, 0);
    const perPair = results.filter(r => r.candidates.length).map(r => r.candidates.length);
    console.log(`${generated} candidates for ${perPair.length} pairs ` +
                `(avg ${(generated / Math.max(1, perPair.length)).toFixed(1)}), ${skipped.length} skipped`);
    skipped.slice(0, 15).forEach(s => console.log(`  skipped ${s.od.residence_id} → ${s.od.entrance_id}: ${s.reason}`));
    if (args['dry-run'] && args['geojson-out']) {
        const features = results.flatMap(({ od, candidates }) => candidates.map((c, i) => ({
            type: 'Feature', geometry: JSON.parse(c.geom),
            properties: { residence_id: od.residence_id, entrance_id: od.entrance_id, rank: i + 1,
                          km: +(c.length_m / 1000).toFixed(1), min: +(c.travel_s / 60).toFixed(1),
                          major_share: +Number(c.major_share || 0).toFixed(2), local_m: Math.round(Number(c.local_m) || 0) },
        })));
        require('fs').writeFileSync(args['geojson-out'], JSON.stringify({ type: 'FeatureCollection', features }));
        console.log(`wrote ${features.length} candidates to ${args['geojson-out']}`);
    }
    if (args['dry-run']) {
        results.forEach(({ od, candidates }) => {
            const current = od.current_path ? `current ${(currentLengthM(od) / 1000).toFixed(1)} km` : 'no current path';
            console.log(`\n${od.residence_id} → ${od.entrance_id} (${current}, snap ${Math.round(od.origin_snap_m)}/${Math.round(od.destination_snap_m)} m)`);
            candidates.forEach((c, i) => console.log(
                `  #${i + 1}  ${(c.length_m / 1000).toFixed(1)} km  ${(c.travel_s / 60).toFixed(1)} min` +
                `  major roads ${Math.round((c.major_share || 0) * 100)}%` +
                `  in avoid zones ${Math.round((c.zone_share || 0) * 100)}%` +
                `  local roads ${Math.round(Number(c.local_m) || 0)} m` +
                `  overlap ${Math.round((c.maxOverlap || 0) * 100)}%  slots ${c.slots.length}`));
        });
        return;
    }

    const client = await out.connect();
    try {
        await client.query('BEGIN');
        const { rows: [run] } = await client.query(`
            INSERT INTO routing.generation_run (method, cost_basis, params)
            VALUES ('penalty_dijkstra', $1, $2) RETURNING id`, [args.cost, args]);
        for (const { od, candidates } of results) {
            const odPairId = await upsertOdPair(client, od);
            if (od.current_path) {
                const g = JSON.parse(od.current_path);
                if (g.type === 'LineString') {
                    await insertCandidate(client, run.id, odPairId, 0, {
                        source: 'current_plan', geom: od.current_path,
                        length_m: (await client.query(
                            `SELECT ST_Length(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography) AS m`,
                            [od.current_path])).rows[0].m,
                    });
                }
            }
            for (const [idx, c] of candidates.entries()) {
                await insertCandidate(client, run.id, odPairId, idx + 1, { source: 'penalty_dijkstra', ...c });
            }
        }
        await client.query(`
            UPDATE routing.generation_run SET od_count = $2, candidate_count = $3, finished_at = clock_timestamp()
            WHERE id = $1`, [run.id, perPair.length, generated]);
        await client.query('COMMIT');
        console.log(`Saved as generation run ${run.id}`);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

main()
    .catch(err => { console.error(err); process.exitCode = 1; })
    .finally(() => Promise.all([net.end(), out.end()]));
