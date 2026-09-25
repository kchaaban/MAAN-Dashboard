-- Step 2a: bin the Hajj 1446 bus GPS history (public.hajj_days_2, ~76M points)
-- for the per-edge speed profiles built in 02b_speed_profiles.sql.
-- Database: your_db.  Run as: postgres.  Requires 01_network.sql.
--
-- Matching 76M points to edges one by one is slow and hajj_days_2 has no
-- spatial index, so points are first binned to a ~20 m grid cell × 8 heading
-- sectors × 15-min slot, and only the bins are matched
-- to edges, by distance and by heading agreeing with the edge's direction.
--
-- Stationary points (speed = 0) are left out of the speed statistics: a bus
-- idling at a residence would otherwise read as a jammed road next to it.
-- Congestion still shows through slow moving points (share_slow).

-- Rebuilding the bins invalidates the profiles built from them (02b).
DROP VIEW  IF EXISTS routing.edge_cost;
DROP TABLE IF EXISTS routing.edge_speed_profile;
DROP TABLE IF EXISTS routing.edge_speed_static;
DROP TABLE IF EXISTS routing.gps_cell;
DROP TABLE IF EXISTS routing.gps_bin;

SET work_mem = '512MB';
-- The VM's data disk is shared with the OS; fail a query rather than fill it.
SET temp_file_limit = '8GB';
SET statement_timeout = 0;

-- ── 1. Bin the GPS points, one day per statement ──────────────────────────
-- A single GROUP BY over all 76M rows would sort them in one go; a day at a
-- time keeps the temp files to a fifth of that, and each day is committed
-- before the next starts. gps_bin is UNLOGGED: it is rebuilt, never recovered.
CREATE UNLOGGED TABLE routing.gps_bin (
    cell        geometry(Point, 4326) NOT NULL,
    sector      smallint    NOT NULL,
    slot        timestamptz NOT NULL,
    n_points    bigint      NOT NULL,
    n_buses     bigint      NOT NULL,
    median_kmh  double precision NOT NULL,
    share_slow  double precision NOT NULL
);

SELECT format($q$
    INSERT INTO routing.gps_bin
    SELECT ST_SnapToGrid(geom, 0.0002),
           (floor(angle / 45)::int %% 8),
           date_bin('15 minutes', dt_timestamptz, TIMESTAMPTZ '2025-06-01 00:00+03'),
           count(*),
           count(DISTINCT bus_id),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY speed),
           avg((speed < 10)::int)
    FROM public.hajj_days_2
    WHERE dt_timestamptz >= %L AND dt_timestamptz < %L
      AND speed > 0
      AND angle >= 0
      AND geom && ST_MakeEnvelope(39.6, 21.2, 40.2, 21.7, 4326)
    GROUP BY 1, 2, 3
$q$, day, day + interval '1 day')
FROM generate_series(
    (SELECT date_trunc('day', min(dt_timestamptz) AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh' FROM public.hajj_days_2),
    (SELECT max(dt_timestamptz) FROM public.hajj_days_2),
    interval '1 day') AS day
\gexec

ANALYZE routing.gps_bin;
