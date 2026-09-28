// Estimates each Mashaer entrance's bus capacity from the Hajj 1446 GPS.
//
//   node scripts/estimate-entrance-capacity.js --step prepare    # entrance zones → your_db
//   (run sql/routing/06_entrance_flow.sql on the VM)              # count entries
//   node scripts/estimate-entrance-capacity.js --step estimate   # → transport.routing.entrance_capacity_estimate
//
// The estimate is the busiest sustained hour the entrance actually carried
// (rolling 60 min): a firm lower bound on its capacity, since the gate provably
// passed that many buses. It is marked "at capacity" when buses were queueing in
// that hour — approaching buses typically took SAT_APPROACH_S or more for the
// last 400 m at SAT_MAX_KMH or slower — so the peak is close to what the gate
// can pass; otherwise "at least": the gate may carry more.
//
// Long approach times alone do not mean a queue: buses parked or held near a
// gate (parking areas, shuttle holding areas) also stay long in the approach
// zone. An earlier version took the throughput of such slots as the capacity
// and got values below the observed peaks; hence the speed condition, and a
// "parking-like" flag where the typical wait exceeds PARKING_LIKE_S.
//
// Nothing is written to public.entrances; review the estimates, then copy the
// accepted ones into entrances.capacity (buses per hour).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { Pool } = require('pg');

const step = process.argv.includes('--step') ? process.argv[process.argv.indexOf('--step') + 1] : '';
if (!['prepare', 'estimate'].includes(step)) {
    console.error('Usage: --step prepare | --step estimate');
    process.exit(1);
}

const APPROACH_M = 400;
const SAT_APPROACH_S = 240;
const SAT_MAX_KMH = 8;
const PARKING_LIKE_S = 1800;
// Arrival windows of the 1447 plans (1446 dates): Mina entrances take tarwia
// (7th 20:00 – 8th 08:00), Arafat entrances direct taseed (8th 20:00 – 9th 08:00).
// Arafat's all-day peak is often the evening of the 9th — buses going in to
// collect pilgrims for the Nafra — which is not the flow the plans put there.
const PLAN_WINDOW = {
    ASMMIN: [Date.parse('2025-06-03T20:00:00+03:00'), Date.parse('2025-06-04T08:00:00+03:00')],
    ASMARF: [Date.parse('2025-06-04T20:00:00+03:00'), Date.parse('2025-06-05T08:00:00+03:00')],
};
const HIJRI_DAY0 = Date.UTC(2025, 4, 27);   // 27 May 2025: Hijri day n = this + n days (1446)

const writer = (database) => new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT) || 5431,
    database,
    user: process.env.PGW_USER,
    password: process.env.PGW_PASSWORD,
    max: 2,
    statement_timeout: 300000,
});
const transport = writer(process.env.PGDATABASE || 'transport');
const net = writer(process.env.ROUTING_PGDATABASE || 'your_db');

function quantile(values, q) {
    const s = values.slice().sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
}

function hijriLabel(ts) {
    const local = new Date(new Date(ts).getTime() + 3 * 3600e3);
    const day = Math.floor((Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - HIJRI_DAY0) / 86400e3);
    return `${day} DH ${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
}

// Entrance polygons, merged where several entrances share one identical
// polygon (GPS cannot tell them apart), with a 400 m approach zone.
async function prepare() {
    const { rows } = await transport.query(`
        SELECT md5(ST_AsBinary(gis)) AS zone_key, array_agg(asm_code ORDER BY asm_code) AS asm_codes,
               ST_AsText((array_agg(gis))[1]) AS wkt
        FROM public.entrances WHERE gis IS NOT NULL
        GROUP BY md5(ST_AsBinary(gis))`);
    const client = await net.connect();
    try {
        await client.query('BEGIN');
        await client.query('DROP TABLE IF EXISTS routing.entrance_zone');
        await client.query(`
            CREATE TABLE routing.entrance_zone (
                zone_id   text PRIMARY KEY,           -- asm codes joined with '+' when polygons are identical
                asm_codes text[] NOT NULL,
                geom      geometry(MultiPolygon, 4326) NOT NULL,
                approach  geometry(Polygon, 4326) NOT NULL
            )`);
        for (const r of rows) {
            await client.query(`
                INSERT INTO routing.entrance_zone (zone_id, asm_codes, geom, approach)
                SELECT $1, $2, ST_Multi(g), ST_Buffer(g::geography, $4)::geometry
                FROM (SELECT ST_SetSRID(ST_GeomFromText($3), 4326) AS g) s`,
                [r.asm_codes.join('+'), r.asm_codes, r.wkt, APPROACH_M]);
        }
        await client.query('CREATE INDEX entrance_zone_approach_gix ON routing.entrance_zone USING gist (approach)');
        await client.query('GRANT SELECT ON routing.entrance_zone TO ro_user');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
    const merged = rows.filter(r => r.asm_codes.length > 1).map(r => r.asm_codes.join('+'));
    console.log(`${rows.length} entrance zones written to your_db.routing.entrance_zone` +
                (merged.length ? ` (identical polygons merged: ${merged.join(', ')})` : ''));
}

async function estimate() {
    const { rows: slots } = await net.query(`
        SELECT zone_id, slot, entries, approach_s_median, approach_kmh_median, with_approach
        FROM routing.entrance_flow_slot ORDER BY zone_id, slot`);
    const { rows: entrances } = await transport.query(
        'SELECT id, asm_code, name, capacity FROM public.entrances');
    // count() comes back as bigint, i.e. text: make it a number before any arithmetic.
    for (const s of slots) {
        s.entries = Number(s.entries);
        s.with_approach = Number(s.with_approach);
    }
    const byZone = new Map();
    for (const s of slots) {
        if (!byZone.has(s.zone_id)) byZone.set(s.zone_id, []);
        byZone.get(s.zone_id).push(s);
    }

    const results = [];
    for (const e of entrances) {
        const zoneId = [...byZone.keys()].find(z => z.split('+').includes(e.asm_code))
            || e.asm_code;
        const list = byZone.get(zoneId) || [];
        const entriesAll = list.map(s => s.entries);
        const queueing = (s) => s.with_approach >= 3 && Number(s.approach_s_median) >= SAT_APPROACH_S
            && Number(s.approach_kmh_median) <= SAT_MAX_KMH;
        const peak = list.reduce((best, s) => (!best || s.entries > best.entries ? s : best), null);
        // Busiest rolling hour (4 consecutive slots).
        let peakHour = 0;
        let peakHourStart = null;
        const bySlot = new Map(list.map(s => [new Date(s.slot).getTime(), s.entries]));
        for (const s of list) {
            const t = new Date(s.slot).getTime();
            const sum = [0, 1, 2, 3].reduce((a, k) => a + (bySlot.get(t + k * 900e3) || 0), 0);
            if (sum > peakHour) { peakHour = sum; peakHourStart = s.slot; }
        }
        const [winStart, winEnd] = PLAN_WINDOW[e.asm_code.slice(0, 6)] || [0, 0];
        let peakInWindow = 0;
        for (const s of list) {
            const t = new Date(s.slot).getTime();
            if (t < winStart || t + 3600e3 > winEnd) continue;
            peakInWindow = Math.max(peakInWindow, [0, 1, 2, 3].reduce((a, k) => a + (bySlot.get(t + k * 900e3) || 0), 0));
        }
        const peakSlots = peakHourStart
            ? list.filter(s => { const t = new Date(s.slot).getTime() - new Date(peakHourStart).getTime(); return t >= 0 && t < 3600e3; })
            : [];
        const queuedAtPeak = peakSlots.filter(queueing).length >= 2;
        const typicalWait = quantile(list.filter(s => s.with_approach >= 3).map(s => Number(s.approach_s_median)), 0.5);
        const parkingLike = typicalWait !== null && typicalWait > PARKING_LIKE_S;
        const saturated = list.filter(queueing);
        const confidence = !list.length ? 'no data'
            : parkingLike ? 'at least (parking-like zone)'
            : queuedAtPeak ? 'at capacity' : 'at least';
        const perHour = list.length ? peakHour : null;
        const per15 = peak ? peak.entries : null;
        results.push({
            entrance_id: e.id, asm_code: e.asm_code, name: e.name, zone_id: zoneId,
            shared_polygon: zoneId.includes('+'),
            capacity_per_hour: perHour,
            capacity_per_15min: per15,
            confidence,
            saturated_slots: saturated.length,
            active_slots: list.length,
            entries_total: entriesAll.reduce((a, n) => a + n, 0),
            peak_15min: peak ? peak.entries : null,
            peak_15min_at: peak ? hijriLabel(peak.slot) : null,
            peak_hour: peakHour || null,
            peak_hour_from: peakHourStart ? hijriLabel(peakHourStart) : null,
            peak_hour_in_plan_window: list.length ? peakInWindow : null,
            approach_s_at_peak: peak && peak.approach_s_median !== null ? Math.round(Number(peak.approach_s_median)) : null,
            current_capacity: e.capacity,
        });
    }

    const client = await transport.connect();
    try {
        await client.query('BEGIN');
        await client.query(`
            CREATE TABLE IF NOT EXISTS routing.entrance_capacity_estimate (
                entrance_id        uuid PRIMARY KEY REFERENCES public.entrances(id) ON DELETE CASCADE,
                asm_code           text NOT NULL,
                zone_id            text NOT NULL,           -- 'A+B' when A and B share one polygon
                shared_polygon     boolean NOT NULL,
                capacity_per_hour  int,                     -- buses per hour
                capacity_per_15min int,
                confidence         text NOT NULL,           -- measured | lower bound | no data
                saturated_slots    int NOT NULL,
                active_slots       int NOT NULL,
                entries_total      int NOT NULL,
                peak_15min         int,
                peak_15min_at      text,                    -- Hijri day + local time, 1446
                peak_hour          int,
                peak_hour_from     text,
                approach_s_at_peak int,                     -- median time over the last 400 m at the peak
                peak_hour_in_plan_window int,               -- busiest hour within the plans' arrival window
                current_capacity   int,                     -- entrances.capacity when estimated
                method             jsonb NOT NULL,
                estimated_at       timestamptz NOT NULL DEFAULT now()
            )`);
        await client.query('ALTER TABLE routing.entrance_capacity_estimate ADD COLUMN IF NOT EXISTS peak_hour_in_plan_window int');
        await client.query('DELETE FROM routing.entrance_capacity_estimate');
        const method = {
            source: 'your_db.public.hajj_days_2, 7–10 Dhul Hijjah 1446', approach_m: APPROACH_M,
            entry: 'crossing where the bus slowed to ≤ 15 km/h within 2 min; a bus counts once per 60 min per entrance',
            capacity_per_hour: 'busiest rolling 60 min of bus entries (a lower bound)',
            capacity_per_15min: 'busiest 15-min slot',
            at_capacity: `≥ 2 slots of the peak hour with median approach ≥ ${SAT_APPROACH_S} s and ≤ ${SAT_MAX_KMH} km/h`,
            parking_like: `typical approach wait > ${PARKING_LIKE_S} s`, unit: 'buses',
        };
        for (const r of results) {
            await client.query(`
                INSERT INTO routing.entrance_capacity_estimate
                    (entrance_id, asm_code, zone_id, shared_polygon, capacity_per_hour, capacity_per_15min, confidence,
                     saturated_slots, active_slots, entries_total, peak_15min, peak_15min_at, peak_hour, peak_hour_from,
                     approach_s_at_peak, current_capacity, method, peak_hour_in_plan_window)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
                [r.entrance_id, r.asm_code, r.zone_id, r.shared_polygon, r.capacity_per_hour, r.capacity_per_15min,
                 r.confidence, r.saturated_slots, r.active_slots, r.entries_total, r.peak_15min, r.peak_15min_at,
                 r.peak_hour, r.peak_hour_from, r.approach_s_at_peak, r.current_capacity, method,
                 r.peak_hour_in_plan_window]);
        }
        await client.query('GRANT SELECT ON routing.entrance_capacity_estimate TO ro_user');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
    console.table(results.sort((a, b) => a.asm_code.localeCompare(b.asm_code)).map(r => ({
        entrance: r.asm_code, zone: r.shared_polygon ? r.zone_id : '',
        'capacity /h': r.capacity_per_hour, confidence: r.confidence,
        'queueing slots': r.saturated_slots, 'entries 7–10 DH': r.entries_total,
        'peak 15 min': r.peak_15min, 'peak at': r.peak_15min_at, 'peak hour': r.peak_hour,
        'approach at peak (s)': r.approach_s_at_peak, 'peak h in plan window': r.peak_hour_in_plan_window,
        'current value': r.current_capacity,
    })));
    console.log('Saved to transport.routing.entrance_capacity_estimate (entrances.capacity unchanged).');
}

(step === 'prepare' ? prepare() : estimate())
    .catch(err => { console.error(err); process.exitCode = 1; })
    .finally(() => Promise.all([transport.end(), net.end()]));
