// Shared geometry checking for every write path: the single-record form and the
// bulk CSV import both go through here, so a shape saved one way can never be
// one the other would have refused.
//
// Lives in its own module because writes.js and entity-io.js both need it and
// already require each other — importing it from either would be a cycle.

// Every geometry column in this schema is SRID 4326, 2D. Five tables declare
// MULTIPOLYGON, paths declares LINESTRING, camps is untyped GEOMETRY — and a
// typed column rejects the wrong geometry type outright, so the import has to
// coerce rather than hand Postgres something it will refuse.
const GEOMETRY_TARGETS = {
    camps: { type: 'GEOMETRY', family: 'areal' },
    paths: { type: 'LINESTRING', family: 'linear' },
    entrances: { type: 'MULTIPOLYGON', family: 'areal' },
    parking: { type: 'MULTIPOLYGON', family: 'areal' },
    bus_stops: { type: 'MULTIPOLYGON', family: 'areal' },
    bus_warehouses: { type: 'MULTIPOLYGON', family: 'areal' },
    drop_off_areas: { type: 'MULTIPOLYGON', family: 'areal' },
};

const FAMILY_TYPES = {
    areal: ['POLYGON', 'MULTIPOLYGON'],
    linear: ['LINESTRING', 'MULTILINESTRING'],
};

function detectGeometryFormat(text) {
    const trimmed = String(text).trim();
    if (trimmed.startsWith('{')) return 'geojson';
    if (/^SRID\s*=/i.test(trimmed)) return 'ewkt';
    return 'wkt';
}

// PostGIS raises on malformed input rather than returning null, so each shape is
// parsed inside a savepoint: one bad cell is reported against its row instead of
// aborting the whole import.
async function checkGeometry(client, resource, text) {
    const target = GEOMETRY_TARGETS[resource];
    if (!target) return { error: 'this entity has no geometry column' };

    const format = detectGeometryFormat(text);
    const parse = format === 'geojson'
        ? 'ST_GeomFromGeoJSON($1)'
        : (format === 'ewkt' ? 'ST_GeomFromEWKT($1)' : 'ST_GeomFromText($1)');

    await client.query('SAVEPOINT geom');
    try {
        const { rows } = await client.query(
            `WITH raw AS (SELECT ${parse} AS g),
                  fixed AS (
                      SELECT ST_Force2D(
                                 CASE WHEN ST_SRID(g) = 0 THEN ST_SetSRID(g, 4326)
                                      WHEN ST_SRID(g) <> 4326 THEN ST_Transform(g, 4326)
                                      ELSE g END) AS g
                      FROM raw
                  )
             SELECT GeometryType(g) AS gtype,
                    ST_IsValid(g) AS valid,
                    ST_IsValidReason(g) AS reason,
                    ST_AsEWKT(CASE WHEN $2 = 'MULTIPOLYGON' AND GeometryType(g) = 'POLYGON'
                                        THEN ST_Multi(g)
                                   WHEN $2 = 'LINESTRING' AND GeometryType(g) = 'MULTILINESTRING'
                                        THEN ST_LineMerge(g)
                                   ELSE g END) AS ewkt,
                    GeometryType(CASE WHEN $2 = 'MULTIPOLYGON' AND GeometryType(g) = 'POLYGON'
                                           THEN ST_Multi(g)
                                      WHEN $2 = 'LINESTRING' AND GeometryType(g) = 'MULTILINESTRING'
                                           THEN ST_LineMerge(g)
                                      ELSE g END) AS coerced
             FROM fixed`,
            [String(text).trim(), target.type]
        );
        await client.query('RELEASE SAVEPOINT geom');

        const row = rows[0];
        if (!row || !row.gtype) return { error: `could not read the ${format} geometry` };
        if (!FAMILY_TYPES[target.family].includes(row.gtype)) {
            return {
                error: `${row.gtype} does not belong in ${resource}, which stores `
                    + `${FAMILY_TYPES[target.family].join(' or ')}`,
            };
        }
        if (!row.valid) return { error: `invalid geometry: ${row.reason}` };
        if (target.type !== 'GEOMETRY' && row.coerced !== target.type) {
            return { error: `${row.gtype} cannot be stored as ${target.type}` };
        }
        return { ewkt: row.ewkt, gtype: row.coerced };
    } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT geom');
        await client.query('RELEASE SAVEPOINT geom');
        return { error: `${format} parse failed: ${err.message.split('\n')[0]}` };
    }
}


module.exports = { checkGeometry, detectGeometryFormat, GEOMETRY_TARGETS, FAMILY_TYPES };
