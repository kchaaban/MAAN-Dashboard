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
-- then built once from the narrow rows.

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

-- ── Pass 2: visits and entries from the narrow rows ───────────────────────
CREATE TABLE routing.entrance_entry AS
WITH seq AS (
    SELECT *, lag(ts) OVER w AS prev_ts
    FROM routing.entrance_pts WINDOW w AS (PARTITION BY zone_id, bus_id ORDER BY ts)
), visits AS (
    SELECT *, sum(CASE WHEN prev_ts IS NULL OR ts - prev_ts > interval '10 minutes' THEN 1 ELSE 0 END)
                  OVER (PARTITION BY zone_id, bus_id ORDER BY ts) AS visit
    FROM seq
), per_visit AS (
    SELECT zone_id, bus_id, visit,
           min(ts) AS visit_start,
           min(ts) FILTER (WHERE reached) AS entry_ts,
           (array_agg(inside ORDER BY ts))[1] AS started_inside
    FROM visits GROUP BY 1, 2, 3
)
SELECT v.zone_id, v.bus_id, v.entry_ts,
       CASE WHEN v.started_inside THEN NULL ELSE extract(epoch FROM v.entry_ts - v.visit_start) END AS approach_s,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY p.speed) FILTER (WHERE p.ts < v.entry_ts) AS approach_kmh
FROM per_visit v
JOIN visits p ON p.zone_id = v.zone_id AND p.bus_id = v.bus_id AND p.visit = v.visit
WHERE v.entry_ts IS NOT NULL
GROUP BY v.zone_id, v.bus_id, v.visit, v.entry_ts, v.started_inside, v.visit_start;

-- Per entrance and 15-min slot: entries, and how long approaching buses took.
CREATE TABLE routing.entrance_flow_slot AS
SELECT zone_id,
       date_bin('15 minutes', entry_ts, TIMESTAMPTZ '2025-06-01 00:00+03') AS slot,
       count(*)                                                           AS entries,
       count(DISTINCT bus_id)                                             AS buses,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY approach_s)            AS approach_s_median,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY approach_kmh)          AS approach_kmh_median,
       count(approach_s)                                                  AS with_approach
FROM routing.entrance_entry
GROUP BY 1, 2;

ALTER TABLE routing.entrance_flow_slot ADD PRIMARY KEY (zone_id, slot);
GRANT SELECT ON routing.entrance_pts, routing.entrance_entry, routing.entrance_flow_slot TO ro_user;

SELECT zone_id, sum(entries) AS entries, max(entries) AS peak_15min, count(*) AS active_slots
FROM routing.entrance_flow_slot GROUP BY 1 ORDER BY 2 DESC;
