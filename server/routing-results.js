// Read-only access to route-optimization runs (sql/routing/04_optimizer.sql)
// for the dashboard: which runs exist, and for one run the route and departure
// slots of each plan in both scenarios, limited to the caller's plans.

const { pool, scopeClause } = require('./db');

// Run KPIs cover every plan, so only callers who can see every plan get them.
async function listRuns(scope) {
    const { rows } = await pool.query(`
        SELECT id, created_at, params, notes, solver_status, solve_seconds,
               baseline_kpis, optimized_kpis
        FROM routing.optimization_run
        WHERE finished_at IS NOT NULL
        ORDER BY id DESC`);
    return scope.kind === 'all' ? rows : rows.map(({ baseline_kpis, optimized_kpis, ...rest }) => rest);
}

// { run, plans: { planId: { baseline|optimized: { candidate, slots: [[hijriDay, 'HH:MM', buses, travelS]] } } },
//   candidates: { id: { rank, length_m, travel_s, geometry } } }
async function runDetail(runId, scope) {
    const { rows: [run] } = await pool.query(`
        SELECT id, created_at, params, notes, baseline_kpis, optimized_kpis
        FROM routing.optimization_run WHERE id = $1`, [runId]);
    if (!run) return null;
    if (scope.kind !== 'all') { delete run.baseline_kpis; delete run.optimized_kpis; }

    // Same scope columns as the plans dataset, so a user only sees their plans.
    const { where, values } = scopeClause(scope, {
        company: 'psv.owner_company_id',
        center: 'psv.owner_service_center_id',
    });
    values.push(runId);
    const { rows: dispatch } = await pool.query(`
        SELECT d.scenario, d.plan_id, d.candidate_id, d.hijri_day,
               to_char(d.local_time, 'HH24:MI') AS local_time, d.buses, round(d.travel_s) AS travel_s
        FROM routing.plan_dispatch d
        JOIN public.plan_show_view psv ON psv.id = d.plan_id
        WHERE d.run_id = $${values.length} AND ${where}
        ORDER BY d.plan_id, d.scenario, d.hijri_day, d.local_time`, values);

    const plans = {};
    const candidateIds = new Set();
    for (const d of dispatch) {
        const plan = plans[d.plan_id] || (plans[d.plan_id] = {});
        const side = plan[d.scenario] || (plan[d.scenario] = { candidate: Number(d.candidate_id), slots: [] });
        side.slots.push([d.hijri_day, d.local_time, d.buses, Number(d.travel_s)]);
        candidateIds.add(Number(d.candidate_id));
    }

    // Geometry simplified to ~5 m: enough to draw, a fraction of the size.
    const { rows: cands } = await pool.query(`
        SELECT id, rank, round(length_m) AS length_m, round(travel_s) AS travel_s,
               ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.00005), 5) AS geometry
        FROM routing.route_candidate
        WHERE id = ANY($1::bigint[])`, [[...candidateIds]]);
    const candidates = {};
    for (const c of cands) {
        candidates[c.id] = {
            rank: c.rank, length_m: Number(c.length_m), travel_s: Number(c.travel_s),
            geometry: JSON.parse(c.geometry),
        };
    }
    return { run, plans, candidates };
}

module.exports = { listRuns, runDetail };
