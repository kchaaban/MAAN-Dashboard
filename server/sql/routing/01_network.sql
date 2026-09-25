-- Routable road network for Makkah and the Mashaer.
-- Database: your_db (next to the OSM import and the GPS history).
-- Run as:   postgres  (CREATE EXTENSION needs a superuser)
--
-- Edges are cut from osm2pgsql's middle tables (planet_osm_ways.nodes +
-- planet_osm_nodes) at every node shared by two or more ways. That keeps real
-- OSM topology: a bridge crossing a road is not joined to it, which geometric
-- noding (ST_Node) would get wrong.
--
-- Rebuilding is idempotent: the routing schema's network tables are dropped
-- and recreated. Speed profiles (02) reference edge ids, so re-run 02 after.

CREATE EXTENSION IF NOT EXISTS pgrouting;
CREATE SCHEMA IF NOT EXISTS routing;

DROP VIEW  IF EXISTS routing.edge_cost;
DROP TABLE IF EXISTS routing.edge CASCADE;
DROP TABLE IF EXISTS routing.vertex CASCADE;
DROP TABLE IF EXISTS routing.osm_way;

-- ── Drivable ways ──────────────────────────────────────────────────────────
CREATE TABLE routing.osm_way AS
SELECT w.id AS osm_id,
       w.nodes,
       w.tags->>'highway' AS highway,
       coalesce(w.tags->>'name:ar', w.tags->>'name') AS name,
       NULLIF(substring(w.tags->>'maxspeed' FROM '^[0-9]+'), '')::int AS maxspeed_kmh,
       NULLIF(substring(w.tags->>'lanes' FROM '^[0-9]+'), '')::int AS lanes,
       CASE
           WHEN w.tags->>'oneway' = '-1' THEN -1
           WHEN w.tags->>'oneway' IN ('yes', 'true', '1') THEN 1
           WHEN w.tags->>'oneway' = 'no' THEN 0
           WHEN w.tags->>'junction' IN ('roundabout', 'circular') THEN 1
           WHEN w.tags->>'highway' IN ('motorway', 'motorway_link') THEN 1
           ELSE 0
       END AS oneway
FROM public.planet_osm_ways w
WHERE w.tags->>'highway' IN (
        'motorway', 'motorway_link', 'trunk', 'trunk_link',
        'primary', 'primary_link', 'secondary', 'secondary_link',
        'tertiary', 'tertiary_link', 'unclassified', 'residential',
        'living_street', 'service')
  AND coalesce(w.tags->>'access', 'yes') NOT IN ('no', 'private')
  AND coalesce(w.tags->>'motor_vehicle', 'yes') <> 'no'
  AND coalesce(w.tags->>'service', '') NOT IN ('parking_aisle', 'driveway')
  AND array_length(w.nodes, 1) >= 2;

-- ── Split points: nodes used by 2+ ways (or twice by one), plus way ends ───
CREATE TEMP TABLE split_node AS
SELECT node_id FROM (
    SELECT unnest(nodes) AS node_id FROM routing.osm_way
) u GROUP BY node_id HAVING count(*) > 1
UNION
SELECT nodes[1] FROM routing.osm_way
UNION
SELECT nodes[array_length(nodes, 1)] FROM routing.osm_way;
CREATE UNIQUE INDEX ON split_node (node_id);

-- Each node gets the number of the segment it starts (count of split points
-- up to and including it); a split node also ends the previous segment.
CREATE TEMP TABLE way_node AS
WITH pts AS (
    SELECT w.osm_id, u.node_id, u.seq, (s.node_id IS NOT NULL) AS is_split
    FROM routing.osm_way w
    CROSS JOIN LATERAL unnest(w.nodes) WITH ORDINALITY AS u(node_id, seq)
    LEFT JOIN split_node s ON s.node_id = u.node_id
), numbered AS (
    SELECT *, sum(is_split::int) OVER (PARTITION BY osm_id ORDER BY seq) AS seg
    FROM pts
)
SELECT osm_id, seg, node_id, seq FROM numbered
UNION ALL
SELECT osm_id, seg - 1, node_id, seq FROM numbered WHERE is_split AND seg > 1;

-- ── Edges ──────────────────────────────────────────────────────────────────
CREATE TABLE routing.edge (
    id              bigserial PRIMARY KEY,
    osm_id          bigint   NOT NULL,
    source          bigint   NOT NULL,   -- OSM node id
    target          bigint   NOT NULL,   -- OSM node id
    highway         text     NOT NULL,
    name            text,
    lanes           int,
    oneway          smallint NOT NULL,   -- 1 forward only, -1 backward only, 0 both
    freeflow_kmh    numeric  NOT NULL,
    length_m        double precision NOT NULL,
    cost_s          double precision NOT NULL,  -- source → target, -1 = closed
    reverse_cost_s  double precision NOT NULL,  -- target → source, -1 = closed
    geom            geometry(LineString, 4326) NOT NULL
);

INSERT INTO routing.edge (osm_id, source, target, highway, name, lanes, oneway,
                          freeflow_kmh, length_m, cost_s, reverse_cost_s, geom)
SELECT s.osm_id, s.source, s.target, w.highway, w.name, w.lanes, w.oneway,
       sp.kmh, s.length_m,
       CASE WHEN w.oneway = -1 THEN -1 ELSE s.length_m / (sp.kmh / 3.6) END,
       CASE WHEN w.oneway =  1 THEN -1 ELSE s.length_m / (sp.kmh / 3.6) END,
       s.geom
FROM (
    SELECT wn.osm_id,
           (array_agg(wn.node_id ORDER BY wn.seq))[1] AS source,
           (array_agg(wn.node_id ORDER BY wn.seq DESC))[1] AS target,
           ST_MakeLine(ST_SetSRID(ST_MakePoint(n.lon / 1e7, n.lat / 1e7), 4326) ORDER BY wn.seq) AS geom,
           count(*) AS n_nodes
    FROM way_node wn
    JOIN public.planet_osm_nodes n ON n.id = wn.node_id
    GROUP BY wn.osm_id, wn.seg
    HAVING count(*) >= 2
) s0
CROSS JOIN LATERAL (SELECT s0.*, ST_Length(s0.geom::geography) AS length_m) s
JOIN routing.osm_way w ON w.osm_id = s.osm_id
CROSS JOIN LATERAL (
    SELECT coalesce(w.maxspeed_kmh, CASE w.highway
        WHEN 'motorway' THEN 90 WHEN 'trunk' THEN 80 WHEN 'primary' THEN 60
        WHEN 'secondary' THEN 50 WHEN 'tertiary' THEN 40
        WHEN 'motorway_link' THEN 50 WHEN 'trunk_link' THEN 45
        WHEN 'primary_link' THEN 40 WHEN 'secondary_link' THEN 35 WHEN 'tertiary_link' THEN 30
        WHEN 'unclassified' THEN 30 WHEN 'residential' THEN 25
        WHEN 'living_street' THEN 10 ELSE 15 END)::numeric AS kmh
) sp
WHERE s.source <> s.target AND s.length_m > 0;

CREATE INDEX edge_geom_gix   ON routing.edge USING gist (geom);
CREATE INDEX edge_source_idx ON routing.edge (source);
CREATE INDEX edge_target_idx ON routing.edge (target);

-- ── Vertices, restricted to the largest connected component ───────────────
-- Snapping a residence to an island (a gated compound, an unlinked service
-- road) would make every route from it fail, so only the main component is
-- offered as a snap target.
CREATE TABLE routing.vertex AS
SELECT n.id, ST_SetSRID(ST_MakePoint(n.lon / 1e7, n.lat / 1e7), 4326)::geometry(Point, 4326) AS geom,
       false AS in_main
FROM public.planet_osm_nodes n
WHERE n.id IN (SELECT source FROM routing.edge UNION SELECT target FROM routing.edge);
ALTER TABLE routing.vertex ADD PRIMARY KEY (id);

WITH cc AS (
    SELECT node, component FROM pgr_connectedComponents(
        'SELECT id, source, target, cost_s AS cost, reverse_cost_s AS reverse_cost FROM routing.edge')
), biggest AS (
    SELECT component FROM cc GROUP BY component ORDER BY count(*) DESC LIMIT 1
)
UPDATE routing.vertex v SET in_main = true
FROM cc JOIN biggest USING (component)
WHERE v.id = cc.node;

CREATE INDEX vertex_geom_main_gix ON routing.vertex USING gist (geom) WHERE in_main;

-- Default cost view: free-flow. 02_speed_profiles.sql replaces it with observed
-- speeds where the GPS history has enough evidence.
CREATE VIEW routing.edge_cost AS
SELECT id, source, target, geom, length_m, cost_s, reverse_cost_s
FROM routing.edge;

GRANT USAGE ON SCHEMA routing TO ro_user;
GRANT SELECT ON ALL TABLES IN SCHEMA routing TO ro_user;

-- Sanity check: expect tens of thousands of edges and ~all vertices in_main.
SELECT (SELECT count(*) FROM routing.edge) AS edges,
       (SELECT count(*) FROM routing.vertex) AS vertices,
       (SELECT round(100.0 * avg(in_main::int), 1) FROM routing.vertex) AS pct_in_main;
