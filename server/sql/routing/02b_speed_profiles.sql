-- Step 2b: observed travel speeds per edge and direction, per 15-minute slot,
-- from the GPS bins of 02a_gps_bins.sql.
-- Database: your_db.  Run as: postgres.  Requires 01 and 02a.
--
-- Each distinct (grid cell, heading sector) is matched to the nearest edge
-- whose direction agrees with the heading, and the bins' speeds are then
-- aggregated per edge. Cells are handled by integer grid keys throughout:
-- DISTINCT or joins on the geometry itself sort geometries, which on 9M bins
-- ran for hours; on integers the whole step takes minutes.
--
-- Stationary points (speed = 0) were left out in 02a: a bus idling at a
-- residence would otherwise read as a jammed road next to it. Congestion
-- still shows through slow moving points (share_slow).

SET work_mem = '512MB';
SET temp_file_limit = '8GB';
SET statement_timeout = 0;

DROP VIEW  IF EXISTS routing.edge_cost;
DROP TABLE IF EXISTS routing.edge_speed_profile;
DROP TABLE IF EXISTS routing.edge_speed_static;
DROP TABLE IF EXISTS routing.gps_cell;

-- ── 1. Integer keys on the bins (ST_SnapToGrid at 0.0002° = 1/5000°) ──────
ALTER TABLE routing.gps_bin
    ADD COLUMN IF NOT EXISTS cx int GENERATED ALWAYS AS (round(ST_X(cell) * 5000)::int) STORED,
    ADD COLUMN IF NOT EXISTS cy int GENERATED ALWAYS AS (round(ST_Y(cell) * 5000)::int) STORED;
CREATE INDEX IF NOT EXISTS gps_bin_key_idx ON routing.gps_bin (cx, cy, sector);

-- ── 2. Match each distinct (cell, sector) to an edge and a direction ──────
-- Of the 4 nearest edges within ~25 m, the nearest whose local bearing agrees
-- with the heading sector's centre to within 60°, forward or backward, on a
-- direction the edge is open in.
CREATE TABLE routing.gps_cell AS
WITH cells AS (
    SELECT cx, cy, sector,
           ST_SetSRID(ST_MakePoint(cx / 5000.0, cy / 5000.0), 4326) AS cell
    FROM routing.gps_bin
    GROUP BY cx, cy, sector
)
SELECT c.cx, c.cy, c.sector, m.edge_id, m.dir
FROM cells c
CROSS JOIN LATERAL (
    SELECT n.id AS edge_id,
           CASE WHEN d.fwd_diff <= 60 THEN 1 ELSE -1 END::smallint AS dir
    FROM (
        SELECT e.id, e.geom, e.cost_s, e.reverse_cost_s, e.geom <-> c.cell AS dist
        FROM routing.edge e
        ORDER BY e.geom <-> c.cell
        LIMIT 4
    ) n
    CROSS JOIN LATERAL (SELECT ST_LineLocatePoint(n.geom, c.cell) AS f) loc
    CROSS JOIN LATERAL (
        SELECT degrees(ST_Azimuth(
                   ST_LineInterpolatePoint(n.geom, greatest(0, loc.f - 0.02)),
                   ST_LineInterpolatePoint(n.geom, least(1, loc.f + 0.02)))) AS bearing
    ) b
    CROSS JOIN LATERAL (
        SELECT abs(mod(((c.sector * 45 + 22.5) - b.bearing + 540)::numeric, 360) - 180) AS fwd_diff,
               abs(mod(((c.sector * 45 + 22.5) - b.bearing + 360)::numeric, 360) - 180) AS bwd_diff
    ) d
    WHERE n.dist <= 0.00025
      AND b.bearing IS NOT NULL
      AND ((d.fwd_diff <= 60 AND n.cost_s > 0) OR (d.bwd_diff <= 60 AND n.reverse_cost_s > 0))
    ORDER BY n.dist
    LIMIT 1
) m;

ALTER TABLE routing.gps_cell ADD PRIMARY KEY (cx, cy, sector);

-- ── 3. Profiles ───────────────────────────────────────────────────────────
-- n_buses is the most distinct buses seen in any one cell of the edge in the
-- slot: a floor on the edge's throughput in that slot.
CREATE TABLE routing.edge_speed_profile AS
SELECT gc.edge_id, gc.dir, g.slot,
       sum(g.n_points)                                               AS n_points,
       max(g.n_buses)                                                AS n_buses,
       sum(g.median_kmh * g.n_points) / sum(g.n_points)              AS speed_kmh,
       sum(g.share_slow * g.n_points) / sum(g.n_points)              AS share_slow
FROM routing.gps_bin g
JOIN routing.gps_cell gc USING (cx, cy, sector)
GROUP BY 1, 2, 3;

ALTER TABLE routing.edge_speed_profile ADD PRIMARY KEY (edge_id, dir, slot);

-- All-day figures per edge and direction: typical speed and peak throughput.
CREATE TABLE routing.edge_speed_static AS
SELECT edge_id, dir,
       sum(n_points)                                                 AS n_points,
       sum(speed_kmh * n_points) / sum(n_points)                     AS speed_kmh,
       max(n_buses)                                                  AS peak_buses_per_slot
FROM routing.edge_speed_profile
GROUP BY 1, 2;

ALTER TABLE routing.edge_speed_static ADD PRIMARY KEY (edge_id, dir);

-- ── 4. Cost view: observed speed where there are ≥ 30 points, else free flow
CREATE VIEW routing.edge_cost AS
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

GRANT SELECT ON ALL TABLES IN SCHEMA routing TO ro_user;

-- ── Checks ────────────────────────────────────────────────────────────────
-- Share of cells matched to an edge (the rest are off-road: parking, camps).
SELECT count(*) AS cells_matched,
       (SELECT count(*) FROM (SELECT DISTINCT cx, cy, sector FROM routing.gps_bin) s) AS cells_total
FROM routing.gps_cell;

-- Coverage: how much of the network, by length, has observed speeds.
SELECT e.highway,
       count(*)                                                      AS edges,
       round((100.0 * sum(e.length_m) FILTER (WHERE s.edge_id IS NOT NULL) / sum(e.length_m))::numeric, 1) AS pct_length_observed
FROM routing.edge e
LEFT JOIN (SELECT DISTINCT edge_id FROM routing.edge_speed_static WHERE n_points >= 30) s ON s.edge_id = e.id
GROUP BY 1 ORDER BY 2 DESC;
