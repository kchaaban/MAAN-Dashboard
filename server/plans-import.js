// Service-centre plan import.
//
// A centre-scoped user imports their own centre; a company-scoped user imports
// any centre under their own company, picked by the office number named in the
// files; an admin imports any centre in the system, picked by company name +
// office number named in the files. In all cases the uploader is a single
// service centre's worth of four CSV files describing its allocation:
//   1. assign_camp_users  camp_label, service_company_name, office_number,
//                         nationality, service_center_name, piligrim_type,
//                         number_of_piligrim         -> assign_camps rows
//   2. assign_residences  License Number, Name, Pilgrims_count, Service_company,
//                         Service_center_name, Service_center_number,
//                         Tarwiyah_count, Taseed_count   -> assign_residences rows
//   3. PeriodPreferences  camp_label, MAKMINT1..3, MAKARFT1..3, ...,
//                         MAKMIN Count, MAKARF Count   -> per-period pilgrim
//                         splits that drive plan generation
//   4. mashaers_trips     bus id, service_company_name, service_center_number,
//                         transport_type, tc_name_ar  -> mashaers_trips rows: the
//                         buses dispatched to the centre, one row per bus with
//                         the transport company supplying it; also gives the
//                         centre's dominant transport type used above
//
// analyze() parses, resolves foreign keys and reports what would happen without
// writing anything. commit() runs the same resolution inside a transaction,
// replaces the centre's existing assign_camps / assign_residences / mashaers_trips and
// its plans of the four generated phases, inserts the fresh assignments and
// generates:
//
//   tarwia         residence (Makkah) -> camp in Mina,   entrance ASMMIN*
//   direct_taseed  residence (Makkah) -> camp in Arafat, entrance ASMARF*
//   taseed_tarwia  Mina camp -> its paired Arafat camp (same label), one plan
//                  per (Mina camp, period) carrying that period's tarwia total
//   efada          Arafat camp -> Muzdalifah drop-off area, three plans per camp
//                  (periods 1/2/3 at 45/35/20% of everyone who arrived there)
//
// Only the residence->entrance leg is routed (routing.js); every other leg uses
// the camp's predefined paths (camps.path_entrance_id / path_camp_id /
// path_dropoff_id) and the camp's drop-off area (camps.drop_off_area_id).
// Parking is not in any file: the centre's existing plans supply it, one
// (get, set) pair per transport type.

const crypto = require('crypto');
const { pool, writePool, invalidate } = require('./db');
const routing = require('./routing');

const BUS_CAPACITY = Number(process.env.BUS_CAPACITY) || 45;

// The phases an import regenerates; a centre's plans of any other type survive.
const GENERATED_PLAN_TYPES = ['tarwia', 'direct_taseed', 'taseed_tarwia', 'efada'];

// efada leaves Arafat in all three periods at this fixed split of the camp's
// arrivals -- the ratio every legacy efada plan follows.
const EFADA_PERIOD_SHARES = [
    { period: 1, weight: 45 },
    { period: 2, weight: 35 },
    { period: 3, weight: 20 },
];

const ADMIN_TYPES = ['system_admin', 'transport_authority'];
const ADMIN_FALLBACK_ROLES = ['Administrator', 'Operations Manager'];
const isAdmin = (user) =>
    ADMIN_TYPES.includes(user.typeCode) || ADMIN_FALLBACK_ROLES.includes(user.role);

// A centre user imports their own centre; a company user may import on behalf
// of any of their own company's centres, named by office number in the files;
// an admin may import on behalf of any centre named in the files.
function mayImport(user) {
    return isAdmin(user)
        || (user.scope && (user.scope.kind === 'center' || user.scope.kind === 'company'));
}

// ---------------------------------------------------------------- CSV parsing

// Minimal RFC-4180-ish parser: quoted fields, escaped quotes, CRLF, BOM.
function parseCsv(text) {
    if (typeof text !== 'string') return [];
    const src = text.replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
            continue;
        }
        if (ch === '"') { inQuotes = true; continue; }
        if (ch === ',') { row.push(field); field = ''; continue; }
        if (ch === '\r') continue;
        if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

function rowsToObjects(text) {
    const rows = parseCsv(text).filter((r) => r.some((c) => String(c).trim() !== ''));
    if (rows.length < 1) return [];
    const headers = rows[0].map((h) => String(h).trim());
    return rows.slice(1).map((cells) => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = cells[i] !== undefined ? String(cells[i]).trim() : ''; });
        return obj;
    });
}

// Case/space-insensitive field lookup so minor header drift does not break import.
function pick(obj, ...names) {
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
    const map = {};
    for (const key of Object.keys(obj)) map[norm(key)] = obj[key];
    for (const name of names) {
        const v = map[norm(name)];
        if (v !== undefined) return v;
    }
    return '';
}

function toInt(value) {
    if (value === null || value === undefined) return 0;
    const n = Number(String(value).replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// ---------------------------------------------------------------- normalization

function normalizeInputs(files) {
    const f = files || {};
    const assignCampUsers = rowsToObjects(f.assignCampUsers || '').map((r) => ({
        camp_label: pick(r, 'camp_label'),
        company_name: pick(r, 'service_company_name', 'service_compnay_name'),
        office_number: pick(r, 'office_number', 'service_center_number'),
        nationality: pick(r, 'nationality'),
        center_name: pick(r, 'service_center_name'),
        piligrim_type: pick(r, 'piligrim_type', 'pilgrim_type'),
        count: toInt(pick(r, 'number_of_piligrim', 'number_of_pilgrim', 'number_of_piligrims')),
    })).filter((r) => r.camp_label);

    const assignResidences = rowsToObjects(f.assignResidences || '').map((r) => ({
        license_number: pick(r, 'License Number', 'license_number'),
        name: pick(r, 'Name', 'name'),
        pilgrims_count: toInt(pick(r, 'Pilgrims_count', 'pilgrims_count')),
        company_name: pick(r, 'Service_company', 'service_company'),
        center_name: pick(r, 'Service_center_name'),
        office_number: pick(r, 'Service_center_number', 'service_center_number'),
        tarwiyah_count: toInt(pick(r, 'Tarwiyah_count', 'tarwiyah_count', 'tarwia')),
        taseed_count: toInt(pick(r, 'Taseed_count', 'taseed_count', 'direct_taseed')),
    })).filter((r) => r.license_number);

    const periodPreferences = rowsToObjects(f.periodPreferences || '').map((r) => ({
        camp_label: pick(r, 'camp_label'),
        company_name: pick(r, 'service_compnay_name', 'service_company_name'),
        office_number: pick(r, 'service_center_number'),
        makmin: [1, 2, 3].map((n) => toInt(pick(r, `MAKMINT${n}`))),
        makarf: [1, 2, 3].map((n) => toInt(pick(r, `MAKARFT${n}`))),
        makmin_total: toInt(pick(r, 'MAKMIN Count')),
        makarf_total: toInt(pick(r, 'MAKARF Count')),
    })).filter((r) => r.camp_label);

    const mashaersTrips = rowsToObjects(f.mashaersTrips || '').map((r) => ({
        bus_id: pick(r, 'bus_id', 'bus id', 'bus_number', 'bus_no', 'bus', 'plate_number', 'plate') || null,
        company_name: pick(r, 'service_company_name'),
        office_number: pick(r, 'service_center_number'),
        transport_type: pick(r, 'transport_type'),
        transport_company_ar: pick(r, 'tc_name_ar'),
    }));

    return { assignCampUsers, assignResidences, periodPreferences, mashaersTrips };
}

// ---------------------------------------------------------------- resolution

async function resolveCenter(client, parsed, user) {
    // A centre-scoped user always imports their own centre.
    if (user.scope && user.scope.kind === 'center') {
        const { rows } = await client.query(
            'SELECT id, company_id, center_name, office_number FROM service_centers WHERE id = $1',
            [user.scope.id]
        );
        if (!rows.length) return { error: 'Your account is not linked to a known service centre.' };
        return { center: rows[0] };
    }

    // A company-scoped user resolves the centre from the files, but only among
    // their own company's centres — the office number picks which one, the
    // company itself is fixed by the session, not by whatever the file claims.
    if (user.scope && user.scope.kind === 'company') {
        const sample =
            parsed.assignCampUsers[0] || parsed.assignResidences[0] || parsed.periodPreferences[0];
        if (!sample || !sample.office_number) {
            return { error: 'Files do not identify a service centre number.' };
        }
        const { rows } = await client.query(
            `SELECT id, company_id, center_name, office_number FROM service_centers
             WHERE company_id = $1 AND office_number = $2`,
            [user.scope.id, String(sample.office_number)]
        );
        if (!rows.length) {
            return { error: `No service centre with office number ${sample.office_number} under your company.` };
        }
        const warnings = rows.length > 1
            ? [`Multiple centres matched office number under your company; used the first (${rows[0].id}).`]
            : [];
        return { center: rows[0], warnings };
    }

    // Admins resolve the centre from the files (company name + office number).
    const sample =
        parsed.assignCampUsers[0] || parsed.assignResidences[0] || parsed.periodPreferences[0];
    if (!sample || !sample.company_name || !sample.office_number) {
        return { error: 'Files do not identify a service company and centre number.' };
    }
    const { rows } = await client.query(
        `SELECT sc.id, sc.company_id, sc.center_name, sc.office_number
         FROM service_centers sc JOIN service_companies c ON sc.company_id = c.id
         WHERE c.name = $1 AND sc.office_number = $2`,
        [sample.company_name, String(sample.office_number)]
    );
    if (!rows.length) {
        return { error: `No service centre for company "${sample.company_name}" office ${sample.office_number}.` };
    }
    const warnings = rows.length > 1
        ? [`Multiple centres matched company/office; used the first (${rows[0].id}).`]
        : [];
    return { center: rows[0], warnings };
}

// camp_label -> { mina: {...}, arafat: {...} } with entrance coordinates + internal path.
async function loadCampMap(client, labels) {
    if (!labels.length) return new Map();
    // Destination coordinates come straight from the entrances table. A few
    // entrances have null lon/lat but a valid polygon, so fall back to the
    // polygon centroid — still the entrance's own geometry.
    const { rows } = await client.query(
        `SELECT c.id, c.name, pl.code AS platform, c.entrance_id, c.path_entrance_id,
                c.path_camp_id, c.path_dropoff_id, c.drop_off_area_id,
                e.asm_code,
                COALESCE(e.longitude, ST_X(ST_Centroid(e.gis))) AS longitude,
                COALESCE(e.latitude,  ST_Y(ST_Centroid(e.gis))) AS latitude
         FROM camps c
         JOIN platforms pl ON c.platform_id = pl.id
         LEFT JOIN entrances e ON c.entrance_id = e.id
         WHERE c.name = ANY($1)`,
        [labels]
    );
    const map = new Map();
    for (const r of rows) {
        if (!map.has(r.name)) map.set(r.name, {});
        map.get(r.name)[r.platform] = r;
    }
    return map;
}

async function loadResidenceMap(client, licenses) {
    if (!licenses.length) return new Map();
    const { rows } = await client.query(
        'SELECT id, license_number, longitude, latitude FROM residences WHERE license_number = ANY($1)',
        [licenses]
    );
    return new Map(rows.map((r) => [r.license_number, r]));
}

async function loadCountryMap(client, names) {
    if (!names.length) return new Map();
    const { rows } = await client.query(
        'SELECT id, name_ar FROM countries WHERE name_ar = ANY($1)',
        [names]
    );
    return new Map(rows.map((r) => [r.name_ar, r.id]));
}

// The centre's parking choice is not in any CSV: its existing plans carry one
// (get, set) parking pair per transport type. Read it here -- before commit()
// deletes those plans -- most common pair first, with an any-type fallback.
async function loadCenterParking(client, centerId) {
    const { rows } = await client.query(
        `SELECT transport_type_id, get_parking_id, get_type_parking, set_parking_id, set_type_parking,
                count(*) AS n
         FROM plans
         WHERE owner_id = $1 AND get_parking_id IS NOT NULL
         GROUP BY 1, 2, 3, 4, 5
         ORDER BY n DESC`,
        [centerId]
    );
    const byTransport = new Map();
    for (const r of rows) {
        const parking = {
            get_parking_id: r.get_parking_id, get_type_parking: r.get_type_parking,
            set_parking_id: r.set_parking_id, set_type_parking: r.set_type_parking,
        };
        if (r.transport_type_id && !byTransport.has(r.transport_type_id)) byTransport.set(r.transport_type_id, parking);
        if (!byTransport.has('any')) byTransport.set('any', parking);
    }
    return byTransport;
}

async function loadLookups(client) {
    const types = await client.query('SELECT id, code FROM plan_types');
    const transport = await client.query('SELECT id, name FROM transport_types');
    const periods = await client.query('SELECT id, code, name FROM periods ORDER BY created_at NULLS FIRST, name');
    const planTypeIds = Object.fromEntries(types.rows.map((r) => [r.code, r.id]));
    const transportByName = new Map(transport.rows.map((r) => [r.name, r.id]));

    // Period number (1..4) -> period id. The rows carry codes; sort order alone
    // would put "third" before "second" (Arabic names sort that way).
    const PERIOD_CODES = { first: 1, second: 2, third: 3, fourth: 4 };
    const periodIdByNumber = {};
    periods.rows.forEach((r, i) => {
        const n = PERIOD_CODES[String(r.code || '').toLowerCase()] || (i + 1);
        if (!periodIdByNumber[n]) periodIdByNumber[n] = r.id;
    });

    // timing id per (plan_type_id, period number), ordered by start time.
    const timing = await client.query(
        `SELECT id, plan_type_id, period_id FROM timing ORDER BY plan_type_id, start_at`
    );
    const timingByTypePeriod = new Map();
    for (const t of timing.rows) {
        timingByTypePeriod.set(`${t.plan_type_id}:${t.period_id}`, t.id);
    }

    // Round-trip multiplier per (plan_type_id, transport_type_id): trips per bus.
    // Some (type, transport) pairs have several rows: the most recently updated
    // value is the configured one and older rows are superseded. Only rows that
    // disagree at that same latest timestamp are a real conflict worth flagging.
    const rt = await client.query(
        'SELECT plan_type_id, transport_type_id, round_trip, updated_at FROM round_trips ORDER BY updated_at'
    );
    const roundTripByTypeTransport = new Map();
    const roundTripConflicts = new Map();
    const latestStamp = new Map();
    for (const row of rt.rows) {
        const n = Number(row.round_trip);
        if (!(Number.isFinite(n) && n > 0)) continue;
        const key = `${row.plan_type_id}:${row.transport_type_id}`;
        const stamp = String(row.updated_at);
        if (latestStamp.get(key) !== stamp) {
            latestStamp.set(key, stamp);
            roundTripConflicts.delete(key);
        } else if (roundTripByTypeTransport.get(key) !== n) {
            roundTripConflicts.set(key, [...new Set([...(roundTripConflicts.get(key) || [roundTripByTypeTransport.get(key)]), n])]);
        }
        roundTripByTypeTransport.set(key, n);
    }
    return { planTypeIds, transportByName, periodIdByNumber, timingByTypePeriod, roundTripByTypeTransport, roundTripConflicts };
}

// Build everything both analyze() and commit() need. No writes, no routing calls.
async function resolve(client, parsed, user) {
    const warnings = [];
    const unmatched = { camps: new Set(), residences: new Set(), countries: new Set() };

    const centerRes = await resolveCenter(client, parsed, user);
    if (centerRes.error) return { error: centerRes.error };
    const center = centerRes.center;
    if (centerRes.warnings) warnings.push(...centerRes.warnings);

    const campLabels = [...new Set([
        ...parsed.assignCampUsers.map((r) => r.camp_label),
        ...parsed.periodPreferences.map((r) => r.camp_label),
    ])];
    const licenses = [...new Set(parsed.assignResidences.map((r) => r.license_number))];
    const nationalities = [...new Set(parsed.assignCampUsers.map((r) => r.nationality).filter(Boolean))];

    // One shared client, so the lookups run one after another: pg queues
    // parallel queries on a single client and deprecates doing so.
    const campMap = await loadCampMap(client, campLabels);
    const residenceMap = await loadResidenceMap(client, licenses);
    const countryMap = await loadCountryMap(client, nationalities);
    const lookups = await loadLookups(client);
    const centerParking = await loadCenterParking(client, center.id);

    // Dominant transport type from the mashaers file.
    let transportTypeId = null;
    if (parsed.mashaersTrips.length) {
        const counts = {};
        for (const t of parsed.mashaersTrips) {
            if (t.transport_type) counts[t.transport_type] = (counts[t.transport_type] || 0) + 1;
        }
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        if (top) transportTypeId = lookups.transportByName.get(top[0]) || null;
    }

    // mashaers_trips rows for this centre, resolved against transport_types.
    const mashaersTrips = parsed.mashaersTrips.map((t) => ({
        bus_id: t.bus_id,
        transport_type_id: t.transport_type ? (lookups.transportByName.get(t.transport_type) || null) : null,
        transport_company_name_ar: t.transport_company_ar || null,
    }));

    // assign_camps specs (pilgrim allocation per camp). Canonical camp = Mina row
    // when present, else any platform row for that label.
    const assignCamps = [];
    for (const r of parsed.assignCampUsers) {
        const entry = campMap.get(r.camp_label);
        const camp = entry && (entry.mina || entry.arafat || Object.values(entry)[0]);
        if (!camp) { unmatched.camps.add(r.camp_label); continue; }
        const countryId = r.nationality ? countryMap.get(r.nationality) : null;
        if (r.nationality && !countryId) unmatched.countries.add(r.nationality);
        assignCamps.push({
            camp_id: camp.id,
            haj_count: r.count,
            country_id: countryId || null,
            piligrim_type: r.piligrim_type || null,
            transport_type_id: transportTypeId,
        });
    }

    // assign_residences specs (residences with tarwia/taseed splits).
    const assignResidences = [];
    for (const r of parsed.assignResidences) {
        const res = residenceMap.get(r.license_number);
        if (!res) { unmatched.residences.add(r.license_number); continue; }
        assignResidences.push({
            residence_id: res.id,
            haj_count: String(r.pilgrims_count),
            tarwia: String(r.tarwiyah_count),
            direct_taseed: String(r.taseed_count),
        });
    }

    // ---- Plan generation (per residence) ----------------------------------
    // Each residence gets its own routed plan(s), from its own coordinates,
    // split across every (camp, period) the centre's PeriodPreferences file
    // names for that phase — not just the single largest one. All of a centre's
    // residences feed the same set of tarwia targets (Mina camps/periods) and
    // the same set of direct_taseed targets (Arafat camps/periods).
    const planIssues = new Set();

    // Every (camp, period) target for a phase, one per nonzero period column
    // across every PeriodPreferences row, weighted by that column's count so a
    // residence's phase total can be split proportionally across all of them.
    function phaseTargets(totalKey, arrKey, platform, phaseLabel) {
        const targets = [];
        for (const pref of parsed.periodPreferences) {
            if (pref[totalKey] <= 0) continue;
            const entry = campMap.get(pref.camp_label);
            if (!entry) { unmatched.camps.add(pref.camp_label); continue; }
            const camp = entry[platform];
            if (!camp) { planIssues.add(`${pref.camp_label}: no ${platform} camp`); continue; }
            if (!(Number.isFinite(camp.longitude) && Number.isFinite(camp.latitude))) {
                planIssues.add(`${pref.camp_label}: no ${platform} entrance coordinates`); continue;
            }
            pref[arrKey].forEach((weight, i) => {
                if (weight > 0) targets.push({ camp, period: i + 1, weight });
            });
        }
        if (!targets.length) return [];
        if (targets.length > 1) {
            warnings.push(
                `${targets.length} ${phaseLabel} targets in preferences ` +
                `(${targets.map((t) => `${t.camp.name}/P${t.period}`).join(', ')}); ` +
                'each residence\'s count split proportionally across them.'
            );
        }
        return targets;
    }

    const tarwiaTargets = phaseTargets('makmin_total', 'makmin', 'mina', 'tarwia');
    const taseedTargets = phaseTargets('makarf_total', 'makarf', 'arafat', 'direct_taseed');

    // Split `haj` across `targets` proportionally to their weight, as whole
    // numbers that sum back to `haj` exactly (largest-remainder method).
    function allocate(haj, targets) {
        const totalWeight = targets.reduce((s, t) => s + t.weight, 0);
        if (!haj || totalWeight <= 0) return targets.map(() => 0);
        const raw = targets.map((t) => (haj * t.weight) / totalWeight);
        const shares = raw.map(Math.floor);
        let remaining = haj - shares.reduce((s, v) => s + v, 0);
        const order = raw
            .map((v, i) => ({ i, frac: v - shares[i] }))
            .sort((a, b) => b.frac - a.frac);
        for (let k = 0; k < remaining; k++) shares[order[k % order.length].i]++;
        return shares;
    }

    const NO_PARKING = { get_parking_id: null, get_type_parking: null, set_parking_id: null, set_type_parking: null };
    const parkingFor = (tt) => centerParking.get(tt) || centerParking.get('any') || NO_PARKING;
    if (!centerParking.size) planIssues.add('Centre has no existing plans with parking; parking left empty');

    const planSpecs = [];
    // One plan row. `start`/`end` are { type, id }; `camp` is the Arafat/Mina
    // camp the row is about (for grouping and messages); `origin_ll`/`entrance_ll`
    // are set only on legs that get routed (residence -> entrance).
    function makeSpec(code, { start, end, camp, entrance_id, path_id, period, haj, origin_ll = null, entrance_ll = null }) {
        if (haj <= 0) return null;
        const planTypeId = lookups.planTypeIds[code];
        const periodId = lookups.periodIdByNumber[period];

        // Trips per bus depend on both the phase (plan type) and the transport
        // type, from the round_trips config table. No transport type or no
        // matching config falls back to one trip per bus.
        let roundTrip = 1;
        if (transportTypeId) {
            const key = `${planTypeId}:${transportTypeId}`;
            const configured = lookups.roundTripByTypeTransport.get(key);
            if (configured) {
                roundTrip = configured;
                const conflict = lookups.roundTripConflicts.get(key);
                if (conflict) {
                    planIssues.add(`${code}: round_trips has conflicting values for this transport type (${conflict.join(', ')}); used the latest (${configured})`);
                }
            } else {
                planIssues.add(`${code}: no round-trip config for this transport type; used 1`);
            }
        } else {
            planIssues.add('No transport type from mashaers file; round-trips default to 1');
        }

        // A trip carries BUS_CAPACITY pilgrims and a bus runs `roundTrip` trips
        // in the phase, so one bus moves BUS_CAPACITY * roundTrip pilgrims.
        const buses = Math.ceil(haj / (BUS_CAPACITY * roundTrip));

        const spec = {
            plan_type: code,
            plan_type_id: planTypeId,
            start,
            end,
            camp,
            camp_label: camp.name,
            camp_id: camp.id,
            origin_ll,
            entrance_ll,
            entrance_id: entrance_id || null,
            path_id: path_id || null,
            period,
            timing_id: (planTypeId && periodId) ? (lookups.timingByTypePeriod.get(`${planTypeId}:${periodId}`) || null) : null,
            transport_type_id: transportTypeId,
            haj,
            buses,
            round_trip: roundTrip,
            trips: buses * roundTrip,
            ...parkingFor(transportTypeId),
        };
        planSpecs.push(spec);
        return spec;
    }

    const addPlan = (code, target, origin, haj) => {
        if (!target) return null;
        return makeSpec(code, {
            start: { type: 'residence', id: origin.id },
            end: { type: 'camp', id: target.camp.id },
            camp: target.camp,
            entrance_id: target.camp.entrance_id,
            path_id: target.camp.path_entrance_id,
            period: target.period,
            haj,
            origin_ll: [origin.longitude, origin.latitude],
            entrance_ll: [target.camp.longitude, target.camp.latitude],
        });
    };

    for (const r of parsed.assignResidences) {
        const res = residenceMap.get(r.license_number);
        if (!res) continue; // already recorded as unmatched above
        if (!(Number.isFinite(res.longitude) && Number.isFinite(res.latitude))) {
            planIssues.add(`${r.license_number}: residence has no coordinates`);
            continue;
        }
        allocate(r.tarwiyah_count, tarwiaTargets).forEach((haj, i) => addPlan('tarwia', tarwiaTargets[i], res, haj));
        allocate(r.taseed_count, taseedTargets).forEach((haj, i) => addPlan('direct_taseed', taseedTargets[i], res, haj));
    }

    // ---- taseed_tarwia (Mina camp -> Arafat camp) ---------------------------
    // Everyone the centre sends to a Mina camp in a period moves on to Arafat
    // together: one plan per (Mina camp, period) carrying that period's tarwia
    // total. The Arafat camp is the Mina camp's fixed partner -- the Arafat camp
    // of the same label, which shares its camps.path_camp_id (the Mina->Arafat
    // geometry). No routed leg; the path is that shared camp path.
    const tarwiaByCampPeriod = new Map();
    for (const p of planSpecs) {
        if (p.plan_type !== 'tarwia') continue;
        const key = `${p.camp_id}:${p.period}`;
        const cur = tarwiaByCampPeriod.get(key) || { mina: p.camp, period: p.period, haj: 0 };
        cur.haj += p.haj;
        tarwiaByCampPeriod.set(key, cur);
    }
    for (const { mina, period, haj } of tarwiaByCampPeriod.values()) {
        const arafat = (campMap.get(mina.name) || {}).arafat;
        if (!arafat) { planIssues.add(`${mina.name}: no Arafat camp of that label; taseed_tarwia skipped`); continue; }
        if (mina.path_camp_id && arafat.path_camp_id && mina.path_camp_id !== arafat.path_camp_id) {
            warnings.push(`${mina.name}: Mina and Arafat camps do not share a camp path; used the Mina camp's.`);
        }
        if (!mina.path_camp_id && !arafat.path_camp_id) planIssues.add(`${mina.name}: no Mina->Arafat camp path`);
        makeSpec('taseed_tarwia', {
            start: { type: 'camp', id: mina.id },
            end: { type: 'camp', id: arafat.id },
            camp: arafat,
            entrance_id: arafat.entrance_id,
            path_id: mina.path_camp_id || arafat.path_camp_id,
            period,
            haj,
        });
    }

    // ---- efada (Arafat camp -> Muzdalifah drop-off area) --------------------
    // Everyone who arrived at an Arafat camp (direct_taseed + taseed_tarwia)
    // leaves for Muzdalifah across all three periods at EFADA_PERIOD_SHARES.
    // Drop-off area and camp->drop-off path are attributes of the camp.
    const arrivalsByArafatCamp = new Map();
    for (const p of planSpecs) {
        if (p.plan_type !== 'direct_taseed' && p.plan_type !== 'taseed_tarwia') continue;
        const cur = arrivalsByArafatCamp.get(p.camp_id) || { camp: p.camp, haj: 0 };
        cur.haj += p.haj;
        arrivalsByArafatCamp.set(p.camp_id, cur);
    }
    for (const { camp, haj } of arrivalsByArafatCamp.values()) {
        if (!camp.drop_off_area_id) { planIssues.add(`${camp.name}: no drop-off area configured; efada skipped`); continue; }
        if (!camp.path_dropoff_id) planIssues.add(`${camp.name}: no camp->drop-off path`);
        allocate(haj, EFADA_PERIOD_SHARES).forEach((share, i) => makeSpec('efada', {
            start: { type: 'camp', id: camp.id },
            end: { type: 'dropOffArea', id: camp.drop_off_area_id },
            camp,
            entrance_id: camp.entrance_id,
            path_id: camp.path_dropoff_id,
            period: EFADA_PERIOD_SHARES[i].period,
            haj: share,
        }));
    }

    return {
        center,
        generatedPlanTypeIds: GENERATED_PLAN_TYPES.map((code) => lookups.planTypeIds[code]).filter(Boolean),
        transportTypeId,
        assignCamps,
        assignResidences,
        mashaersTrips,
        planSpecs,
        warnings,
        planIssues: [...planIssues],
        unmatched: {
            camps: [...unmatched.camps],
            residences: [...unmatched.residences],
            countries: [...unmatched.countries],
        },
    };
}

function summarize(r) {
    const byType = {};
    let totalBuses = 0;
    let totalTrips = 0;
    let totalHaj = 0;
    for (const p of r.planSpecs) {
        byType[p.plan_type] = (byType[p.plan_type] || 0) + 1;
        totalBuses += p.buses;
        totalTrips += p.trips;
        // Every pilgrim is in exactly one of tarwia / direct_taseed; the later
        // phases move the same people again, so they are not counted twice.
        if (p.plan_type === 'tarwia' || p.plan_type === 'direct_taseed') totalHaj += p.haj;
    }
    return {
        center: { id: r.center.id, name: r.center.center_name, office: r.center.office_number },
        assignCamps: r.assignCamps.length,
        assignResidences: r.assignResidences.length,
        mashaersTrips: r.mashaersTrips.length,
        plans: { total: r.planSpecs.length, byType, totalBuses, totalTrips, totalHaj },
        routingConfigured: routing.isConfigured(),
        warnings: r.warnings,
        planIssues: r.planIssues,
        unmatched: r.unmatched,
    };
}

// ---------------------------------------------------------------- analyze

async function analyze({ files, user }) {
    if (!mayImport(user)) return { ok: false, status: 403, error: 'Not permitted to import plans' };
    const parsed = normalizeInputs(files);
    if (!parsed.assignCampUsers.length && !parsed.assignResidences.length && !parsed.periodPreferences.length) {
        return { ok: false, status: 400, error: 'No rows found in the uploaded files.' };
    }
    const client = await pool.connect();
    try {
        const r = await resolve(client, parsed, user);
        if (r.error) return { ok: false, status: 400, error: r.error };
        return { ok: true, summary: summarize(r) };
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------- commit

async function commit({ files, user }) {
    if (!mayImport(user)) return { ok: false, status: 403, error: 'Not permitted to import plans' };
    const parsed = normalizeInputs(files);
    const creatorId = /^[0-9a-f-]{36}$/i.test(String(user.userId || '')) ? user.userId : null;

    const client = await writePool.connect();
    try {
        const r = await resolve(client, parsed, user);
        if (r.error) return { ok: false, status: 400, error: r.error };

        const centerId = r.center.id;

        // Route each residence->entrance leg before opening the transaction, so
        // slow HTTP calls do not hold write locks. Camp-to-camp and camp-to-
        // drop-off legs use predefined paths and carry no routed geometry.
        const routed = [];
        for (const p of r.planSpecs) {
            if (!p.origin_ll) { routed.push({ ...p, coordinates: null }); continue; }
            const res = await routing.route(p.origin_ll, p.entrance_ll);
            routed.push({ ...p, coordinates: res.coordinates });
        }

        await client.query('BEGIN');

        // Replace this centre's data. Only the generated phases are replaced;
        // the centre's plans of other types (nafra, manual entries) survive.
        await client.query(
            'DELETE FROM plans WHERE owner_id = $1 AND plan_type_id = ANY($2::uuid[])',
            [centerId, r.generatedPlanTypeIds]
        );
        await client.query('DELETE FROM assign_camps WHERE service_center_id = $1', [centerId]);
        await client.query('DELETE FROM assign_residences WHERE service_center_id = $1', [centerId]);
        await client.query('DELETE FROM mashaers_trips WHERE service_center_id = $1', [centerId]);

        for (const a of r.assignCamps) {
            await client.query(
                `INSERT INTO assign_camps
                   (id, camp_id, haj_count, transport_type_id, service_center_id,
                    country_id, piligrim_type, created_by, created_at, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now())`,
                [crypto.randomUUID(), a.camp_id, a.haj_count, a.transport_type_id,
                 centerId, a.country_id, a.piligrim_type, creatorId]
            );
        }

        for (const a of r.assignResidences) {
            await client.query(
                `INSERT INTO assign_residences
                   (id, service_center_id, residence_id, haj_count, tarwia, direct_taseed,
                    created_by, created_at, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now())`,
                [crypto.randomUUID(), centerId, a.residence_id, a.haj_count, a.tarwia,
                 a.direct_taseed, creatorId]
            );
        }

        for (const t of r.mashaersTrips) {
            await client.query(
                `INSERT INTO mashaers_trips
                   (id, service_center_id, bus_id, transport_type_id, transport_company_name_ar,
                    created_by, created_at, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6, now(), now())`,
                [crypto.randomUUID(), centerId, t.bus_id, t.transport_type_id, t.transport_company_name_ar, creatorId]
            );
        }

        let created = 0;
        for (const p of routed) {
            const geojson = p.coordinates && p.coordinates.length >= 2
                ? routing.toLineStringGeoJSON(p.coordinates)
                : null;
            await client.query(
                `INSERT INTO plans
                   (id, creator_id, owner_id, start_point_type, start_point_id,
                    end_point_type, end_point_id, plan_type_id, transport_type_id,
                    entrance_id, path_id, period, timing_id,
                    number_of_haj, number_of_buses, number_of_trips,
                    get_parking_id, get_type_parking, set_parking_id, set_type_parking,
                    path_gis, created_at, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                    CASE WHEN $21::text IS NULL THEN NULL
                         ELSE ST_SetSRID(ST_GeomFromGeoJSON($21::text), 4326) END,
                    now(), now())`,
                [
                    crypto.randomUUID(), creatorId, centerId,
                    p.start.type, p.start.id,
                    p.end.type, p.end.id, p.plan_type_id, p.transport_type_id,
                    p.entrance_id, p.path_id, String(p.period), p.timing_id,
                    p.haj, p.buses, p.trips,
                    p.get_parking_id, p.get_type_parking, p.set_parking_id, p.set_type_parking,
                    geojson,
                ]
            );
            created++;
        }

        await client.query('COMMIT');

        // Refresh the dashboard caches touched by this centre.
        for (const ds of ['plans', 'assign-camps', 'assign-residences', 'camps-gates']) invalidate(ds);

        const summary = summarize(r);
        const perType = Object.entries(summary.plans.byType).map(([t, n]) => `${n} ${t}`).join(', ');
        console.log(
            `[import] ${user.username} committed centre ${centerId}: ` +
            `${r.assignCamps.length} assign_camps, ${r.assignResidences.length} assign_residences, ` +
            `${r.mashaersTrips.length} mashaers_trips, ${created} plans (${perType})`
        );
        return { ok: true, summary: { ...summary, plansCreated: created } };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[import] commit failed:', err.message);
        return { ok: false, status: 502, error: 'Import failed', detail: err.message };
    } finally {
        client.release();
    }
}

module.exports = { analyze, commit, mayImport, normalizeInputs, resolve };
