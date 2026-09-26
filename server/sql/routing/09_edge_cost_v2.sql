-- Step 9: switch the routing costs to the stop-inclusive speeds of step 08.
-- Database: your_db.  Run as: postgres.  Requires 02b and 08.
--
-- routing.edge_cost (used to rank candidate routes, and as the fallback for
-- per-slot times) now takes an edge's all-day stop-inclusive speed where the
-- history is substantial (≥ 10 bus-minutes, ≥ 200 m of progress), else the
-- moving-only speed of 02b, else free flow. The previous view stays as
-- routing.edge_cost_v1 for comparison.
--
-- routing.edge_slot_speed gives the per-slot stop-inclusive speed where the
-- slot has ≥ 2 bus-minutes and ≥ 200 m of progress; the candidate generator
-- uses it for route_candidate_slot, falling back to edge_cost.

CREATE OR REPLACE VIEW routing.edge_cost_v1 AS
SELECT e.id, e.source, e.target, e.geom, e.length_m,
       CASE WHEN e.cost_s < 0 THEN -1
            WHEN f.n_points >= 30 AND f.speed_kmh >= 3 THEN e.length_m / (f.speed_kmh / 3.6)
            ELSE e.cost_s END AS cost_s,
       CASE WHEN e.reverse_cost_s < 0 THEN -1
            WHEN r.n_points >= 30 AND r.speed_kmh >= 3 THEN e.length_m / (r.speed_kmh / 3.6)
            ELSE e.reverse_cost_s END AS reverse_cost_s
FROM routing.edge e
LEFT JOIN routing.edge_speed_static f ON f.edge_id = e.id AND f.dir = 1
LEFT JOIN routing.edge_speed_static r ON r.edge_id = e.id AND r.dir = -1;

CREATE OR REPLACE VIEW routing.edge_cost AS
SELECT v1.id, v1.source, v1.target, v1.geom, v1.length_m,
       CASE WHEN v1.cost_s < 0 THEN -1
            WHEN f.time_s >= 600 AND f.dist_m >= 200 AND f.speed_kmh >= 1 THEN v1.length_m / (f.speed_kmh / 3.6)
            ELSE v1.cost_s END AS cost_s,
       CASE WHEN v1.reverse_cost_s < 0 THEN -1
            WHEN r.time_s >= 600 AND r.dist_m >= 200 AND r.speed_kmh >= 1 THEN v1.length_m / (r.speed_kmh / 3.6)
            ELSE v1.reverse_cost_s END AS reverse_cost_s
FROM routing.edge_cost_v1 v1
LEFT JOIN routing.edge_speed_static_v2 f ON f.edge_id = v1.id AND f.dir = 1
LEFT JOIN routing.edge_speed_static_v2 r ON r.edge_id = v1.id AND r.dir = -1;

CREATE OR REPLACE VIEW routing.edge_slot_speed AS
SELECT edge_id, dir, slot, speed_kmh
FROM routing.edge_speed_profile_v2
WHERE time_s >= 120 AND dist_m >= 200 AND speed_kmh >= 1;

GRANT SELECT ON routing.edge_cost_v1, routing.edge_cost, routing.edge_slot_speed TO ro_user;

-- How much slower routes look now, per road type (all-day, length-weighted).
SELECT e.highway,
       round((sum(e.length_m) / sum(v1.cost_s) * 3.6)::numeric, 1) AS v1_kmh,
       round((sum(e.length_m) / sum(v2.cost_s) * 3.6)::numeric, 1) AS v2_kmh
FROM routing.edge e
JOIN routing.edge_cost_v1 v1 ON v1.id = e.id AND v1.cost_s > 0
JOIN routing.edge_cost v2 ON v2.id = e.id AND v2.cost_s > 0
WHERE e.highway IN ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential')
GROUP BY 1 ORDER BY 2 DESC;
