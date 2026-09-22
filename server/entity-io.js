// Bulk export and import for the reference entities (camps, residences, paths,
// entrances, parking, bus stops, warehouses, drop-off areas, transport
// companies).
//
// The round trip is the point: download a table as CSV, edit it in Excel, upload
// it back. So the export carries each row's `id`, and the import matches on it.
//
//   id present and known  -> UPDATE that row
//   id empty              -> INSERT a new row
//   id present but absent from the table -> error, nothing written
//   row in the table but not in the file -> left alone
//
// Nothing is ever deleted by an import. Deleting stays a single-record action,
// because plans point at these rows through *_type/*_id pairs with no foreign
// key, so a bulk delete would silently orphan plans.
//
// Exporting is open to any admin; importing is restricted to system_admin,
// because one file can rewrite data all 755 service-centre users depend on.

const crypto = require('crypto');
const { pool, writePool, invalidate } = require('./db');
const { RESOURCES, isAdmin } = require('./writes');
const { rowsToObjects } = require('./plans-import');
const { checkGeometry, GEOMETRY_TARGETS } = require('./geometry');

// Two admin types exist (system_admin, transport_authority); only the first may
// import. Anyone who can already edit records one at a time may export.
const isSuperAdmin = (user) => user.typeCode === 'system_admin';

const MAX_IMPORT_ROWS = 20000;
// Enough to see the pattern in a bad file without shipping a megabyte of errors.
const MAX_REPORTED = 200;

const GEOMETRY_HEADER = 'geometry_geojson';

function specFor(resource) {
    const spec = RESOURCES[resource];
    if (!spec || !spec.reference) return null;
    return spec;
}

// ── Export ─────────────────────────────────────────────────────────────────

// Editable columns first (those are what an import can change), then the
// read-only ones for context, then geometry last because it is long.
function exportColumns(spec) {
    const editable = Object.keys(spec.columns);
    const readOnly = (spec.readOnly || []).filter((c) => !editable.includes(c));
    return { editable, readOnly };
}

function csvCell(value) {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportCsv({ resource, user }) {
    const spec = specFor(resource);
    if (!spec) return { ok: false, status: 404, error: 'Unknown entity' };
    if (!isAdmin(user)) return { ok: false, status: 403, error: 'Not permitted' };

    const { editable, readOnly } = exportColumns(spec);
    const select = ['t.id', ...editable.map((c) => `t.${c}`), ...readOnly.map((c) => `t.${c}`)];
    if (spec.anchor) select.push(`${spec.anchor.lon} AS lon`, `${spec.anchor.lat} AS lat`);
    // Six decimals is ~10cm, the same precision the map is served at, and it
    // makes an untouched cell byte-identical on the way back in — which is how
    // the import tells "not edited" from "edited to the same shape".
    if (spec.geom) select.push(`ST_AsGeoJSON(t.${spec.geom}, 6) AS ${GEOMETRY_HEADER}`);

    const { rows, fields } = await pool.query(
        `SELECT ${select.join(', ')} FROM ${spec.table} t ORDER BY ${spec.order} NULLS LAST`
    );
    const headers = fields.map((f) => f.name);

    const lines = [headers.join(',')];
    for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(','));

    return {
        ok: true,
        // Excel only reads UTF-8 correctly with a BOM, and every label here is
        // Arabic.
        csv: '﻿' + lines.join('\r\n') + '\r\n',
        filename: `${resource}-${new Date().toISOString().slice(0, 10)}.csv`,
        rowCount: rows.length,
    };
}

// ── Import: the check rules ────────────────────────────────────────────────
// Applied in order; a row that fails any of them is reported and the whole
// import is refused. Nothing is written until every row passes.
//
//  1. File shape    non-empty, has a header row, has an `id` column, at most
//                   MAX_IMPORT_ROWS data rows.
//  2. Headers       every header is either `id`, an editable column, a known
//                   read-only column, or the geometry column. An unrecognised
//                   header is a warning (ignored), not an error, so a stray
//                   Excel column does not block the file.
//  3. Row identity  `id` is blank (insert) or a well-formed uuid that exists in
//                   the table (update). No duplicate ids within the file.
//  4. Field values  each editable cell passes that column's own validator — the
//                   same one the single-record editor uses, so bulk and single
//                   edits cannot disagree.
//  5. Required      an insert supplies every required column; an update may not
//                   blank one.
//  6. References    a foreign-key cell names a row that exists (platform,
//                   entrance, transport type, drop-off area).
//  7. Geometry      parsed as GeoJSON or WKT/EWKT; forced to SRID 4326 and 2D;
//                   must be ST_IsValid; must belong to the column's geometry
//                   family (areal or linear) and is coerced to its declared
//                   type. A cell identical to the exported text is treated as
//                   untouched and skipped entirely.
//  8. No-ops        a row whose every cell matches the stored values is counted
//                   as unchanged and not written.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeHeader(name) {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, '_');
}

// Map the file's headers onto the columns we understand, case- and
// space-insensitively, and say which ones we are ignoring.
function mapHeaders(spec, sample) {
    const { editable, readOnly } = exportColumns(spec);
    const known = new Map();
    known.set('id', 'id');
    editable.forEach((c) => known.set(normalizeHeader(c), c));
    if (spec.geom) known.set(normalizeHeader(GEOMETRY_HEADER), GEOMETRY_HEADER);

    const ignorable = new Set([
        ...readOnly.map(normalizeHeader),
        'lon', 'lat', 'longitude', 'latitude',
    ]);

    const columns = {};        // file header -> column name
    const ignored = [];
    for (const header of Object.keys(sample)) {
        const key = normalizeHeader(header);
        if (known.has(key)) columns[header] = known.get(key);
        else ignored.push(header);
    }
    return { columns, ignored, ignoredKnown: ignored.filter((h) => ignorable.has(normalizeHeader(h))) };
}

// The single pass both `analyze` and `commit` run. `apply` decides whether the
// writes happen; everything else is identical, so a preview can never disagree
// with what a commit then does.
async function processImport({ resource, csv, user, apply }) {
    const spec = specFor(resource);
    if (!spec) return { ok: false, status: 404, error: 'Unknown entity' };
    if (!isSuperAdmin(user)) {
        return {
            ok: false, status: 403,
            error: 'استيراد البيانات المرجعية مقصور على مشرف النظام',
        };
    }

    const parsed = rowsToObjects(csv);
    if (!parsed.length) return { ok: false, status: 400, error: 'الملف فارغ أو بلا صفوف بيانات' };
    if (parsed.length > MAX_IMPORT_ROWS) {
        return { ok: false, status: 400, error: `الملف يحتوي ${parsed.length} صفاً؛ الحد ${MAX_IMPORT_ROWS}` };
    }

    const { columns, ignored } = mapHeaders(spec, parsed[0]);
    const byColumn = (name) => Object.keys(columns).find((h) => columns[h] === name);
    const mapped = Object.values(columns);
    if (!mapped.includes('id')) {
        return {
            ok: false, status: 400,
            error: 'الملف لا يحتوي عمود id — صدّر الجدول أولاً ثم عدّل عليه',
        };
    }
    const editableInFile = mapped.filter((c) => c !== 'id' && c !== GEOMETRY_HEADER);
    const geometryInFile = mapped.includes(GEOMETRY_HEADER);
    if (!editableInFile.length && !geometryInFile) {
        return { ok: false, status: 400, error: 'الملف لا يحتوي أي عمود قابل للتعديل' };
    }

    const errors = [];
    const warnings = ignored.length ? [`أعمدة غير معروفة تم تجاهلها: ${ignored.join('، ')}`] : [];
    const note = (line, message) => {
        if (errors.length < MAX_REPORTED) errors.push({ line, message });
    };

    const client = await writePool.connect();
    let inserts = 0;
    let updates = 0;
    let unchanged = 0;
    let geometryChanges = 0;
    const fieldTouches = new Map();

    try {
        await client.query('BEGIN');

        // Current state, keyed by id: the values to diff against, and the
        // exported geometry text so an untouched shape cell is recognisable.
        const stateCols = ['id', ...Object.keys(spec.columns)];
        const geomSelect = spec.geom ? `, ST_AsGeoJSON(t.${spec.geom}, 6) AS ${GEOMETRY_HEADER}` : '';
        const { rows: currentRows } = await client.query(
            `SELECT ${stateCols.map((c) => `t.${c}`).join(', ')}${geomSelect} FROM ${spec.table} t`
        );
        const current = new Map(currentRows.map((r) => [String(r.id), r]));

        // ── Pass 1: per-row shape and value checks, no database ─────────────
        const idHeader = byColumn('id');
        const geomHeader = geometryInFile ? byColumn(GEOMETRY_HEADER) : null;
        const seen = new Set();
        const candidates = [];
        // Foreign-key values are collected here and checked in one query per
        // column afterwards, instead of a round trip per cell.
        const fkWanted = new Map();

        for (let i = 0; i < parsed.length; i++) {
            const line = i + 2; // the header is line 1
            const raw = parsed[i];
            const rawId = String(raw[idHeader] ?? '').trim();

            let existing = null;
            if (rawId) {
                if (!UUID_RE.test(rawId)) { note(line, `id غير صالح: «${rawId}»`); continue; }
                const key = rawId.toLowerCase();
                if (seen.has(key)) { note(line, `id مكرر في الملف: ${rawId}`); continue; }
                seen.add(key);
                existing = current.get(rawId) || null;
                if (!existing) { note(line, `id غير موجود في الجدول: ${rawId}`); continue; }
            }

            const values = {};
            let failed = false;

            for (const [header, column] of Object.entries(columns)) {
                if (column === 'id' || column === GEOMETRY_HEADER) continue;
                const def = spec.columns[column];
                const cell = String(raw[header] ?? '').trim();

                // An empty cell on an update means "leave this alone", never
                // "clear it": a spreadsheet full of blanks must not wipe columns.
                if (cell === '') {
                    if (!existing && def.required) {
                        note(line, `${def.label} مطلوب للسجلات الجديدة`);
                        failed = true;
                    }
                    continue;
                }

                const clean = def.validate(cell);
                if (clean === undefined) {
                    note(line, `${def.label}: قيمة غير صالحة «${cell}»`);
                    failed = true;
                    continue;
                }
                values[column] = clean;

                if (def.check && def.check.table && clean !== null) {
                    if (!fkWanted.has(column)) fkWanted.set(column, new Set());
                    fkWanted.get(column).add(String(clean));
                }
            }

            if (failed) continue;
            candidates.push({ line, existing, values, geomCell: geomHeader ? String(raw[geomHeader] ?? '').trim() : '' });
        }

        // ── Pass 2: foreign keys, one query per column ──────────────────────
        const fkKnown = new Map();
        for (const [column, wanted] of fkWanted.entries()) {
            const { table } = spec.columns[column].check;
            const { rows } = await client.query(
                `SELECT id FROM ${table} WHERE id = ANY($1::uuid[])`, [[...wanted]]
            );
            fkKnown.set(column, new Set(rows.map((r) => String(r.id))));
        }

        // ── Pass 3: geometry, only for cells that actually differ ───────────
        const plan = [];
        for (const candidate of candidates) {
            const { line, existing, values, geomCell } = candidate;
            let failed = false;

            for (const [column, value] of Object.entries(values)) {
                const known = fkKnown.get(column);
                if (known && !known.has(String(value))) {
                    note(line, `${spec.columns[column].label}: مرجع غير معروف ${value}`);
                    failed = true;
                }
            }

            let geometry = null;
            if (geometryInFile && geomCell) {
                const stored = existing ? String(existing[GEOMETRY_HEADER] ?? '') : '';
                if (geomCell !== stored) {
                    const result = await checkGeometry(client, resource, geomCell);
                    if (result.error) {
                        note(line, `الشكل الهندسي: ${result.error}`);
                        failed = true;
                    } else {
                        geometry = result.ewkt;
                    }
                }
            }
            if (failed) continue;

            // Only genuine differences are written, so importing the same file
            // twice is a no-op rather than 1,333 pointless updates.
            const changed = {};
            for (const [column, value] of Object.entries(values)) {
                const before = existing ? existing[column] : undefined;
                if (!existing || String(before ?? '') !== String(value ?? '')) changed[column] = value;
            }

            if (existing && !Object.keys(changed).length && !geometry) { unchanged++; continue; }
            if (existing) updates++; else inserts++;
            if (geometry) {
                geometryChanges++;
                fieldTouches.set('__geom', (fieldTouches.get('__geom') || 0) + 1);
            }
            for (const column of Object.keys(changed)) {
                fieldTouches.set(column, (fieldTouches.get(column) || 0) + 1);
            }
            plan.push({ id: existing ? existing.id : null, values: changed, geometry });
        }

        // One bad row refuses the whole file. A half-applied import of shared
        // reference data is far worse than a rejected one.
        if (errors.length) {
            await client.query('ROLLBACK');
            return {
                ok: false, status: 400,
                error: `الملف يحتوي ${errors.length}${errors.length >= MAX_REPORTED ? '+' : ''} مشكلة؛ لم يُكتب أي شيء`,
                report: { errors, warnings, inserts, updates, unchanged },
            };
        }

        if (apply) {
            for (const entry of plan) {
                const cols = Object.keys(entry.values);
                if (entry.id) {
                    const sets = cols.map((c, i) => `${c} = $${i + 2}`);
                    const params = [entry.id, ...cols.map((c) => entry.values[c])];
                    if (entry.geometry) {
                        params.push(entry.geometry);
                        sets.push(`${spec.geom} = ST_GeomFromEWKT($${params.length})`);
                    }
                    await client.query(
                        `UPDATE ${spec.table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
                        params
                    );
                } else {
                    const names = [...cols];
                    const params = cols.map((c) => entry.values[c]);
                    const placeholders = names.map((_n, i) => `$${i + 2}`);
                    if (entry.geometry) {
                        names.push(spec.geom);
                        params.push(entry.geometry);
                        placeholders.push(`ST_GeomFromEWKT($${params.length + 1})`);
                    }
                    await client.query(
                        `INSERT INTO ${spec.table} (id${names.length ? ', ' + names.join(', ') : ''}, created_at, updated_at)
                         VALUES ($1${placeholders.length ? ', ' + placeholders.join(', ') : ''}, now(), now())`,
                        [crypto.randomUUID(), ...params]
                    );
                }
            }
            await client.query('COMMIT');
            console.log(
                `[import] ${user.username} (${user.typeCode}) ${resource}: `
                + `${inserts} inserted, ${updates} updated, ${unchanged} unchanged, ${geometryChanges} shapes`
            );
            for (const dataset of spec.invalidates || []) invalidate(dataset);
        } else {
            await client.query('ROLLBACK');
        }

        return {
            ok: true,
            resource,
            label: spec.label,
            applied: Boolean(apply),
            rows: parsed.length,
            inserts,
            updates,
            unchanged,
            geometryChanges,
            columns: editableInFile,
            fields: [...fieldTouches.entries()]
                .map(([column, count]) => ({
                    column,
                    label: column === '__geom'
                        ? 'الشكل الهندسي'
                        : ((spec.columns[column] && spec.columns[column].label) || column),
                    count,
                }))
                .sort((a, b) => b.count - a.count),
            warnings,
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}


const analyzeImport = (args) => processImport({ ...args, apply: false });
const commitImport = (args) => processImport({ ...args, apply: true });

// What the UI needs to decide which buttons to show.
function capabilitiesFor(user) {
    return { mayExport: isAdmin(user), mayImport: isSuperAdmin(user) };
}

module.exports = {
    exportCsv, analyzeImport, commitImport, capabilitiesFor, isSuperAdmin,
    GEOMETRY_HEADER,
};
