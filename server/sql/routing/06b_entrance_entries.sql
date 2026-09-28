-- Step 6, pass 2: visits and entries from routing.entrance_pts (pass 1, in
-- 06_entrance_flow.sql, which runs this file at its end). While entrance_pts
-- is still there, this pass can be rerun alone (a few minutes):
--   psql -d your_db -f sql/routing/06b_entrance_entries.sql
--
-- Not every crossing is a gate entry. Entrance polygons are 60–90 m across and
-- several sit on through roads, where buses cross them at 40–50 km/h without
-- using the gate, some of them several times an hour. A crossing counts as a
-- gate entry only when the bus slowed to ≤ 15 km/h within 2 min either side of
-- it (gate_kmh, its slowest fix then); on the busiest gates 65–80% of crossings
-- do, on the through-road ASMARF9 11%. A bus counts once per hour at an
-- entrance: a gate entry within 60 min of its previous one there is a repeat.

SET work_mem = '512MB';
SET temp_file_limit = '8GB';
SET statement_timeout = 0;

DROP TABLE IF EXISTS routing.entrance_flow_slot;
DROP TABLE IF EXISTS routing.entrance_entry;

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
), entries AS (
    SELECT v.zone_id, v.bus_id, v.entry_ts,
           CASE WHEN v.started_inside THEN NULL ELSE extract(epoch FROM v.entry_ts - v.visit_start) END AS approach_s,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY p.speed) FILTER (WHERE p.ts < v.entry_ts) AS approach_kmh,
           min(p.speed) FILTER (WHERE p.ts BETWEEN v.entry_ts - interval '2 minutes'
                                              AND v.entry_ts + interval '2 minutes') AS gate_kmh
    FROM per_visit v
    JOIN visits p ON p.zone_id = v.zone_id AND p.bus_id = v.bus_id AND p.visit = v.visit
    WHERE v.entry_ts IS NOT NULL
    GROUP BY v.zone_id, v.bus_id, v.visit, v.entry_ts, v.started_inside, v.visit_start
), gated AS (
    SELECT *, coalesce(gate_kmh <= 15, false) AS gate_entry FROM entries
)
SELECT *,
       -- Compared with the bus's previous gate entry, counted or not: a bus
       -- looping through every 40 min counts once for the whole run of laps.
       gate_entry AND coalesce(entry_ts - max(entry_ts) FILTER (WHERE gate_entry) OVER w > interval '60 minutes', true) AS counted
FROM gated
WINDOW w AS (PARTITION BY zone_id, bus_id ORDER BY entry_ts ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING);

-- Per entrance and 15-min slot: counted entries, and how long their buses took
-- to approach. crossings keeps every crossing, for comparison.
CREATE TABLE routing.entrance_flow_slot AS
SELECT zone_id,
       date_bin('15 minutes', entry_ts, TIMESTAMPTZ '2025-06-01 00:00+03') AS slot,
       count(*) FILTER (WHERE counted)                                            AS entries,
       count(DISTINCT bus_id) FILTER (WHERE counted)                              AS buses,
       count(*)                                                                   AS crossings,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY approach_s) FILTER (WHERE counted)   AS approach_s_median,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY approach_kmh) FILTER (WHERE counted) AS approach_kmh_median,
       count(approach_s) FILTER (WHERE counted)                                   AS with_approach
FROM routing.entrance_entry
GROUP BY 1, 2;

ALTER TABLE routing.entrance_flow_slot ADD PRIMARY KEY (zone_id, slot);
GRANT SELECT ON routing.entrance_pts, routing.entrance_entry, routing.entrance_flow_slot TO ro_user;

SELECT zone_id, sum(entries) AS entries, sum(crossings) AS crossings,
       max(entries) AS peak_15min, count(*) FILTER (WHERE entries > 0) AS active_slots
FROM routing.entrance_flow_slot GROUP BY 1 ORDER BY 2 DESC;
