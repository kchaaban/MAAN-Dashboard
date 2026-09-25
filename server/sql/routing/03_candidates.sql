-- Candidate routes from residences to their assigned entrances.
-- Database: transport (next to plans, residences and entrances).
-- Run as:   postgres
--
-- The network and speeds live in your_db; scripts/generate-route-candidates.js
-- computes routes there and writes the results here, so neither database
-- needs a foreign-data link to the other.

CREATE SCHEMA IF NOT EXISTS routing;

-- One row per generation: the parameters it ran with, so candidates from
-- different settings can be compared and old ones dropped in one delete.
CREATE TABLE IF NOT EXISTS routing.generation_run (
    id              serial PRIMARY KEY,
    created_at      timestamptz NOT NULL DEFAULT now(),
    method          text        NOT NULL,          -- e.g. 'penalty_dijkstra'
    cost_basis      text        NOT NULL,          -- 'observed' | 'freeflow'
    params          jsonb       NOT NULL DEFAULT '{}',
    od_count        int,
    candidate_count int,
    finished_at     timestamptz,
    notes           text
);

-- A residence → entrance pair that at least one plan needs.
CREATE TABLE IF NOT EXISTS routing.od_pair (
    id                   bigserial PRIMARY KEY,
    residence_id         uuid NOT NULL REFERENCES public.residences(id) ON DELETE CASCADE,
    entrance_id          uuid NOT NULL REFERENCES public.entrances(id)  ON DELETE CASCADE,
    origin               geometry(Point, 4326) NOT NULL,
    destination          geometry(Point, 4326) NOT NULL,
    straight_m           double precision,
    origin_vertex        bigint,            -- routing.vertex id in your_db
    destination_vertex   bigint,
    origin_snap_m        double precision,  -- distance from the point to its vertex
    destination_snap_m   double precision,
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (residence_id, entrance_id)
);

CREATE TABLE IF NOT EXISTS routing.route_candidate (
    id              bigserial PRIMARY KEY,
    run_id          int    NOT NULL REFERENCES routing.generation_run(id) ON DELETE CASCADE,
    od_pair_id      bigint NOT NULL REFERENCES routing.od_pair(id)        ON DELETE CASCADE,
    rank            smallint NOT NULL,        -- 0 = the plans' current path, 1.. = generated
    source          text   NOT NULL,          -- 'current_plan' | 'penalty_dijkstra'
    geom            geometry(LineString, 4326) NOT NULL,
    length_m        double precision NOT NULL,
    travel_s        double precision,         -- on the run's cost basis
    freeflow_s      double precision,
    edge_ids        bigint[],                 -- your_db routing.edge ids, in travel order
    edge_dirs       smallint[],               -- 1 = source→target, -1 = reverse
    max_overlap     real,                     -- largest shared-length share with a better candidate
    UNIQUE (run_id, od_pair_id, rank)
);
CREATE INDEX IF NOT EXISTS route_candidate_od_idx  ON routing.route_candidate (od_pair_id);
CREATE INDEX IF NOT EXISTS route_candidate_gix     ON routing.route_candidate USING gist (geom);

-- Travel time of a candidate if departing in each 15-min slot of the history.
-- Summed from each edge's observed speed in the departure slot: a first
-- approximation that ignores the slot changing mid-journey.
CREATE TABLE IF NOT EXISTS routing.route_candidate_slot (
    candidate_id    bigint NOT NULL REFERENCES routing.route_candidate(id) ON DELETE CASCADE,
    slot            timestamptz NOT NULL,
    travel_s        double precision NOT NULL,
    observed_share  real NOT NULL,            -- share of the length with an observed speed in this slot
    PRIMARY KEY (candidate_id, slot)
);

-- The route each plan uses. Written by the optimizer or a planner; a locked
-- row is one the optimizer must leave alone.
CREATE TABLE IF NOT EXISTS routing.plan_route (
    plan_id         uuid   PRIMARY KEY REFERENCES public.plans(id) ON DELETE CASCADE,
    candidate_id    bigint NOT NULL REFERENCES routing.route_candidate(id) ON DELETE CASCADE,
    chosen_by       text   NOT NULL,          -- 'baseline' | 'optimizer' | 'planner'
    locked          boolean NOT NULL DEFAULT false,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

GRANT USAGE ON SCHEMA routing TO ro_user;
GRANT SELECT ON ALL TABLES IN SCHEMA routing TO ro_user;

-- Slots as Hajj-relative times. The GPS history is from Hajj 1446 and plans
-- are for later years; Hajj falls on the same Hijri dates each year, so a
-- plan's window (timing.start_at_hijri + start_at) is matched on Hijri day
-- and local time of day, never on the Gregorian date.
-- 1 Dhul Hijjah 1446 = 28 May 2025 (Umm al-Qura), so day n = 27 May + n.
CREATE OR REPLACE VIEW routing.route_candidate_slot_hijri AS
SELECT s.candidate_id,
       ((s.slot AT TIME ZONE 'Asia/Riyadh')::date - DATE '2025-05-27') AS hijri_day,
       (s.slot AT TIME ZONE 'Asia/Riyadh')::time                        AS local_time,
       s.travel_s,
       s.observed_share
FROM routing.route_candidate_slot s;

GRANT SELECT ON routing.route_candidate_slot_hijri TO ro_user;
