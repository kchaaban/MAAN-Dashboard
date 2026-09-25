-- Step 5: 1446 bus flow per edge, direction and 15-min slot, for calibrating
-- the optimizer's congestion model against observed speeds (02b).
-- Database: your_db.  Run as: postgres.  Requires 02a and 02b.
--
-- Each moving GPS point is placed on an edge through the (cell, heading)
-- matches of 02b, and distinct buses are counted per edge and slot. The bins
-- of 02a cannot give this: they keep counts per cell, not bus ids, and one
-- bus crosses many cells of an edge.
--
-- Moving buses report every ~9 s (median; 90% within 32 s), so a bus can cross
-- a short edge unseen; the calibration corrects for that and uses edges of at
-- least 300 m, which buses take long enough to cross to be seen.

SET work_mem = '512MB';
SET temp_file_limit = '8GB';
SET statement_timeout = 0;

DROP TABLE IF EXISTS routing.edge_flow;
CREATE TABLE routing.edge_flow (
    edge_id  bigint      NOT NULL,
    dir      smallint    NOT NULL,
    slot     timestamptz NOT NULL,
    n_buses  int         NOT NULL
);

SELECT format($q$
    INSERT INTO routing.edge_flow
    SELECT gc.edge_id, gc.dir,
           date_bin('15 minutes', h.dt_timestamptz, TIMESTAMPTZ '2025-06-01 00:00+03'),
           count(DISTINCT h.bus_id)
    FROM public.hajj_days_2 h
    JOIN routing.gps_cell gc
      ON gc.cx = round(ST_X(ST_SnapToGrid(h.geom, 0.0002)) * 5000)::int
     AND gc.cy = round(ST_Y(ST_SnapToGrid(h.geom, 0.0002)) * 5000)::int
     AND gc.sector = (floor(h.angle / 45)::int %% 8)
    WHERE h.dt_timestamptz >= %L AND h.dt_timestamptz < %L
      AND h.speed > 0 AND h.angle >= 0
      AND h.geom && ST_MakeEnvelope(39.6, 21.2, 40.2, 21.7, 4326)
    GROUP BY 1, 2, 3
$q$, day, day + interval '1 day')
FROM generate_series(TIMESTAMPTZ '2025-06-03 00:00+03', TIMESTAMPTZ '2025-06-06 00:00+03', interval '1 day') AS day
\gexec

ALTER TABLE routing.edge_flow ADD PRIMARY KEY (edge_id, dir, slot);
GRANT SELECT ON routing.edge_flow TO ro_user;

SELECT count(*) AS edge_slots, sum(n_buses) AS bus_passages, max(n_buses) AS max_buses_per_slot
FROM routing.edge_flow;
