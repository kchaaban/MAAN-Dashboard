-- Step 6: buses entering each Mashaer entrance in Hajj 1446, for estimating
-- entrance capacity (scripts/estimate-entrance-capacity.js).
-- Database: your_db.  Run as: postgres, on the VM (long scan; see README).
-- Requires routing.entrance_zone, written by
--   node scripts/estimate-entrance-capacity.js --step prepare
--
-- An entry is a bus reaching an entrance polygon: a fix inside it, or the line
-- between two fixes ≤ 2 min apart crossing it. Buses report every ~9 s, so at
-- speed a bus can cross a 60 m polygon between two fixes; the line test counts it.
-- A visit is a bus's consecutive fixes in the 400 m approach zone (gaps ≤ 10 min);
-- approach_s is how long the visit lasted before the bus got in — long when
-- buses queue at the gate, which is what marks a slot as saturated.
--
-- Two passes. Per day, fixes in the approach zones are reduced to narrow rows
-- (bus, zone, time, speed, inside, reached), the crossing test done while the
-- geometries are at hand. Around Mina the zones hold millions of fixes of parked
-- and queueing buses; carrying their geometries (and the zone polygon) through
-- the grouping made one day run for over 40 minutes. Visits and entries are
-- then built once from the narrow rows, in 06b_entrance_entries.sql, which
-- also keeps only gate entries (buses that slowed at the gate) and can be
-- rerun alone while routing.entrance_pts is there.

SET work_mem = '512MB';
SET temp_file_limit = '8GB';
SET statement_timeout = 0;

DROP TABLE IF EXISTS routing.entrance_flow_slot;
DROP TABLE IF EXISTS routing.entrance_entry;
DROP TABLE IF EXISTS routing.entrance_pts;

CREATE UNLOGGED TABLE routing.entrance_pts (
    bus_id   int         NOT NULL,
    zone_id  text        NOT NULL,
    ts       timestamptz NOT NULL,
    speed    smallint,
    inside   boolean     NOT NULL,
    reached  boolean     NOT NULL
);

-- ── Pass 1, per day: fixes in the approach zones, crossing test included ──
SELECT format($q$
    INSERT INTO routing.entrance_pts
    WITH pts AS (
        SELECT h.bus_id, h.dt_timestamptz AS ts, h.geom, h.speed, z.zone_id,
               ST_Intersects(z.geom, h.geom) AS inside
        FROM public.hajj_days_2 h
        JOIN routing.entrance_zone z ON z.approach && h.geom AND ST_Intersects(z.approach, h.geom)
        WHERE h.dt_timestamptz >= %L AND h.dt_timestamptz < %L
          AND h.geom && (SELECT ST_Extent(approach) FROM routing.entrance_zone)
    ), s AS (
        SELECT bus_id, zone_id, ts, speed, inside, geom,
               lag(ts) OVER w AS prev_ts, lag(geom) OVER w AS prev_geom, lag(inside) OVER w AS prev_inside
        FROM pts WINDOW w AS (PARTITION BY bus_id, zone_id ORDER BY ts)
    )
    -- A bus's first fix has no previous one, so the crossing test is NULL there: false.
    SELECT s.bus_id, s.zone_id, s.ts, s.speed, s.inside,
           s.inside OR coalesce(NOT s.prev_inside AND s.ts - s.prev_ts <= interval '2 minutes'
                                AND ST_Intersects(ST_MakeLine(s.prev_geom, s.geom), z.geom), false)
    FROM s JOIN routing.entrance_zone z USING (zone_id)
$q$, day, day + interval '1 day')
FROM generate_series(TIMESTAMPTZ '2025-06-03 00:00+03', TIMESTAMPTZ '2025-06-06 00:00+03', interval '1 day') AS day
\gexec

CREATE INDEX entrance_pts_idx ON routing.entrance_pts (zone_id, bus_id, ts);
ANALYZE routing.entrance_pts;

-- ── Pass 2: visits and gate entries from the narrow rows ──────────────────
\ir 06b_entrance_entries.sql
