// Chooses, for every residence → entrance plan, one candidate route and how
// many of its buses leave in each 15-min slot of its departure window, so that
// total bus travel time plus congestion is minimal.
//
//   node scripts/optimize-routes.js [--time-limit 300] [--gap 0.01]
//        [--capacity-share 0.4] [--alpha 0.5] [--beta 4]
//        [--residence-max 20] [--entrance-unit hour] [--dry-run]
//
// Model (a MILP solved with HiGHS: the native `highs` binary when installed,
// e.g. `brew install highs`, else the npm WebAssembly build, which only copes
// with small models):
//   x[p,k,t] ≥ 0      buses of plan p on route k leaving in slot t (t in p's window);
//                     continuous in the model, rounded per plan afterwards so each
//                     plan keeps its exact bus count
//   y[p,k]   binary   plan p uses route k
//   Σk y[p,k] = 1;  Σt x[p,k,t] = buses_p · y[p,k]
//   Σ x leaving a residence in a slot  ≤ residence-max   (loading bays)
//   Σ x arriving at an entrance in a slot ≤ its capacity where set, else its
//                     baseline peak (so no entrance gets busier than today)
//   min  Σ x · T_k(t)                                   1446 travel time for slot t
//      + Σ over road bundles b and slots s of D_b(L_bs)  congestion delay
//   L_bs = buses on bundle b during slot s, from each route's position of b and
//          its travel time; D_b(L) = L · t0_b · α (L / cap_b)^β (BPR), entered as
//          a convex piecewise-linear cost so the model stays linear.
//
// Slots are Hajj-relative: Hijri day + local time. The 1446 GPS history gives
// T_k(t) for the same Hijri day and time the plan's window names.
//
// Road capacity per 15 min = lanes × 1800 pcu/h ÷ 4 ÷ 2.5 pcu per bus ×
// --capacity-share (the share left for these plans after other traffic).
// These are engineering defaults, not measurements: calibrate them against the
// 1446 GPS before reading absolute travel times.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const args = parseArgs(process.argv.slice(2), {
    'time-limit': 300, gap: 0.01, 'capacity-share': 0.4, alpha: 0.5, beta: 4,
    'residence-max': 20, 'entrance-unit': 'hour', 'generation-run': 0, 'dry-run': false,
    // Reference congestion model every scenario is scored with, so runs with
    // different model settings are compared on one yardstick (0 = same as model).
    'eval-alpha': 0, 'eval-beta': 0, 'eval-share': 0,
    // Score saved runs instead of solving: --score-runs 3,4,5 --score-models '4:0.4,1:1.83'
    // (β:capacity-share pairs, α from --alpha). Prints total bus-hours per run × model.
    'score-runs': '', 'score-models': '',
});
const modelParams = { alpha: args.alpha, beta: args.beta, share: args['capacity-share'] };
const evalParams = {
    alpha: args['eval-alpha'] || args.alpha,
    beta: args['eval-beta'] || args.beta,
    share: args['eval-share'] || args['capacity-share'],
};

const SLOT_S = 900;
const SLOTS_PER_DAY = 96;
const FIRST_DAY = 5;                        // earliest Hijri day in the GPS history
const PCU_PER_LANE_HOUR = 1800;
const BUS_PCU = 2.5;
const DEFAULT_LANES = {
    motorway: 3, trunk: 3, primary: 2, secondary: 2, motorway_link: 1, trunk_link: 1,
    primary_link: 1, secondary_link: 1, tertiary: 1, tertiary_link: 1,
};
// Breakpoints of the piecewise-linear congestion cost, as multiples of
// capacity. The first is the load at which BPR adds 3% of the base time (0.49
// at β 4, α 0.5; 0.06 at β 1): below it load is free and needs no variable.
// The rest are spaced geometrically up to twice capacity.
const FREE_DELAY = 0.03;
const BREAKS = (() => {
    const first = Math.min(0.5, Math.pow(FREE_DELAY / args.alpha, 1 / args.beta));
    const steps = 4;
    const ratio = Math.pow(2 / first, 1 / steps);
    return Array.from({ length: steps + 1 }, (_, i) => first * Math.pow(ratio, i));
})();

const common = {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT) || 5431,
    max: 2,
    connectionTimeoutMillis: 10000,
    statement_timeout: 300000,
};
const net = new Pool({
    ...common,
    database: process.env.ROUTING_PGDATABASE || 'your_db',
    user: process.env.ROUTING_PGUSER || process.env.PGUSER,
    password: process.env.ROUTING_PGPASSWORD || process.env.PGPASSWORD,
});
const db = new Pool({
    ...common,
    database: process.env.PGDATABASE || 'transport',
    user: process.env.PGW_USER,
    password: process.env.PGW_PASSWORD,
});

function parseArgs(argv, defaults) {
    const opts = { ...defaults };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i].replace(/^--/, '');
        if (!(key in defaults)) throw new Error(`Unknown option --${key}`);
        if (typeof defaults[key] === 'boolean') opts[key] = true;
        else opts[key] = typeof defaults[key] === 'number' ? Number(argv[++i]) : argv[++i];
    }
    if (!['hour', 'slot'].includes(opts['entrance-unit'])) throw new Error('--entrance-unit must be hour or slot');
    for (const key of ['alpha', 'beta', 'capacity-share', 'time-limit', 'gap']) {
        if (!(opts[key] > 0)) throw new Error(`--${key} must be a positive number`);
    }
    return opts;
}

// Slot index from Hijri day + 'HH:MM[:SS]'.
function slotOf(day, time) {
    const [h, m] = String(time).split(':').map(Number);
    return (day - FIRST_DAY) * SLOTS_PER_DAY + Math.floor((h * 60 + m) / 15);
}
function slotLabel(slot) {
    const day = FIRST_DAY + Math.floor(slot / SLOTS_PER_DAY);
    const minutes = (slot % SLOTS_PER_DAY) * 15;
    return { hijriDay: day, localTime: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` };
}

// ── Inputs ──────────────────────────────────────────────────────────────────

async function loadInputs() {
    const { rows: [gen] } = await db.query(
        args['generation-run'] > 0
            ? 'SELECT id FROM routing.generation_run WHERE id = $1'
            : 'SELECT id FROM routing.generation_run WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1',
        args['generation-run'] > 0 ? [args['generation-run']] : []);
    if (!gen) throw new Error('No finished generation run; run generate-route-candidates.js first');

    const { rows: plans } = await db.query(`
        SELECT p.id AS plan_id, p.start_point_id AS residence_id, p.entrance_id,
               p.number_of_buses AS buses, pt.code AS plan_type,
               t.start_at_hijri, t.start_at, t.end_at_hijri, t.end_at,
               coalesce(e.capacity, 0) AS entrance_capacity, e.asm_code,
               od.id AS od_pair_id
        FROM public.plans p
        JOIN public.plan_types pt ON pt.id = p.plan_type_id
        JOIN public.timing t      ON t.id = p.timing_id
        JOIN public.entrances e   ON e.id = p.entrance_id
        JOIN routing.od_pair od   ON od.residence_id = p.start_point_id AND od.entrance_id = p.entrance_id
        WHERE p.start_point_type = 'residence' AND p.number_of_buses > 0`);

    const { rows: candidates } = await db.query(`
        SELECT id, od_pair_id, rank, edge_ids, edge_dirs, travel_s
        FROM routing.route_candidate
        WHERE run_id = $1 AND rank >= 1 AND edge_ids IS NOT NULL`, [gen.id]);

    const minDay = Math.min(...plans.map(p => p.start_at_hijri));
    const maxDay = Math.max(...plans.map(p => p.end_at_hijri)) + 1; // trips may run past the window
    const { rows: slotRows } = await db.query(`
        SELECT s.candidate_id, s.hijri_day, s.local_time, s.travel_s
        FROM routing.route_candidate_slot_hijri s
        JOIN routing.route_candidate c ON c.id = s.candidate_id
        WHERE c.run_id = $1 AND s.hijri_day BETWEEN $2 AND $3`, [gen.id, minDay, maxDay]);

    const edgeIds = [...new Set(candidates.flatMap(c => c.edge_ids.map(Number)))];
    const { rows: edges } = await net.query(`
        SELECT e.id, e.highway, e.lanes, e.length_m, c.cost_s, c.reverse_cost_s
        FROM routing.edge e JOIN routing.edge_cost c ON c.id = e.id
        WHERE e.id = ANY($1::bigint[])`, [edgeIds]);

    return { generationRunId: gen.id, plans, candidates, slotRows, edges };
}

// ── Preparation ─────────────────────────────────────────────────────────────

// Buses per 15-min slot at capacity-share 1.
function laneCapacityPerSlot(edge) {
    const lanes = edge.lanes || DEFAULT_LANES[edge.highway] || 1;
    return lanes * PCU_PER_LANE_HOUR / 4 / BUS_PCU;
}

function prepare({ plans, candidates, slotRows, edges }) {
    const edgeById = new Map(edges.map(e => [Number(e.id), e]));

    // Route travel time per departure slot; a missing slot falls back to the
    // candidate's all-day travel time.
    const travel = new Map();                      // candidateId → Map(slot → seconds)
    for (const r of slotRows) {
        const id = Number(r.candidate_id);
        if (!travel.has(id)) travel.set(id, new Map());
        travel.get(id).set(slotOf(r.hijri_day, r.local_time), Number(r.travel_s));
    }

    // Each route as a list of directed edges with the fraction of its base
    // travel time already spent when it enters that edge.
    const routes = new Map();
    for (const c of candidates) {
        const legs = [];
        let total = 0;
        c.edge_ids.forEach((rawId, i) => {
            const e = edgeById.get(Number(rawId));
            const dir = Number(c.edge_dirs[i]);
            const t = e ? Number(dir === 1 ? e.cost_s : e.reverse_cost_s) : 0;
            legs.push({ key: `${rawId}:${dir}`, edge: e, enter: total, t: Math.max(t, 0) });
            total += Math.max(t, 0);
        });
        legs.forEach(l => { l.enterFrac = total ? l.enter / total : 0; });
        routes.set(Number(c.id), {
            id: Number(c.id), odPairId: Number(c.od_pair_id), rank: c.rank, legs,
            allDay: Number(c.travel_s),
            travelAt(slot) { return travel.get(this.id)?.get(slot) ?? this.allDay; },
        });
    }

    const routesByOd = new Map();
    for (const r of routes.values()) {
        if (!routesByOd.has(r.odPairId)) routesByOd.set(r.odPairId, []);
        routesByOd.get(r.odPairId).push(r);
    }

    const planList = [];
    const skipped = [];
    for (const p of plans) {
        const options = routesByOd.get(Number(p.od_pair_id)) || [];
        if (!options.length) { skipped.push({ plan: p.plan_id, reason: 'no candidate routes' }); continue; }
        const first = slotOf(p.start_at_hijri, p.start_at);
        // An end exactly on a slot boundary (08:00) closes the window; 03:59 is inside its slot.
        const [eh, em, es = 0] = String(p.end_at).split(':').map(Number);
        const last = slotOf(p.end_at_hijri, p.end_at) - ((eh * 60 + em) % 15 === 0 && !es ? 1 : 0);
        const slots = [];
        for (let s = first; s <= last; s++) slots.push(s);
        planList.push({
            id: p.plan_id, residence: p.residence_id, entrance: p.entrance_id, asm: p.asm_code,
            entranceCap: Number(p.entrance_capacity), buses: Number(p.buses), type: p.plan_type,
            routes: options.sort((a, b) => a.rank - b.rank), slots,
        });
    }

    // Bundles: directed edges used by exactly the same set of routes carry the
    // same buses, so they share one load variable per slot. Capacity is the
    // bundle's bottleneck; t0 its summed base travel time.
    const routesOnLeg = new Map();
    for (const r of routes.values()) {
        for (const l of r.legs) {
            if (!l.edge) continue;
            if (!routesOnLeg.has(l.key)) routesOnLeg.set(l.key, { edge: l.edge, t: l.t, routes: new Map() });
            routesOnLeg.get(l.key).routes.set(r.id, l.enterFrac);
        }
    }
    const bundles = new Map();
    for (const leg of routesOnLeg.values()) {
        const ids = [...leg.routes.keys()].sort((a, b) => a - b);
        const key = ids.join(',');
        if (!bundles.has(key)) bundles.set(key, { routes: new Map(), capBase: Infinity, t0: 0, length: 0 });
        const b = bundles.get(key);
        b.capBase = Math.min(b.capBase, laneCapacityPerSlot(leg.edge));
        b.cap = b.capBase * modelParams.share;
        b.t0 += leg.t;
        b.length += Number(leg.edge.length_m);
        for (const [rid, frac] of leg.routes) {
            b.routes.set(rid, Math.min(b.routes.get(rid) ?? 1, frac));   // entry point
        }
    }

    // Only bundles that plans could overload need congestion terms: at least
    // two plans can reach them and together carry more than one slot's capacity.
    const plansByRoute = new Map();
    for (const p of planList) for (const r of p.routes) {
        if (!plansByRoute.has(r.id)) plansByRoute.set(r.id, []);
        plansByRoute.get(r.id).push(p);
    }
    const bundleList = [];
    for (const b of bundles.values()) {
        const reach = new Map();
        for (const rid of b.routes.keys()) for (const p of plansByRoute.get(rid) || []) reach.set(p.id, p.buses);
        const potential = [...reach.values()].reduce((a, v) => a + v, 0);
        b.index = bundleList.length;
        b.relevant = reach.size >= 2 && potential > b.cap;
        bundleList.push(b);
    }
    return { planList, skipped, bundleList, routes };
}

// ── Congestion cost ─────────────────────────────────────────────────────────

// Extra bus-seconds on a bundle carrying L buses in one slot (BPR).
function delay(b, L, params = modelParams) {
    if (L <= 0) return 0;
    return L * b.t0 * params.alpha * Math.pow(L / (b.capBase * params.share), params.beta);
}

// ── Evaluation (exact BPR, all bundles) ─────────────────────────────────────

function evaluate(assignments, prep, params = modelParams) {
    // assignments: [{ plan, route, slot, buses }]
    const load = new Map();              // `${bundle}|${slot}` → buses
    const arrivals = new Map();          // `${asm}|${slot}` → buses
    const legBundles = new Map();        // routeId → [{bundle, frac}]
    for (const b of prep.bundleList) for (const [rid, frac] of b.routes) {
        if (!legBundles.has(rid)) legBundles.set(rid, []);
        legBundles.get(rid).push({ b, frac });
    }
    let travelS = 0;
    for (const a of assignments) {
        const T = a.route.travelAt(a.slot);
        travelS += a.buses * T;
        for (const { b, frac } of legBundles.get(a.route.id) || []) {
            const key = `${b.index}|${a.slot + Math.floor(frac * T / SLOT_S)}`;
            load.set(key, (load.get(key) || 0) + a.buses);
        }
        const akey = `${a.plan.asm}|${a.slot + Math.floor(T / SLOT_S)}`;
        arrivals.set(akey, (arrivals.get(akey) || 0) + a.buses);
    }
    let congestionS = 0;
    let overCap = 0;
    let peakRatio = 0;
    for (const [key, L] of load) {
        const b = prep.bundleList[Number(key.split('|')[0])];
        congestionS += delay(b, L, params);
        const ratio = L / (b.capBase * params.share);
        if (ratio > 1) overCap++;
        peakRatio = Math.max(peakRatio, ratio);
    }
    const peakArrivals = {};
    for (const [key, n] of arrivals) {
        const asm = key.split('|')[0];
        peakArrivals[asm] = Math.max(peakArrivals[asm] || 0, n);
    }
    const buses = assignments.reduce((n, a) => n + a.buses, 0);
    return {
        buses,
        travel_bus_hours: +(travelS / 3600).toFixed(1),
        congestion_bus_hours: +(congestionS / 3600).toFixed(1),
        total_bus_hours: +((travelS + congestionS) / 3600).toFixed(1),
        avg_trip_min: +((travelS + congestionS) / buses / 60).toFixed(1),
        bundle_slots_over_capacity: overCap,
        peak_load_to_capacity: +peakRatio.toFixed(2),
        peak_entrance_arrivals_per_slot: peakArrivals,
    };
}

// Fastest route, buses spread as evenly as possible over the window.
function baselineAssignments(prep) {
    const out = [];
    for (const p of prep.planList) {
        const route = p.routes[0];
        const base = Math.floor(p.buses / p.slots.length);
        let extra = p.buses - base * p.slots.length;
        for (const slot of p.slots) {
            const n = base + (extra-- > 0 ? 1 : 0);
            if (n > 0) out.push({ plan: p, route, slot, buses: n });
        }
    }
    return out;
}

// ── MILP ────────────────────────────────────────────────────────────────────

function buildModel(prep, entranceLimit) {
    const obj = [];
    const cons = [];
    const bounds = [];
    const binaries = [];
    const xVars = [];                    // {name, plan, route, slot}
    const loadTerms = new Map();         // `${bundle}|${slot}` → [var]
    const residenceTerms = new Map();    // `${residence}|${slot}` → [var]
    const entranceTerms = new Map();     // `${asm}|${slot}` → {cap, vars}

    const legBundles = new Map();
    for (const b of prep.bundleList) if (b.relevant) for (const [rid, frac] of b.routes) {
        if (!legBundles.has(rid)) legBundles.set(rid, []);
        legBundles.get(rid).push({ b, frac });
    }

    prep.planList.forEach((p, pi) => {
        const yNames = [];
        p.routes.forEach((r, ki) => {
            const y = `y${pi}_${ki}`;
            yNames.push(y);
            binaries.push(y);
            const link = [];
            for (const slot of p.slots) {
                const x = `x${pi}_${ki}_${slot}`;
                const T = r.travelAt(slot);
                xVars.push({ name: x, plan: p, route: r, slot });
                bounds.push(`0 <= ${x} <= ${p.buses}`);
                obj.push(`${(T / 60).toFixed(4)} ${x}`);          // bus-minutes
                link.push(x);
                for (const { b, frac } of legBundles.get(r.id) || []) {
                    const key = `${b.index}|${slot + Math.floor(frac * T / SLOT_S)}`;
                    if (!loadTerms.has(key)) loadTerms.set(key, { vars: [], plans: new Map() });
                    const term = loadTerms.get(key);
                    term.vars.push(x);
                    term.plans.set(pi, p.buses);
                }
                const rkey = `${p.residence}|${slot}`;
                if (!residenceTerms.has(rkey)) residenceTerms.set(rkey, []);
                residenceTerms.get(rkey).push(x);
                const ekey = `${p.asm}|${slot + Math.floor(T / SLOT_S)}`;
                if (!entranceTerms.has(ekey)) entranceTerms.set(ekey, { limit: entranceLimit(p), vars: [] });
                entranceTerms.get(ekey).vars.push(x);
            }
            cons.push(`link${pi}_${ki}: ${link.join(' + ')} - ${p.buses} ${y} = 0`);
        });
        cons.push(`one${pi}: ${yNames.join(' + ')} = 1`);
    });

    // Congestion: load above the first breakpoint is split into segments whose
    // cost per bus rises with load. Only (bundle, slot) pairs that the plans able
    // to reach them could push past the first breakpoint get a row.
    let zCount = 0;
    let loadRows = 0;
    for (const [key, { vars, plans }] of loadTerms) {
        const b = prep.bundleList[Number(key.split('|')[0])];
        let potential = 0;
        for (const n of plans.values()) potential += n;
        if (potential <= BREAKS[0] * b.cap) continue;
        loadRows++;
        const segs = [];
        for (let i = 1; i < BREAKS.length; i++) {
            const lo = BREAKS[i - 1] * b.cap;
            const hi = BREAKS[i] * b.cap;
            const slope = (delay(b, hi) - delay(b, lo)) / (hi - lo) / 60;   // bus-minutes per bus
            const z = `z${zCount++}`;
            segs.push(z);
            bounds.push(`0 <= ${z} <= ${(hi - lo).toFixed(3)}`);
            if (slope > 1e-6) obj.push(`${slope.toFixed(5)} ${z}`);
        }
        // Beyond the last breakpoint: the steepest slope, doubled, unbounded.
        const hi = BREAKS[BREAKS.length - 1] * b.cap;
        const tail = `z${zCount++}`;
        segs.push(tail);
        obj.push(`${(2 * (delay(b, hi) - delay(b, hi * 0.9)) / (hi * 0.1) / 60).toFixed(5)} ${tail}`);
        cons.push(`load_${key.replace('|', '_')}: ${vars.join(' + ')} - ${segs.join(' - ')} <= ${(BREAKS[0] * b.cap).toFixed(3)}`);
    }

    // Loading bays: at most --residence-max buses leave a residence per slot,
    // unless its plans could not fit even spread evenly over their windows:
    // then the even spread of all its plans in that slot is the limit.
    const evenNeed = new Map();          // `${residence}|${slot}` → buses per slot at an even spread
    for (const p of prep.planList) {
        for (const slot of p.slots) {
            const key = `${p.residence}|${slot}`;
            evenNeed.set(key, (evenNeed.get(key) || 0) + p.buses / p.slots.length);
        }
    }
    let raised = 0;
    for (const [key, vars] of residenceTerms) {
        const need = Math.ceil((evenNeed.get(key) || 0) - 1e-9);
        const limit = Math.max(args['residence-max'], need);
        if (limit > args['residence-max']) raised++;
        cons.push(`res_${cons.length}: ${vars.join(' + ')} <= ${limit}`);
    }
    console.log(`residence limit ${args['residence-max']} per slot; raised to the even-spread need in ${raised} of ${residenceTerms.size} residence-slots`);

    // Entrance arrivals per slot, softened so a tight entrance never makes the
    // model infeasible. The cost per bus over the limit rises with each tier of
    // overflow, up to 8× the limit: with a flat price (or tiers that stop short
    // of the real overflow — some entrances get several times their capacity),
    // an entrance already over its limit cost the same however its overflow was
    // bunched, and the solver piled it into a few slots. The steps are gentle on
    // purpose: doubling prices up to 38,400 bus-min left the solver without a
    // first solution in 5 minutes; only the rise matters, not its steepness.
    let sCount = 0;
    const OVERFLOW = [                                             // [share of limit, bus-min per bus]
        [0.25, 600], [0.25, 800], [0.5, 1000], [1, 1200], [2, 1400], [4, 1600], [null, 1800],
    ];
    for (const [, { limit, vars }] of entranceTerms) {
        const parts = OVERFLOW.map(([share, cost]) => {
            const sv = `s${sCount++}`;
            obj.push(`${cost} ${sv}`);
            if (share !== null) bounds.push(`0 <= ${sv} <= ${(share * limit).toFixed(3)}`);
            return sv;
        });
        cons.push(`ent_${cons.length}: ${vars.join(' + ')} - ${parts.join(' - ')} <= ${limit}`);
    }

    // LP files are line based; long sums are wrapped rather than written as one line.
    const wrap = (text) => text.replace(/((?:\S+\s+){40})/g, '$1\n   ');
    const lp = [
        'Minimize',
        wrap(` obj: ${obj.join(' + ')}`),
        'Subject To',
        ...cons.map(c => wrap(` ${c}`)),
        'Bounds',
        ...bounds.map(b => ` ${b}`),
        'Binaries',
        wrap(` ${binaries.join(' ')}`),
        'End',
    ].join('\n');
    return { lp, xVars, stats: { x: xVars.length, y: binaries.length, z: zCount, entranceSlack: sCount, rows: cons.length, loadRows, loadCandidates: loadTerms.size } };
}

// ── Solving ─────────────────────────────────────────────────────────────────

function nativeHighs() {
    const candidates = [process.env.HIGHS_BIN, '/opt/homebrew/bin/highs', '/usr/local/bin/highs', '/usr/bin/highs'];
    return candidates.find(p => p && fs.existsSync(p)) || null;
}

// Returns { engine, status, objective, gap, values: Map(name → value) }.
async function solve(lp) {
    const bin = nativeHighs();
    if (bin) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimize-routes-'));
        const model = path.join(dir, 'model.lp');
        const solution = path.join(dir, 'model.sol');
        const options = path.join(dir, 'highs.opt');
        fs.writeFileSync(model, lp);
        fs.writeFileSync(options, `mip_rel_gap = ${args.gap}\ntime_limit = ${args['time-limit']}\n` +
                                  `log_file = ${path.join(dir, 'highs.log')}\n`);
        let log = '';
        try {
            log = execFileSync(bin, [
                '--model_file', model, '--solution_file', solution, '--options_file', options,
            ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        } catch (err) {
            log = String(err.stdout || '') + String(err.stderr || '');
            if (!fs.existsSync(solution)) throw new Error(`highs failed:\n${log.slice(-2000)}`);
        }
        const text = fs.readFileSync(solution, 'utf8');
        fs.rmSync(dir, { recursive: true, force: true });
        const status = (text.match(/Model status\s*\n\s*(.+)/) || [])[1]?.trim() || 'unknown';
        const objective = Number((text.match(/Objective\s+(\S+)/) || [])[1]);
        const gapMatch = log.match(/Gap\s+([\d.]+%|inf)/g);
        const values = new Map();
        const start = text.indexOf('# Columns');
        const end = text.indexOf('# Rows', start);
        text.slice(start, end).split('\n').slice(1).forEach(line => {
            const [name, value] = line.trim().split(/\s+/);
            if (name && value !== undefined) values.set(name, Number(value));
        });
        return { engine: 'native', status, objective, gap: gapMatch ? gapMatch[gapMatch.length - 1].split(/\s+/)[1] : null, values };
    }
    const highs = await require('highs')({});
    const r = highs.solve(lp, { time_limit: args['time-limit'], mip_rel_gap: args.gap, output_flag: false });
    const values = new Map(Object.entries(r.Columns || {}).map(([k, v]) => [k, v.Primal]));
    return { engine: 'wasm', status: r.Status, objective: r.ObjectiveValue, gap: null, values };
}

// Continuous buses per slot → whole buses, per plan, keeping each plan's total
// (largest remainders first).
function roundDispatch(xVars, values) {
    const byPlan = new Map();
    for (const v of xVars) {
        const val = values.get(v.name) || 0;
        if (val <= 1e-6) continue;
        if (!byPlan.has(v.plan)) byPlan.set(v.plan, []);
        byPlan.get(v.plan).push({ ...v, val });
    }
    const out = [];
    for (const [plan, list] of byPlan) {
        // One route per plan: the solver picks it through y; keep the route with most buses.
        const perRoute = new Map();
        list.forEach(v => perRoute.set(v.route, (perRoute.get(v.route) || 0) + v.val));
        const route = [...perRoute.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const slots = list.filter(v => v.route === route);
        const scale = plan.buses / slots.reduce((n, v) => n + v.val, 0);
        const parts = slots.map(v => ({ v, exact: v.val * scale, n: Math.floor(v.val * scale) }));
        let left = plan.buses - parts.reduce((n, p) => n + p.n, 0);
        parts.sort((a, b) => (b.exact - b.n) - (a.exact - a.n));
        for (const part of parts) { if (left <= 0) break; part.n++; left--; }
        parts.filter(p => p.n > 0).forEach(p => out.push({ plan, route, slot: p.v.slot, buses: p.n }));
    }
    return out;
}

// ── Scoring saved runs ──────────────────────────────────────────────────────

async function scoreRuns(prep) {
    const runIds = String(args['score-runs']).split(',').map(Number).filter(Boolean);
    const models = String(args['score-models'] || `${args.beta}:${args['capacity-share']}`).split(',').map(m => {
        const [beta, share] = m.split(':').map(Number);
        return { label: `β${beta} share ${share}`, params: { alpha: args.alpha, beta, share } };
    });
    const planById = new Map(prep.planList.map(p => [p.id, p]));
    const scenarios = [['baseline', baselineAssignments(prep)]];
    for (const id of runIds) {
        const { rows } = await db.query(`
            SELECT plan_id, candidate_id, hijri_day, local_time::text AS local_time, buses
            FROM routing.plan_dispatch WHERE run_id = $1 AND scenario = 'optimized'`, [id]);
        const { rows: [meta] } = await db.query('SELECT params FROM routing.optimization_run WHERE id = $1', [id]);
        const list = rows.map(r => ({
            plan: planById.get(r.plan_id), route: prep.routes.get(Number(r.candidate_id)),
            slot: slotOf(r.hijri_day, r.local_time), buses: r.buses,
        })).filter(a => a.plan && a.route);
        scenarios.push([`run ${id} (β${meta.params.beta} share ${meta.params['capacity-share']})`, list]);
    }
    const total = {};
    const peak = {};
    for (const [name, list] of scenarios) {
        total[name] = {};
        peak[name] = {};
        for (const m of models) {
            const k = evaluate(list, prep, m.params);
            total[name][m.label] = k.total_bus_hours;
            peak[name][m.label] = k.peak_load_to_capacity;
        }
    }
    console.log('Total bus-hours, plan (rows) scored under congestion model (columns):');
    console.table(total);
    console.log('Peak load / capacity:');
    console.table(peak);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const t0 = Date.now();
    const inputs = await loadInputs();
    const prep = prepare(inputs);
    if (args['score-runs']) return scoreRuns(prep);
    const relevant = prep.bundleList.filter(b => b.relevant).length;
    console.log(`generation run ${inputs.generationRunId}: ${prep.planList.length} plans, ` +
                `${prep.routes.size} routes, ${prep.bundleList.length} road bundles (${relevant} can be overloaded)`);
    prep.skipped.slice(0, 10).forEach(s => console.log(`  skipped plan ${s.plan}: ${s.reason}`));

    const baseline = baselineAssignments(prep);
    const baselineKpis = evaluate(baseline, prep);
    console.log('baseline  (fastest route, buses spread evenly):', JSON.stringify(baselineKpis));
    const sameYardstick = JSON.stringify(evalParams) === JSON.stringify(modelParams);

    // Entrance limit per slot: the configured capacity where one is set, else the
    // busiest slot the baseline gives it.
    const entranceLimit = (p) => p.entranceCap > 0
        ? (args['entrance-unit'] === 'hour' ? p.entranceCap / 4 : p.entranceCap)
        : baselineKpis.peak_entrance_arrivals_per_slot[p.asm];
    const model = buildModel(prep, entranceLimit);
    console.log(`model: ${JSON.stringify(model.stats)}, ${(model.lp.length / 1e6).toFixed(1)} MB LP`);

    const solveStart = Date.now();
    const result = await solve(model.lp);
    const solveSeconds = (Date.now() - solveStart) / 1000;
    console.log(`solver (${result.engine}): ${result.status} in ${solveSeconds.toFixed(0)} s, ` +
                `objective ${Math.round(result.objective)} bus-min, gap ${result.gap ?? '?'}`);
    // "Time limit reached" is only usable if the solver found a solution by then.
    if (!result.values || !result.values.size || !Number.isFinite(result.objective)
        || !['Optimal', 'Time limit reached', 'Solution limit reached'].includes(result.status)) {
        throw new Error(`No usable solution (${result.status}, objective ${result.objective}); nothing saved`);
    }
    const optimized = roundDispatch(model.xVars, result.values);
    const optimizedKpis = evaluate(optimized, prep);
    const changedRoute = prep.planList.filter(p => {
        const used = optimized.find(a => a.plan === p);
        return used && used.route !== p.routes[0];
    }).length;
    optimizedKpis.plans_not_on_fastest_route = changedRoute;
    console.log('optimized:', JSON.stringify(optimizedKpis));
    if (!sameYardstick) {
        baselineKpis.reference = evaluate(baseline, prep, evalParams);
        optimizedKpis.reference = evaluate(optimized, prep, evalParams);
        const pick = k => ({ total: k.total_bus_hours, congestion: k.congestion_bus_hours, over: k.bundle_slots_over_capacity, peak: k.peak_load_to_capacity });
        console.log(`reference model ${JSON.stringify(evalParams)}: baseline ${JSON.stringify(pick(baselineKpis.reference))}, ` +
                    `optimized ${JSON.stringify(pick(optimizedKpis.reference))}`);
    }

    if (args['dry-run']) return;

    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const { rows: [run] } = await client.query(`
            INSERT INTO routing.optimization_run (generation_run_id, params, solver_status, mip_gap, solve_seconds,
                                                  baseline_kpis, optimized_kpis, finished_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp()) RETURNING id`,
            [inputs.generationRunId, args, result.status,
             result.gap && result.gap.endsWith('%') ? Number(result.gap.slice(0, -1)) / 100 : null, solveSeconds,
             baselineKpis, optimizedKpis]);
        for (const [scenario, list] of [['baseline', baseline], ['optimized', optimized]]) {
            const rows = list.map(a => ({ ...a, ...slotLabel(a.slot) }));
            for (let i = 0; i < rows.length; i += 2000) {
                const chunk = rows.slice(i, i + 2000);
                await client.query(`
                    INSERT INTO routing.plan_dispatch (run_id, scenario, plan_id, candidate_id, hijri_day, local_time, buses, travel_s)
                    SELECT $1, $2, u.plan_id, u.candidate_id, u.hijri_day, u.local_time::time, u.buses, u.travel_s
                    FROM unnest($3::uuid[], $4::bigint[], $5::smallint[], $6::text[], $7::int[], $8::float8[])
                         AS u(plan_id, candidate_id, hijri_day, local_time, buses, travel_s)`,
                    [run.id, scenario, chunk.map(a => a.plan.id), chunk.map(a => a.route.id),
                     chunk.map(a => a.hijriDay), chunk.map(a => a.localTime), chunk.map(a => a.buses),
                     chunk.map(a => a.route.travelAt(a.slot))]);
            }
        }
        await client.query('COMMIT');
        console.log(`Saved as optimization run ${run.id} (${((Date.now() - t0) / 1000).toFixed(0)} s total)`);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

main()
    .catch(err => { console.error(err); process.exitCode = 1; })
    .finally(() => Promise.all([net.end(), db.end()]));
