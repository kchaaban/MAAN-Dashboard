#!/usr/bin/env node
// One-time backfill: give every Arafat camp its Muzdalifah drop-off area in
// camps.drop_off_area_id, so the plan import can generate efada plans
// (Arafat camp -> drop-off area) without guessing at import time.
//
// Where the value comes from, in order of trust:
//   1. legacy   the camp's existing efada plans (every legacy camp uses exactly
//               one drop-off area)
//   2. path     other legacy plans whose camp->drop-off path has the same name
//               as this camp's camps.path_dropoff_id path
//   3. suffix   the drop-off token in that path name ("... - ساحات ترددي 1",
//               "... - عرفات 3"), as legacy plans map that same token
//   4. name     the token equals a drop_off_areas.name once brackets and spaces
//               are ignored ("ساحات ترددي 3" = "ساحات ترددي (3)")
// Camps left unresolved (e.g. a path just named "قطار") are reported; the
// import flags their efada plans as skipped until the column is filled by hand.
//
// Safety:
//   * Dry run by default: prints what it would do, writes nothing.
//   * Pass --apply to add the column (if missing) and write the values.
//   * Only camps with drop_off_area_id IS NULL are written -- safe to re-run.
//   * Uses the write connection (PGW_USER/PGW_PASSWORD) from .env.
//
// Usage (from the server directory):
//   node scripts/backfill-camp-dropoff.js            # dry run
//   node scripts/backfill-camp-dropoff.js --apply    # write changes

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');

const normalizeName = (s) => String(s || '').replace(/[()\s]/g, '').trim();
// "شارع 802 - ساحات ترددي 3" -> "ساحات ترددي 3"; a name with no " - " is its own token.
const dropoffToken = (pathName) => {
    const parts = String(pathName || '').split(' - ');
    return parts[parts.length - 1].trim();
};

async function main() {
    const client = new Client({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT),
        database: process.env.PGDATABASE,
        user: process.env.PGW_USER,
        password: process.env.PGW_PASSWORD,
    });
    await client.connect();
    console.log(`[dropoff] mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY RUN (no writes)'}`);

    const colExists = (await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'camps' AND column_name = 'drop_off_area_id'`
    )).rowCount > 0;
    console.log(`[dropoff] camps.drop_off_area_id column: ${colExists ? 'present' : 'missing' + (APPLY ? ' (will add)' : '')}`);

    const camps = (await client.query(`
        SELECT c.id, c.name, pa.name AS path_name,
               ${colExists ? 'c.drop_off_area_id' : 'NULL::uuid AS drop_off_area_id'}
        FROM camps c
        JOIN platforms pl ON pl.id = c.platform_id
        LEFT JOIN paths pa ON pa.id = c.path_dropoff_id
        WHERE pl.code = 'arafat'
        ORDER BY c.name`)).rows;

    const legacyByCamp = new Map((await client.query(`
        SELECT p.start_point_id AS camp_id, mode() WITHIN GROUP (ORDER BY p.end_point_id) AS dropoff_id
        FROM plans p JOIN plan_types pt ON pt.id = p.plan_type_id
        WHERE pt.code = 'efada' AND p.end_point_type = 'dropOffArea'
        GROUP BY p.start_point_id`)).rows.map((r) => [r.camp_id, r.dropoff_id]));

    const legacyPaths = (await client.query(`
        SELECT pa.name AS path_name, mode() WITHIN GROUP (ORDER BY p.end_point_id) AS dropoff_id
        FROM plans p JOIN plan_types pt ON pt.id = p.plan_type_id JOIN paths pa ON pa.id = p.path_id
        WHERE pt.code = 'efada' AND p.end_point_type = 'dropOffArea'
        GROUP BY pa.name`)).rows;
    const legacyByPathName = new Map(legacyPaths.map((r) => [r.path_name, r.dropoff_id]));
    const legacyByToken = new Map();
    for (const r of legacyPaths) {
        const token = dropoffToken(r.path_name);
        if (token && !legacyByToken.has(token)) legacyByToken.set(token, r.dropoff_id);
    }

    const areas = (await client.query('SELECT id, name FROM drop_off_areas')).rows;
    const areaByNormName = new Map(areas.map((a) => [normalizeName(a.name), a.id]));
    const areaName = new Map(areas.map((a) => [a.id, a.name]));

    const resolved = [];
    const unresolved = [];
    let alreadySet = 0;
    const tierCounts = { legacy: 0, path: 0, suffix: 0, name: 0 };

    for (const camp of camps) {
        if (camp.drop_off_area_id) { alreadySet++; continue; }
        const token = dropoffToken(camp.path_name);
        let tier = null;
        let dropoffId = legacyByCamp.get(camp.id);
        if (dropoffId) tier = 'legacy';
        if (!dropoffId && camp.path_name && legacyByPathName.has(camp.path_name)) { dropoffId = legacyByPathName.get(camp.path_name); tier = 'path'; }
        if (!dropoffId && token && legacyByToken.has(token)) { dropoffId = legacyByToken.get(token); tier = 'suffix'; }
        if (!dropoffId && token && areaByNormName.has(normalizeName(token))) { dropoffId = areaByNormName.get(normalizeName(token)); tier = 'name'; }
        if (dropoffId) { tierCounts[tier]++; resolved.push({ camp, dropoffId, tier }); }
        else unresolved.push(camp);
    }

    console.log(`[dropoff] Arafat camps:        ${camps.length}`);
    console.log(`[dropoff] already set (skip):  ${alreadySet}`);
    console.log(`[dropoff] resolved:            ${resolved.length}  (legacy ${tierCounts.legacy}, path ${tierCounts.path}, suffix ${tierCounts.suffix}, name ${tierCounts.name})`);
    console.log(`[dropoff] unresolved:          ${unresolved.length}`);
    if (unresolved.length) {
        const byPath = {};
        for (const c of unresolved) byPath[c.path_name || '(no path)'] = (byPath[c.path_name || '(no path)'] || 0) + 1;
        for (const [name, n] of Object.entries(byPath).sort((a, b) => b[1] - a[1])) console.log(`           - ${n} camp(s) with path "${name}"`);
    }
    for (const r of resolved.filter((x) => x.tier !== 'legacy').slice(0, 15)) {
        console.log(`           ${r.tier.padEnd(6)} ${r.camp.name.padEnd(8)} "${r.camp.path_name}" -> ${areaName.get(r.dropoffId)}`);
    }

    if (!APPLY) {
        console.log('[dropoff] dry run complete; re-run with --apply to write.');
        await client.end();
        return;
    }

    try {
        await client.query('BEGIN');
        if (!colExists) {
            await client.query(`ALTER TABLE camps ADD COLUMN drop_off_area_id uuid
                REFERENCES drop_off_areas(id) ON UPDATE CASCADE ON DELETE SET NULL`);
            console.log('[dropoff] added camps.drop_off_area_id');
        }
        let written = 0;
        for (const r of resolved) {
            const { rowCount } = await client.query(
                'UPDATE camps SET drop_off_area_id = $1, updated_at = now() WHERE id = $2 AND drop_off_area_id IS NULL',
                [r.dropoffId, r.camp.id]
            );
            written += rowCount;
        }
        await client.query('COMMIT');
        console.log(`[dropoff] committed. ${written} camp(s) updated.`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[dropoff] error, rolled back -- nothing changed:', err.message);
        process.exitCode = 1;
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error('[dropoff] fatal:', err.message);
    process.exit(1);
});
