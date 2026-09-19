const { pool, writePool, invalidate } = require('./db');

const ADMIN_TYPES = ['system_admin', 'transport_authority'];
const ADMIN_FALLBACK_ROLES = ['Administrator', 'Operations Manager'];

function isAdmin(user) {
    return ADMIN_TYPES.includes(user.typeCode) || ADMIN_FALLBACK_ROLES.includes(user.role);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const nonNegativeInt = (max) => (value) => {
    if (typeof value === 'boolean') return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > max) return undefined;
    return n;
};

const uuid = (value) => (typeof value === 'string' && UUID_RE.test(value) ? value : undefined);

const PARKING_SOURCES = {
    parking: 'parking',
    bus_warehouse: 'bus_warehouses',
};

// Editable resources. Column names are whitelisted and every value passes a
// validator, so nothing from the request is interpolated into SQL.
const RESOURCES = {
    plans: {
        table: 'plans',
        columns: {
            number_of_buses: { validate: nonNegativeInt(10000), label: 'عدد الحافلات', type: 'number' },
            number_of_haj: { validate: nonNegativeInt(1000000), label: 'عدد الحجاج', type: 'number' },
            number_of_late_haj: { validate: nonNegativeInt(1000000), label: 'الحجاج المتأخرون', type: 'number' },
            number_of_early_haj: { validate: nonNegativeInt(1000000), label: 'الحجاج المبكرون', type: 'number' },
            number_of_trips: { validate: nonNegativeInt(10000), label: 'عدد الرحلات', type: 'number' },
            transport_type_id: {
                validate: uuid, label: 'نمط النقل', type: 'select', options: 'transport_types',
                // Must name a real transport type.
                check: { sql: 'SELECT 1 FROM transport_types WHERE id = $1', params: (v) => [v] },
            },
            timing_id: {
                validate: uuid, label: 'الفترة الزمنية', type: 'select', options: 'timings',
                // Timings belong to a plan type, so the chosen one must match this
                // plan's type — otherwise a تروية window could land on a نفرة plan.
                check: {
                    sql: `SELECT 1 FROM timing t
                          WHERE t.id = $1
                            AND t.plan_type_id IS NOT DISTINCT FROM (SELECT plan_type_id FROM plans WHERE id = $2)`,
                    params: (v, rowId) => [v, rowId],
                    message: 'الفترة الزمنية لا تخص نوع هذه الخطة',
                },
            },
        },
        // One incoming field that writes several columns. Parking id and its type
        // must always move together; splitting them breaks the view's union join.
        compound: {
            get_parking: { idColumn: 'get_parking_id', typeColumn: 'get_type_parking', label: 'موقف الانطلاق', options: 'parking' },
            set_parking: { idColumn: 'set_parking_id', typeColumn: 'set_type_parking', label: 'موقف الوصول', options: 'parking' },
        },
        ownership: (scope, nextParam) => {
            if (scope.kind === 'all') return { sql: 'TRUE', values: [] };
            if (scope.kind === 'center') return { sql: `owner_id = $${nextParam}`, values: [scope.id] };
            if (scope.kind === 'company') {
                return {
                    sql: `owner_id IN (SELECT id FROM service_centers WHERE company_id = $${nextParam})`,
                    values: [scope.id],
                };
            }
            return { sql: 'FALSE', values: [] };
        },
        invalidates: ['plans'],
    },
};

function mayEdit(user, resource) {
    if (!RESOURCES[resource]) return false;
    if (isAdmin(user)) return true;
    return resource === 'plans' && ['company', 'center'].includes((user.scope || {}).kind);
}

// A compound value arrives as "<source>:<uuid>", e.g. "parking:9f2c…".
function parseParking(value) {
    if (value === '' || value === null) return { id: null, type: null };
    if (typeof value !== 'string') return undefined;
    const [source, id] = value.split(':');
    if (!PARKING_SOURCES[source] || !uuid(id)) return undefined;
    return { id, type: source };
}

async function checkReferences(client, spec, clean, rowId) {
    const problems = [];
    for (const [column, value] of Object.entries(clean)) {
        const check = spec.columns[column] && spec.columns[column].check;
        if (!check || value === null) continue;
        const { rows } = await client.query(check.sql, check.params(value, rowId));
        if (!rows.length) {
            problems.push(`${column}: ${check.message || 'قيمة غير معروفة'}`);
        }
    }
    return problems;
}

async function checkParking(client, entries) {
    const problems = [];
    for (const [field, parsed] of entries) {
        if (!parsed.id) continue;
        const table = PARKING_SOURCES[parsed.type];
        const { rows } = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [parsed.id]);
        if (!rows.length) problems.push(`${field}: موقف غير معروف`);
    }
    return problems;
}

function validate(spec, patch) {
    const clean = {};
    const parking = [];
    const rejected = [];

    for (const [key, raw] of Object.entries(patch || {})) {
        if (spec.compound && spec.compound[key]) {
            const parsed = parseParking(raw);
            if (parsed === undefined) { rejected.push(`${key}: invalid value`); continue; }
            parking.push([key, parsed]);
            continue;
        }
        const column = spec.columns[key];
        if (!column) { rejected.push(`${key}: not editable`); continue; }
        // An empty string clears a nullable reference.
        if (raw === '' && column.type === 'select') { clean[key] = null; continue; }
        const value = column.validate(raw);
        if (value === undefined) { rejected.push(`${key}: invalid value`); continue; }
        clean[key] = value;
    }
    return { clean, parking, rejected };
}

async function updateRow({ resource, id, patch, user }) {
    if (!mayEdit(user, resource)) {
        return { ok: false, status: 403, error: 'Not permitted to edit this resource' };
    }
    if (!uuid(id)) return { ok: false, status: 400, error: 'Invalid id' };

    const spec = RESOURCES[resource];
    const { clean, parking, rejected } = validate(spec, patch);
    if (rejected.length) return { ok: false, status: 400, error: 'Invalid fields', rejected };
    if (!Object.keys(clean).length && !parking.length) {
        return { ok: false, status: 400, error: 'No editable fields supplied' };
    }

    const scope = isAdmin(user) ? { kind: 'all' } : (user.scope || { kind: 'none' });
    const client = await writePool.connect();

    try {
        await client.query('BEGIN');

        const refProblems = [
            ...await checkReferences(client, spec, clean, id),
            ...await checkParking(client, parking),
        ];
        if (refProblems.length) {
            await client.query('ROLLBACK');
            return { ok: false, status: 400, error: 'Invalid fields', rejected: refProblems };
        }

        const assignments = { ...clean };
        for (const [field, parsed] of parking) {
            const compound = spec.compound[field];
            assignments[compound.idColumn] = parsed.id;
            assignments[compound.typeColumn] = parsed.type;
        }

        const columns = Object.keys(assignments);
        const values = columns.map((c) => assignments[c]);
        const setSql = columns.map((c, i) => `${c} = $${i + 1}`).join(', ');
        const idParam = columns.length + 1;
        const own = spec.ownership(scope, idParam + 1);

        const before = await client.query(
            `SELECT ${columns.join(', ')} FROM ${spec.table} WHERE id = $1`, [id]
        );

        // Ownership lives in the WHERE clause rather than a prior SELECT, so a row
        // cannot change hands between the check and the write.
        const result = await client.query(
            `UPDATE ${spec.table} SET ${setSql}, updated_at = now()
             WHERE id = $${idParam} AND (${own.sql})
             RETURNING id, ${columns.join(', ')}`,
            [...values, id, ...own.values]
        );

        if (!result.rowCount) {
            await client.query('ROLLBACK');
            return { ok: false, status: 404, error: 'Not found or not permitted' };
        }

        await client.query('COMMIT');
        console.log(
            `[write] ${user.username} (${user.typeCode || user.role}) ${resource}/${id} ` +
            columns.map((c) => `${c}: ${before.rows[0]?.[c]} -> ${result.rows[0][c]}`).join(', ')
        );

        for (const dataset of spec.invalidates) invalidate(dataset);
        return { ok: true, row: result.rows[0], before: before.rows[0] || null };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function deleteRow({ resource, id, user }) {
    if (!mayEdit(user, resource)) {
        return { ok: false, status: 403, error: 'Not permitted to edit this resource' };
    }
    if (!uuid(id)) return { ok: false, status: 400, error: 'Invalid id' };

    const spec = RESOURCES[resource];
    const scope = isAdmin(user) ? { kind: 'all' } : (user.scope || { kind: 'none' });
    const own = spec.ownership(scope, 2);

    const client = await writePool.connect();
    try {
        const result = await client.query(
            `DELETE FROM ${spec.table} WHERE id = $1 AND (${own.sql}) RETURNING id`,
            [id, ...own.values]
        );
        if (!result.rowCount) return { ok: false, status: 404, error: 'Not found or not permitted' };

        console.log(`[write] ${user.username} (${user.typeCode || user.role}) DELETED ${resource}/${id}`);
        for (const dataset of spec.invalidates) invalidate(dataset);
        return { ok: true, id };
    } finally {
        client.release();
    }
}

// Dropdown contents for the editor. Read-only, so it uses the read pool.
let optionsCache = null;

async function getEditOptions() {
    if (optionsCache && Date.now() - optionsCache.builtAt < 300000) return optionsCache.data;

    const [transport, timings, parking] = await Promise.all([
        pool.query('SELECT id, name FROM transport_types ORDER BY name'),
        pool.query(`SELECT t.id, pt.code AS plan_type_code, pt.name AS plan_type_name,
                           to_char(t.start_at, 'HH24:MI') AS start_at,
                           to_char(t.end_at, 'HH24:MI')   AS end_at,
                           p.name AS period
                    FROM timing t
                    LEFT JOIN plan_types pt ON t.plan_type_id = pt.id
                    LEFT JOIN periods p     ON t.period_id = p.id
                    ORDER BY pt.name, t.start_at`),
        pool.query(`SELECT 'parking:' || id AS value, name, 'parking' AS source FROM parking
                    UNION ALL
                    SELECT 'bus_warehouse:' || id, name, 'bus_warehouse' FROM bus_warehouses
                    ORDER BY name`),
    ]);

    const data = {
        transport_types: transport.rows,
        timings: timings.rows.map((r) => ({
            id: r.id,
            plan_type_code: r.plan_type_code,
            plan_type_name: r.plan_type_name,
            // Raw times are kept so the editor can preselect the plan's current
            // timing; the CSV carries start/end times but not the timing id.
            start_at: r.start_at,
            end_at: r.end_at,
            period: r.period,
            label: `${r.start_at} - ${r.end_at}${r.period ? ` · ${r.period}` : ''}`,
        })),
        parking: parking.rows,
    };
    optionsCache = { data, builtAt: Date.now() };
    return data;
}

// Field descriptors the editor renders from, so the UI never hardcodes the list.
function fieldsFor(resource) {
    const spec = RESOURCES[resource];
    const fields = Object.entries(spec.columns).map(([name, col]) => ({
        name, label: col.label, type: col.type, options: col.options || null,
    }));
    for (const [name, c] of Object.entries(spec.compound || {})) {
        fields.push({ name, label: c.label, type: 'select', options: c.options });
    }
    return fields;
}

module.exports = { updateRow, deleteRow, mayEdit, isAdmin, RESOURCES, getEditOptions, fieldsFor };
