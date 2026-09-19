require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const zlib = require('zlib');
const { promisify } = require('util');
const { Pool } = require('pg');

const gzip = promisify(zlib.gzip);

const pool = new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT) || 5431,
    database: process.env.PGDATABASE || 'transport',
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 120000,
});

pool.on('error', (err) => console.error('[db] idle client error:', err.message));

// A second pool for the edit endpoints. Kept deliberately separate and small so
// that read traffic — the overwhelming majority — can never issue a write, and
// so a runaway write path cannot starve the read pool.
const writePool = new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT) || 5431,
    database: process.env.PGDATABASE || 'transport',
    user: process.env.PGW_USER,
    password: process.env.PGW_PASSWORD,
    max: 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
});

writePool.on('error', (err) => console.error('[db:write] idle client error:', err.message));

// A scope is {kind: 'all' | 'company' | 'center' | 'none', id?}. It always comes
// from the signed token, never from the request, so `id` is never user input.
function scopeKey(scope) {
    return scope.kind === 'company' || scope.kind === 'center'
        ? `${scope.kind}:${scope.id}`
        : scope.kind;
}

// Builds the WHERE fragment for a dataset given which columns carry the company
// and centre for that query. 'none' deliberately matches nothing.
function scopeClause(scope, columns) {
    if (scope.kind === 'all') return { where: 'TRUE', values: [] };
    if (scope.kind === 'company') return { where: `${columns.company} = $1`, values: [scope.id] };
    if (scope.kind === 'center') return { where: `${columns.center} = $1`, values: [scope.id] };
    return { where: 'FALSE', values: [] };
}

// Mirrors simulation_data_view, plus the six assignment columns the dashboard's
// CSV contract expects (camp_assign_id, residence_assign_id, license_number,
// residence_haj, tarwia, direct_taseed) which the view itself does not expose.
const plansSql = (where) => `
WITH routing_points AS (
    SELECT r.id,
           ST_Transform(ST_Buffer(ST_Transform(ST_SetSRID(ST_MakePoint(r.longitude, r.latitude), 4326), 32637), 30::double precision), 4326) AS geom,
           r.name, 'residence'::text AS source, r.area AS district
    FROM residences r
    UNION ALL SELECT bs.id, bs.gis, bs.name, 'bus_stop'::text, NULL::character varying FROM bus_stops bs
    UNION ALL SELECT doa.id, doa.gis, doa.name, 'dropoff'::text, NULL::character varying FROM drop_off_areas doa
    UNION ALL SELECT c.id, c.gis, c.name, 'camp'::text, NULL::character varying FROM camps c
), parking AS (
    SELECT bw.id, bw.name, bw.gis AS geom FROM bus_warehouses bw
    UNION ALL SELECT p.id, p.name, p.gis FROM public.parking p
), residence_assign AS (
    -- One residence assignment per service centre. Without this collapse the join
    -- fans the intermediate out to ~85k rows and the geometry work runs 7.7x over.
    SELECT DISTINCT ON (ac.service_center_id)
           ac.service_center_id, ac.id, ac.haj_count, ac.tarwia, ac.direct_taseed,
           r.license_number
    FROM assign_camps ac
    LEFT JOIN residences r ON ac.residence_id = r.id
    ORDER BY ac.service_center_id, ac.id
), plan AS (
    SELECT psv.id AS plan_id,
        ad.id AS camp_assign_id,
        ra.id AS residence_assign_id,
        c.name AS camp_label,
        ad.haj_count AS allocated_haj,
        psv.number_of_buses, psv.number_of_haj, psv.number_of_late_haj, psv.number_of_early_haj,
        ra.license_number,
        ra.haj_count AS residence_haj, ra.tarwia, ra.direct_taseed,
        psv.get_type_parking, getp.name AS get_parking_name, ST_AsText(getp.geom) AS get_parking_geom,
        psv.set_type_parking, setp.name AS set_parking_name, ST_AsText(setp.geom) AS set_parking_geom,
        psv.entrance_asm_code, psv.entrance_name,
        ST_AsText(ST_SetSRID(ST_MakePoint(psv.entrance_longitude, psv.entrance_latitude), 4326)) AS entrance_point_geom,
        ST_AsText(ST_GeometryN(ST_GeomFromGeoJSON(psv.entrance_gis::text), 1)) AS entrance_polygon,
        psv.start_point_type, sp.name AS start_point_name, sp.district AS start_point_district,
        ST_AsText(ST_StartPoint(ST_GeomFromGeoJSON(psv.path_gis::text))) AS start_point_geom,
        ST_AsText(sp.geom) AS start_geom,
        psv.end_point_type, ep.name AS end_point_name,
        ST_AsText(ST_EndPoint(ST_GeomFromGeoJSON(psv.path_gis::text))) AS end_point_geom,
        ST_AsText(ep.geom) AS end_geom,
        ST_AsText(ST_GeomFromGeoJSON(psv.path_gis::text)) AS path_geom,
        psv.path_name,
        ST_AsText(ST_GeomFromGeoJSON(psv.path_relation_gis::text)) AS internal_path,
        psv.owner_company_name, psv.owner_office_number, p.name AS period,
        psv.timing_start_at, psv.timing_start_at_hijri, psv.timing_end_at, psv.timing_end_at_hijri,
        psv.plan_type_name, psv.plan_type_code, psv.transport_type_name,
        psv.updated_at
    FROM plan_show_view psv
    LEFT JOIN routing_points sp ON psv.start_point_id = sp.id
    LEFT JOIN routing_points ep ON psv.end_point_id = ep.id
    LEFT JOIN parking getp ON psv.get_parking_id = getp.id
    LEFT JOIN parking setp ON psv.set_parking_id = setp.id
    LEFT JOIN assign_data ad ON psv.owner_service_center_id = ad.service_center_id
    LEFT JOIN camps c ON ad.camp_id = c.id
    LEFT JOIN residence_assign ra ON psv.owner_service_center_id = ra.service_center_id
    LEFT JOIN periods p ON psv.timing_period_id = p.id
    WHERE ${where}
)
SELECT DISTINCT ON (plan_id, camp_label)
    plan_id, camp_assign_id, residence_assign_id, camp_label, allocated_haj,
    number_of_buses, number_of_haj, number_of_late_haj, number_of_early_haj,
    license_number, residence_haj, tarwia, direct_taseed,
    get_type_parking, get_parking_name, get_parking_geom,
    set_type_parking, set_parking_name, set_parking_geom,
    entrance_asm_code, entrance_name, entrance_point_geom, entrance_polygon,
    start_point_type, start_point_name, start_point_district, start_point_geom, start_geom,
    end_point_type, end_point_name, end_point_geom, end_geom,
    path_geom, path_name, internal_path,
    owner_company_name, owner_office_number, period,
    timing_start_at, timing_start_at_hijri, timing_end_at, timing_end_at_hijri,
    plan_type_name, plan_type_code, transport_type_name
FROM plan
ORDER BY plan_id, camp_label, updated_at DESC`;

const assignCampsSql = (where) => `
SELECT c.name        AS camp_label,
       comp.name     AS service_company_name,
       sc.office_number,
       co.name_ar    AS nationality,
       sc.center_name AS service_center_name,
       ad.piligrim_type,
       tt.name       AS "transport_mode ",
       pl.name       AS platform_name,
       ad.haj_count  AS number_of_piligrim
FROM assign_data ad
LEFT JOIN camps c            ON ad.camp_id = c.id
LEFT JOIN service_centers sc ON ad.service_center_id = sc.id
LEFT JOIN companies comp     ON sc.company_id = comp.id
LEFT JOIN countries co       ON ad.country_id = co.id
LEFT JOIN transport_types tt ON ad.transport_type_id = tt.id
LEFT JOIN platforms pl       ON c.platform_id = pl.id
WHERE ${where}
ORDER BY c.name, comp.name`;

const assignResidencesSql = (where) => `
SELECT r.license_number  AS "License Number",
       r.name            AS "Name",
       ac.haj_count      AS "Pilgrims_count",
       comp.name         AS "Service_company",
       sc.center_name    AS "Service_center_name",
       sc.office_number  AS "Service_center_number",
       ac.tarwia         AS "Tarwiyah_count",
       ac.direct_taseed  AS "Taseed_count"
FROM assign_camps ac
LEFT JOIN residences r       ON ac.residence_id = r.id
LEFT JOIN service_centers sc ON ac.service_center_id = sc.id
LEFT JOIN companies comp     ON sc.company_id = comp.id
WHERE ${where}
ORDER BY r.license_number`;

// camps.gate_lat/gate_lon mixes three conventions: correct WGS84 (696 rows),
// lat/lon transposed (166), and EPSG:3857 easting/northing (471). Normalize all
// three, falling back to the camp polygon centroid if a row matches none.
const campsGatesSql = (where) => `
WITH normalized AS (
    SELECT c.*,
        CASE
            WHEN c.gate_lat > 1000 OR c.gate_lon > 1000
                THEN ST_Transform(ST_SetSRID(ST_MakePoint(c.gate_lat, c.gate_lon), 3857), 4326)
            WHEN c.gate_lat BETWEEN 39 AND 41 AND c.gate_lon BETWEEN 21 AND 22
                THEN ST_SetSRID(ST_MakePoint(c.gate_lat, c.gate_lon), 4326)
            WHEN c.gate_lat BETWEEN 21 AND 22 AND c.gate_lon BETWEEN 39 AND 41
                THEN ST_SetSRID(ST_MakePoint(c.gate_lon, c.gate_lat), 4326)
            ELSE ST_Centroid(c.gis)
        END AS gate_point
    FROM camps c
)
SELECT n.name                       AS camp_label,
       n.gate                       AS gate_number,
       n.type,
       tt.name                      AS transport_mode,
       n.capacity,
       CASE pl.code WHEN 'arafat' THEN 'ARF' WHEN 'mina' THEN 'MIN'
                    WHEN 'muzdalifa' THEN 'MUZ' ELSE pl.code END AS source,
       ST_Y(n.gate_point)           AS latitude,
       ST_X(n.gate_point)           AS longitude
FROM normalized n
LEFT JOIN platforms pl       ON n.platform_id = pl.id
LEFT JOIN transport_types tt ON n.transport_type_id = tt.id
WHERE n.gate_point IS NOT NULL AND ${where}
ORDER BY n.name`;

// A camp belongs to a scope if it is assigned to one of that scope's centres.
const campScopeExists = (inner) => `EXISTS (
    SELECT 1 FROM assign_data ad
    JOIN service_centers sc ON ad.service_center_id = sc.id
    WHERE ad.camp_id = n.id AND ${inner}
)`;

const DATASETS = {
    plans: {
        format: 'csv',
        contentType: 'text/csv; charset=utf-8',
        build: (scope) => {
            const { where, values } = scopeClause(scope, {
                company: 'psv.owner_company_id',
                center: 'psv.owner_service_center_id',
            });
            return { text: plansSql(where), values };
        },
    },
    'assign-camps': {
        format: 'csv',
        contentType: 'text/csv; charset=utf-8',
        build: (scope) => {
            const { where, values } = scopeClause(scope, {
                company: 'sc.company_id',
                center: 'ad.service_center_id',
            });
            return { text: assignCampsSql(where), values };
        },
    },
    'assign-residences': {
        format: 'csv',
        contentType: 'text/csv; charset=utf-8',
        build: (scope) => {
            const { where, values } = scopeClause(scope, {
                company: 'sc.company_id',
                center: 'ac.service_center_id',
            });
            return { text: assignResidencesSql(where), values };
        },
    },
    'camps-gates': {
        format: 'json',
        contentType: 'application/json; charset=utf-8',
        build: (scope) => {
            if (scope.kind === 'all') return { text: campsGatesSql('TRUE'), values: [] };
            if (scope.kind === 'none') return { text: campsGatesSql('FALSE'), values: [] };
            const column = scope.kind === 'company' ? 'sc.company_id' : 'ad.service_center_id';
            return { text: campsGatesSql(campScopeExists(`${column} = $1`)), values: [scope.id] };
        },
    },
};

function csvCell(value) {
    if (value === null || value === undefined) return '';
    const text = value instanceof Date ? value.toISOString() : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(result) {
    const columns = result.fields.map((f) => f.name);
    const lines = [columns.map(csvCell).join(',')];
    for (const row of result.rows) {
        lines.push(columns.map((col) => csvCell(row[col])).join(','));
    }
    return lines.join('\n');
}

const TTL_MS = (Number(process.env.DATA_CACHE_TTL) || 300) * 1000;
const MAX_CACHE_ENTRIES = Number(process.env.DATA_CACHE_MAX_ENTRIES) || 200;
const cache = new Map();
const inFlight = new Map();

async function build(name, scope) {
    const spec = DATASETS[name];
    const { text, values } = spec.build(scope);
    const startedAt = Date.now();
    const result = await pool.query(text, values);
    const body = spec.format === 'csv' ? toCsv(result) : JSON.stringify(result.rows);
    const gzipped = await gzip(body, { level: 6 });
    console.log(
        `[db] ${name} [${scopeKey(scope)}]: ${result.rowCount} rows, ` +
        `${(Buffer.byteLength(body) / 1048576).toFixed(1)}MB -> ${(gzipped.length / 1048576).toFixed(1)}MB gz ` +
        `in ${Date.now() - startedAt}ms`
    );
    return { gzipped, rowCount: result.rowCount, builtAt: Date.now(), contentType: spec.contentType };
}

// Oldest-first eviction. The 'all' scope is the expensive one to rebuild, so it
// is kept even when the cache is full.
function evictIfNeeded() {
    while (cache.size > MAX_CACHE_ENTRIES) {
        let oldestKey = null;
        let oldestAt = Infinity;
        for (const [key, entry] of cache) {
            if (key.endsWith(':all')) continue;
            if (entry.builtAt < oldestAt) {
                oldestAt = entry.builtAt;
                oldestKey = key;
            }
        }
        if (!oldestKey) break;
        cache.delete(oldestKey);
    }
}

function refresh(key, name, scope) {
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = build(name, scope)
        .then((entry) => {
            cache.set(key, entry);
            evictIfNeeded();
            return entry;
        })
        .finally(() => inFlight.delete(key));

    inFlight.set(key, promise);
    return promise;
}

async function getDataset(name, scope = { kind: 'all' }) {
    if (!DATASETS[name]) throw Object.assign(new Error(`Unknown dataset: ${name}`), { status: 404 });

    const key = `${name}:${scopeKey(scope)}`;
    const hit = cache.get(key);
    if (!hit) return refresh(key, name, scope);

    // Stale entries are served immediately while a rebuild runs behind them, so a
    // request that lands after the TTL never waits on the query.
    if (TTL_MS !== 0 && Date.now() - hit.builtAt >= TTL_MS) {
        refresh(key, name, scope).catch((err) =>
            console.error(`[db] background refresh of ${key} failed:`, err.message));
    }
    return hit;
}

function invalidate(name) {
    if (!name) return cache.clear();
    for (const key of cache.keys()) {
        if (key.startsWith(`${name}:`)) cache.delete(key);
    }
}

module.exports = { pool, writePool, getDataset, invalidate, DATASETS, scopeKey };
