-- Step 7b: which back-test trips are direct residence → entrance trips.
-- Database: your_db.  Run as: postgres, on the VM.  Requires 07.
--
-- Plotting long trips showed two definition problems, not model errors:
-- some buses entered another entrance first (drop-off inside Arafat, then a
-- loop that later crossed the sampled gate), and some "trips" were several
-- legs (the chosen loading stop was not the last pickup). For each trip this
-- records the first entrance entered after departure, the distance driven,
-- time stopped (≤ 3 km/h) and the straight-line distance, so the back-test can
-- keep direct trips: first entrance = the sampled one, and driven ≤ 2 × straight.

SET work_mem = '256MB';
SET statement_timeout = 0;

DROP TABLE IF EXISTS routing.backtest_trip_detail;
CREATE TABLE routing.backtest_trip_detail AS
WITH legs AS (
    SELECT t.zone_id, t.bus_id, t.entry_ts, h.speed,
           extract(epoch FROM lead(h.dt_timestamptz) OVER w - h.dt_timestamptz) AS dt,
           ST_Distance(h.geom::geography, (lead(h.geom) OVER w)::geography) AS dm
    FROM routing.backtest_trip t
    JOIN public.hajj_days_2 h ON h.bus_id = t.bus_id AND h.dt_timestamptz BETWEEN t.depart_ts AND t.entry_ts
    WINDOW w AS (PARTITION BY t.zone_id, t.bus_id, t.entry_ts ORDER BY h.dt_timestamptz)
), agg AS (
    SELECT zone_id, bus_id, entry_ts,
           sum(dm) FILTER (WHERE dt < 600)                     AS driven_m,
           sum(dt) FILTER (WHERE dt < 600 AND speed <= 3)      AS stopped_s,
           sum(dt) FILTER (WHERE dt < 600 AND speed > 3)       AS moving_s
    FROM legs GROUP BY 1, 2, 3
)
SELECT t.zone_id, t.bus_id, t.entry_ts, a.driven_m, a.stopped_s, a.moving_s,
       ST_Distance(t.origin::geography, ST_Centroid(z.geom)::geography) AS straight_m,
       (SELECT ee.zone_id FROM routing.entrance_entry ee
         WHERE ee.bus_id = t.bus_id AND ee.entry_ts > t.depart_ts AND ee.entry_ts <= t.entry_ts
         ORDER BY ee.entry_ts LIMIT 1) AS first_zone
FROM routing.backtest_trip t
JOIN agg a USING (zone_id, bus_id, entry_ts)
JOIN routing.entrance_zone z ON z.zone_id = t.zone_id;

GRANT SELECT ON routing.backtest_trip_detail TO ro_user;

SELECT count(*) AS trips,
       count(*) FILTER (WHERE first_zone = zone_id) AS first_entrance_is_sampled,
       count(*) FILTER (WHERE first_zone = zone_id AND driven_m <= 2 * straight_m) AS direct
FROM routing.backtest_trip_detail;
