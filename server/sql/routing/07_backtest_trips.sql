-- Step 7: real Hajj 1446 bus trips from Makkah to the Mashaer entrances, to
-- back-test the travel-time model (scripts/backtest-travel-times.js).
-- Database: your_db.  Run as: postgres, on the VM.  Requires 06_entrance_flow.sql.
--
-- A trip ends when a bus enters a Mina or Arafat entrance (routing.entrance_entry)
-- in the windows the 1447 plans use — Mina 7th 20:00 – 8th 10:00 (tarwia),
-- Arafat 8th 20:00 – 9th 10:00 (direct taseed), a little past each window for
-- travel — and starts when the bus leaves its last stop of 10+ minutes within
-- 8 km of the Haram in the 3 hours before: loading at a residence. Shuttle
-- entrances (ترددي) are left out: their buses loop between Mashaer stations.
-- A deterministic sample keeps the history lookups small.

SET work_mem = '256MB';
SET statement_timeout = 0;

DROP TABLE IF EXISTS routing.backtest_trip;

CREATE TABLE routing.backtest_trip AS
WITH e AS (
    SELECT ee.zone_id, ee.bus_id, ee.entry_ts
    FROM routing.entrance_entry ee
    WHERE ee.zone_id NOT IN ('ASMARF7', 'ASMARF8', 'ASMARF9', 'ASMMIN12', 'ASMMIN13+ASMMIN14')
      AND ((ee.zone_id LIKE 'ASMMIN%' AND ee.entry_ts >= '2025-06-03 20:00+03' AND ee.entry_ts < '2025-06-04 10:00+03')
        OR (ee.zone_id LIKE 'ASMARF%' AND ee.entry_ts >= '2025-06-04 20:00+03' AND ee.entry_ts < '2025-06-05 10:00+03'))
    ORDER BY md5(ee.bus_id::text || ee.entry_ts::text)
    LIMIT 6000
), pts AS (
    SELECT e.zone_id, e.bus_id, e.entry_ts, h.dt_timestamptz AS ts, h.speed, h.geom
    FROM e
    JOIN public.hajj_days_2 h
      ON h.bus_id = e.bus_id
     AND h.dt_timestamptz >= e.entry_ts - interval '3 hours'
     AND h.dt_timestamptz <= e.entry_ts
), prev AS (
    SELECT *, speed <= 3 AS stopped, lag(speed <= 3) OVER w AS prev_stopped
    FROM pts WINDOW w AS (PARTITION BY zone_id, bus_id, entry_ts ORDER BY ts)
), flagged AS (
    SELECT *, sum(CASE WHEN stopped IS DISTINCT FROM prev_stopped THEN 1 ELSE 0 END)
                  OVER (PARTITION BY zone_id, bus_id, entry_ts ORDER BY ts) AS run
    FROM prev
), runs AS (
    SELECT zone_id, bus_id, entry_ts, run, bool_and(stopped) AS stopped,
           min(ts) AS t0, max(ts) AS t1, ST_Centroid(ST_Collect(geom)) AS g
    FROM flagged GROUP BY 1, 2, 3, 4
), last_stop AS (
    SELECT DISTINCT ON (zone_id, bus_id, entry_ts) zone_id, bus_id, entry_ts, t0, t1, g
    FROM runs
    WHERE stopped AND t1 - t0 >= interval '10 minutes'
      AND ST_DWithin(g::geography, ST_SetSRID(ST_MakePoint(39.8262, 21.4225), 4326)::geography, 8000)
    ORDER BY zone_id, bus_id, entry_ts, t1 DESC
)
SELECT s.zone_id, s.bus_id, s.entry_ts,
       s.t1 AS depart_ts,
       extract(epoch FROM s.t1 - s.t0) AS loading_s,
       s.g::geometry(Point, 4326) AS origin,
       extract(epoch FROM s.entry_ts - s.t1) AS observed_s,
       -- Longest stationary spell on the way: a holding area or a long queue.
       (SELECT coalesce(max(extract(epoch FROM r.t1 - r.t0)), 0) FROM runs r
         WHERE r.zone_id = s.zone_id AND r.bus_id = s.bus_id AND r.entry_ts = s.entry_ts
           AND r.stopped AND r.t0 > s.t1) AS longest_stop_s
FROM last_stop s
WHERE s.entry_ts - s.t1 BETWEEN interval '5 minutes' AND interval '3 hours';

GRANT SELECT ON routing.backtest_trip TO ro_user;

SELECT count(*) AS trips,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY observed_s) / 60)::numeric, 1) AS median_min,
       count(*) FILTER (WHERE longest_stop_s < 1200) AS without_long_stop
FROM routing.backtest_trip;
