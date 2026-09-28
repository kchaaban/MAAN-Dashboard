-- Step 8: stop-inclusive travel times per edge, direction and 15-min slot.
-- Database: your_db.  Run as: postgres, on the VM (full scan).  Requires 02b.
--
-- The back-test (07/07b) showed the speed profiles of 02b match the time buses
-- spend moving but miss the time they stand in queues: 02a left stationary
-- fixes out, so a jam looked like slow-but-moving traffic. Here every pair of
-- consecutive fixes of a bus (≤ 2 min apart) adds its time and distance to the
-- edge the bus is on; the effective speed of an edge in a slot is then total
-- distance / total time — standing time included.
--
-- A moving fix gets its edge from the (cell, heading) matches of 02b. A
-- stopped fix (≤ 3 km/h) has no reliable heading, so it stays on the edge the
-- bus was last matched to. Standing still for more than 10 minutes is parking
-- or loading, not traffic, and is left out; so are moving fixes off the matched
-- network (parking lots, camps).
--
-- Runs in 6-hour chunks to keep the window sorts within temp_file_limit; a bus
-- crossing a chunk boundary loses at most one pair there.

SET work_mem = '512MB';
SET temp_file_limit = '12GB';
SET statement_timeout = 0;

-- The views of step 09 read these tables; 09 recreates them afterwards.
DROP VIEW  IF EXISTS routing.edge_slot_speed;
DROP VIEW  IF EXISTS routing.edge_cost;
DROP TABLE IF EXISTS routing.edge_speed_static_v2;
DROP TABLE IF EXISTS routing.edge_speed_profile_v2;
DROP TABLE IF EXISTS routing.edge_time_obs;

CREATE UNLOGGED TABLE routing.edge_time_obs (
    edge_id  bigint      NOT NULL,
    dir      smallint    NOT NULL,
    slot     timestamptz NOT NULL,
    time_s   double precision NOT NULL,
    dist_m   double precision NOT NULL,
    stop_s   double precision NOT NULL,
    pairs    int         NOT NULL
);

SELECT format($q$
    INSERT INTO routing.edge_time_obs
    WITH p AS (
        SELECT h.bus_id, h.dt_timestamptz AS ts, h.speed, h.geom, gc.edge_id, gc.dir
        FROM public.hajj_days_2 h
        LEFT JOIN routing.gps_cell gc
               ON h.speed > 3 AND h.angle >= 0
              AND gc.cx = round(ST_X(ST_SnapToGrid(h.geom, 0.0002)) * 5000)::int
              AND gc.cy = round(ST_Y(ST_SnapToGrid(h.geom, 0.0002)) * 5000)::int
              AND gc.sector = (floor(h.angle / 45)::int %% 8)
        WHERE h.dt_timestamptz >= %L AND h.dt_timestamptz < %L
          AND h.geom && ST_MakeEnvelope(39.6, 21.2, 40.2, 21.7, 4326)
    ), s AS (
        SELECT *, speed <= 3 AS stopped,
               lag(speed <= 3) OVER w AS prev_stopped,
               count(edge_id) OVER w AS grp,
               lead(ts) OVER w AS next_ts,
               lead(geom) OVER w AS next_geom
        FROM p WINDOW w AS (PARTITION BY bus_id ORDER BY ts)
    ), f AS (
        SELECT *,
               first_value(edge_id) OVER (PARTITION BY bus_id, grp ORDER BY ts) AS edge_ff,
               first_value(dir)     OVER (PARTITION BY bus_id, grp ORDER BY ts) AS dir_ff,
               sum(CASE WHEN stopped IS DISTINCT FROM prev_stopped THEN 1 ELSE 0 END)
                   OVER (PARTITION BY bus_id ORDER BY ts) AS run
        FROM s
    ), g AS (
        SELECT *,
               CASE WHEN stopped THEN extract(epoch FROM max(ts) OVER r - min(ts) OVER r) END AS stop_run_s
        FROM f WINDOW r AS (PARTITION BY bus_id, run)
    )
    SELECT edge_ff, dir_ff,
           date_bin('15 minutes', ts, TIMESTAMPTZ '2025-06-01 00:00+03'),
           sum(extract(epoch FROM next_ts - ts)),
           sum(ST_Distance(geom::geography, next_geom::geography)),
           coalesce(sum(extract(epoch FROM next_ts - ts)) FILTER (WHERE stopped), 0),
           count(*)
    FROM g
    WHERE edge_ff IS NOT NULL
      AND next_ts - ts <= interval '2 minutes'
      AND (edge_id IS NOT NULL OR stopped)            -- moving fixes must be on the matched network
      AND (NOT stopped OR stop_run_s <= 600)          -- > 10 min standing = parking / loading
    GROUP BY 1, 2, 3
$q$, t, t + interval '6 hours')
FROM generate_series(TIMESTAMPTZ '2025-06-03 00:00+03', TIMESTAMPTZ '2025-06-06 18:00+03', interval '6 hours') AS t
\gexec

-- Per edge, direction and slot: effective (space-mean) speed, standing time included.
CREATE TABLE routing.edge_speed_profile_v2 AS
SELECT edge_id, dir, slot,
       sum(time_s) AS time_s, sum(dist_m) AS dist_m, sum(stop_s) AS stop_s, sum(pairs) AS pairs,
       sum(dist_m) / nullif(sum(time_s), 0) * 3.6 AS speed_kmh,
       sum(stop_s) / nullif(sum(time_s), 0) AS stop_share
FROM routing.edge_time_obs
GROUP BY 1, 2, 3;
ALTER TABLE routing.edge_speed_profile_v2 ADD PRIMARY KEY (edge_id, dir, slot);

CREATE TABLE routing.edge_speed_static_v2 AS
SELECT edge_id, dir, sum(time_s) AS time_s, sum(dist_m) AS dist_m,
       sum(dist_m) / nullif(sum(time_s), 0) * 3.6 AS speed_kmh,
       sum(stop_s) / nullif(sum(time_s), 0) AS stop_share
FROM routing.edge_speed_profile_v2
GROUP BY 1, 2;
ALTER TABLE routing.edge_speed_static_v2 ADD PRIMARY KEY (edge_id, dir);

GRANT SELECT ON routing.edge_speed_profile_v2, routing.edge_speed_static_v2 TO ro_user;

-- Old (moving only) vs new (standing included) speed, main roads, busy slots.
SELECT e.highway,
       round((sum(o.speed_kmh * o.n_points) / sum(o.n_points))::numeric, 1) AS moving_only_kmh,
       round((sum(v.dist_m) / sum(v.time_s) * 3.6)::numeric, 1)            AS with_standing_kmh,
       round((sum(v.stop_s) / sum(v.time_s))::numeric, 2)                  AS standing_share
FROM routing.edge_speed_profile_v2 v
JOIN routing.edge_speed_profile o USING (edge_id, dir, slot)
JOIN routing.edge e ON e.id = v.edge_id
WHERE e.highway IN ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential')
  AND v.time_s >= 300
GROUP BY 1 ORDER BY 2 DESC;
