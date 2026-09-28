-- Results of the route + departure-slot optimizer (scripts/optimize-routes.js).
-- Database: transport.  Run as: postgres.  Requires 03_candidates.sql.
--
-- A run never touches public.plans or routing.plan_route: it records what it
-- would do, next to the baseline it was compared with, so runs with different
-- parameters can be compared before one is applied.

CREATE TABLE IF NOT EXISTS routing.optimization_run (
    id                 serial PRIMARY KEY,
    generation_run_id  int NOT NULL REFERENCES routing.generation_run(id) ON DELETE CASCADE,
    created_at         timestamptz NOT NULL DEFAULT now(),
    finished_at        timestamptz,
    params             jsonb NOT NULL,
    solver_status      text,
    mip_gap            double precision,
    solve_seconds      double precision,
    baseline_kpis      jsonb,   -- fastest route, buses spread evenly over the window
    optimized_kpis     jsonb,
    notes              text
);

-- Buses of each plan dispatched on a route in a 15-min slot. A plan uses one
-- route; its buses may be staggered over several slots of its window.
-- Times are Hajj-relative (Hijri day + local time) so the plan applies to any year.
CREATE TABLE IF NOT EXISTS routing.plan_dispatch (
    run_id        int    NOT NULL REFERENCES routing.optimization_run(id) ON DELETE CASCADE,
    scenario      text   NOT NULL CHECK (scenario IN ('baseline', 'optimized')),
    plan_id       uuid   NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
    candidate_id  bigint NOT NULL REFERENCES routing.route_candidate(id) ON DELETE CASCADE,
    hijri_day     smallint NOT NULL,
    local_time    time     NOT NULL,
    buses         int      NOT NULL CHECK (buses > 0),
    travel_s      double precision,     -- 1446 travel time for that departure slot
    PRIMARY KEY (run_id, scenario, plan_id, hijri_day, local_time)
);
CREATE INDEX IF NOT EXISTS plan_dispatch_plan_idx ON routing.plan_dispatch (plan_id);

-- Plans a run could not route, and why: no residence → entrance pair, no
-- route in the generation run, or every route inside the avoid zones.
-- They are in neither scenario, so the run's KPIs leave their buses out.
CREATE TABLE IF NOT EXISTS routing.plan_skipped (
    run_id   int  NOT NULL REFERENCES routing.optimization_run(id) ON DELETE CASCADE,
    plan_id  uuid NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
    reason   text NOT NULL,
    buses    int  NOT NULL,
    PRIMARY KEY (run_id, plan_id)
);

GRANT SELECT ON routing.optimization_run, routing.plan_dispatch, routing.plan_skipped TO ro_user;
