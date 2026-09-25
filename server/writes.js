const crypto = require('crypto');
const { pool, writePool, invalidate } = require('./db');
const { checkGeometry, GEOMETRY_TARGETS } = require('./geometry');

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

// ── Reference data (edit mode) ─────────────────────────────────────────────
// The geographic and lookup tables an admin maintains. Geometry stays
// read-only: the map draws the shape, the form edits only descriptive
// attributes and links to small lookup tables, so an edit here can never
// corrupt a shape that routed plans depend on.

const text = (max) => (value) => {
    const raw = typeof value === 'number' ? String(value) : value;
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (trimmed.length > max) return undefined;
    return trimmed === '' ? null : trimmed;
};

// NOT NULL columns: clearing them would fail in the database, so reject early.
const requiredText = (max) => (value) => {
    const cleaned = text(max)(value);
    return cleaned === null ? undefined : cleaned;
};

const fk = (table) => ({
    // `table` is named as well as baked into the SQL so a bulk import can check
    // a whole column's worth of references in one query instead of per row.
    table,
    sql: `SELECT 1 FROM ${table} WHERE id = $1`,
    params: (value) => [value],
});

function referenceResource(spec) {
    return {
        reference: true,
        order: 't.name',
        search: ['name'],
        readOnly: [],
        invalidates: ['plans'],
        // Shared data, so only a system admin may change it. Company and centre
        // users never reach here — mayEdit() stops them at the door, and this
        // clause stops them again inside the UPDATE/DELETE.
        ownership: (scope) => (scope.kind === 'all' ? { sql: 'TRUE', values: [] } : { sql: 'FALSE', values: [] }),
        ...spec,
    };
}

const centroid = (axis) => `ST_${axis}(ST_Centroid(t.gis))`;

Object.assign(RESOURCES, {
    residences: referenceResource({
        table: 'residences', label: 'المساكن', icon: 'fa-house',
        // No geometry column: a residence's location is two numeric columns,
        // so a drawn point is written into these rather than into a shape.
        pointColumns: { lon: 'longitude', lat: 'latitude' },
        scoped: ({ plans }) => `EXISTS (SELECT 1 FROM plans p WHERE p.start_point_type = 'residence' AND p.start_point_id = t.id${plans})`,
        stats: {
            sql: ({ plans }) => `
                WITH per AS (
                    SELECT p.start_point_id AS rid,
                           coalesce(sum(p.number_of_haj) FILTER (WHERE pt.code = 'tarwia'), 0) AS tar,
                           coalesce(sum(p.number_of_haj) FILTER (WHERE pt.code = 'direct_taseed'), 0) AS dir
                    FROM plans p
                    JOIN plan_types pt ON pt.id = p.plan_type_id
                    WHERE p.start_point_type = 'residence'
                      AND pt.code IN ('tarwia', 'direct_taseed')${plans}
                    GROUP BY 1
                )
                SELECT count(*) FILTER (WHERE tar > 0 AND dir = 0)::int AS tarwia_res,
                       coalesce(sum(tar) FILTER (WHERE tar > 0 AND dir = 0), 0)::int AS tarwia_haj,
                       count(*) FILTER (WHERE dir > 0 AND tar = 0)::int AS direct_res,
                       coalesce(sum(dir) FILTER (WHERE dir > 0 AND tar = 0), 0)::int AS direct_haj,
                       count(*) FILTER (WHERE tar > 0 AND dir > 0)::int AS mixed_res,
                       coalesce(sum(tar + dir) FILTER (WHERE tar > 0 AND dir > 0), 0)::int AS mixed_haj
                FROM per`,
            tiles: [
                { icon: 'fa-house', label: 'مساكن تروية', value: 'tarwia_res', sub: 'tarwia_haj', subUnit: 'حاج',
                  title: 'مساكن لها خطط تروية فقط، ومجموع حجّاجها' },
                { icon: 'fa-house-circle-check', label: 'مساكن تصعيد مباشر', value: 'direct_res', sub: 'direct_haj', subUnit: 'حاج',
                  title: 'مساكن لها خطط تصعيد مباشر فقط، ومجموع حجّاجها' },
                { icon: 'fa-house-flag', label: 'مساكن مختلطة', value: 'mixed_res', sub: 'mixed_haj', subUnit: 'حاج',
                  title: 'مساكن لها خطط تروية وتصعيد مباشر معاً، ومجموع حجّاجها في المرحلتين' },
            ],
        },
        // All house-family glyphs so a residence reads as a home at a glance,
        // while the type still distinguishes a hotel from a seasonal lodge.
        // Every class below exists in the Font Awesome 6.4 build the page loads.
        iconBy: {
            sql: 't.type',
            label: 'نوع المسكن',
            fallback: 'fa-house',
            map: {
                'فنادق': 'fa-house',
                'شقق فندقية': 'fa-house-chimney-window',
                'شقق مخدومة': 'fa-house-user',
                'نزل سياحية': 'fa-house-chimney',
                'النزل خلال موسم الحج (المؤقتة)': 'fa-house-flag',
            },
        },
        colorBy: { sql: 't.area', label: 'الحي' },
        list: ['name', 'license_number', 'area', 'city'],
        search: ['name', 'license_number', 'area'],
        anchor: { lon: 't.longitude', lat: 't.latitude' },
        readOnly: ['longitude', 'latitude'],
        invalidates: ['plans', 'assign-residences'],
        columns: {
            name: { validate: requiredText(200), label: 'الاسم', type: 'text', required: true },
            license_number: { validate: text(50), label: 'رقم الرخصة', type: 'text' },
            area: { validate: text(120), label: 'الحي', type: 'text' },
            city: { validate: text(120), label: 'المدينة', type: 'text' },
            type: { validate: text(60), label: 'النوع', type: 'text' },
        },
    }),
    camps: referenceResource({
        table: 'camps', label: 'المخيمات', icon: 'fa-tent',
        scoped: ({ plans }) => `EXISTS (SELECT 1 FROM plans p WHERE ((p.start_point_type = 'camp' AND p.start_point_id = t.id) OR (p.end_point_type = 'camp' AND p.end_point_id = t.id))${plans})`,
        colorBy: { sql: '(SELECT pl.name FROM platforms pl WHERE pl.id = t.platform_id)', label: 'المشعر' },
        list: ['name', 'gate', 'street', 'block', 'capacity'],
        search: ['name', 'gate', 'street', 'block'],
        geom: 'gis',
        anchor: { lon: centroid('X'), lat: centroid('Y') },
        readOnly: ['shape_area', 'gate_lat', 'gate_lon', 'objectid'],
        invalidates: ['plans', 'camps-gates', 'assign-camps'],
        columns: {
            name: { validate: requiredText(120), label: 'اسم المخيم', type: 'text', required: true },
            gate: { validate: text(60), label: 'البوابة', type: 'text' },
            street: { validate: text(120), label: 'الشارع', type: 'text' },
            block: { validate: text(60), label: 'المربع', type: 'text' },
            square: { validate: text(60), label: 'المخطط', type: 'text' },
            type: { validate: text(60), label: 'النوع', type: 'text' },
            capacity: { validate: nonNegativeInt(1000000), label: 'الطاقة الاستيعابية', type: 'number' },
            platform_id: { validate: uuid, label: 'المشعر', type: 'select', options: 'platforms', check: fk('platforms') },
            entrance_id: { validate: uuid, label: 'المدخل', type: 'select', options: 'entrances', check: fk('entrances') },
            transport_type_id: { validate: uuid, label: 'نمط النقل', type: 'select', options: 'transport_types', check: fk('transport_types') },
            drop_off_area_id: { validate: uuid, label: 'ساحة الإنزال', type: 'select', options: 'drop_off_areas', check: fk('drop_off_areas') },
        },
    }),
    paths: referenceResource({
        table: 'paths', label: 'مسارات المخيمات', icon: 'fa-route',
        // A path is a line, and a glyph parked at its midpoint says nothing
        // about where it runs — it only adds a marker to collide with the camps
        // and entrances the line connects. So the records wear no icon; the
        // colour (the path's role) carries the identity instead.
        mapIcon: false,
        scoped: ({ plans }) => `EXISTS (SELECT 1 FROM plans p WHERE p.path_id = t.id${plans})`,
        // transport_type_id is null on every path, so colour by the role the
        // camps give it instead — which also surfaces the unused ones.
        colorBy: {
            label: 'الدور',
            sql: `(CASE
                     WHEN EXISTS (SELECT 1 FROM camps c WHERE c.path_entrance_id = t.id) THEN 'مدخل ← مخيم'
                     WHEN EXISTS (SELECT 1 FROM camps c WHERE c.path_camp_id = t.id)     THEN 'منى ← عرفات'
                     WHEN EXISTS (SELECT 1 FROM camps c WHERE c.path_dropoff_id = t.id)  THEN 'مخيم ← ساحة إنزال'
                     ELSE 'غير مستخدم'
                   END)`,
        },
        list: ['name', 'code'],
        search: ['name', 'code'],
        geom: 'gis',
        anchor: { lon: centroid('X'), lat: centroid('Y') },
        readOnly: ['objectid'],
        // transport_type_id is deliberately not editable here: it is NULL on all
        // 4,974 rows and nothing reads it. A path is a drawn line shared by up to
        // three camps, and the plans that run over it carry their own transport
        // type — so a single type on the path could only ever contradict them.
        columns: {
            name: { validate: requiredText(200), label: 'الاسم', type: 'text', required: true },
            code: { validate: text(120), label: 'الرمز', type: 'text' },
        },
    }),
    entrances: referenceResource({
        table: 'entrances', label: 'المداخل', icon: 'fa-door-open',
        scoped: ({ plans }) => `EXISTS (SELECT 1 FROM plans p WHERE p.entrance_id = t.id${plans})`,
        colorBy: { sql: '(SELECT pl.name FROM platforms pl WHERE pl.id = t.platform_id)', label: 'المشعر' },
        list: ['name', 'asm_code', 'capacity'],
        search: ['name', 'asm_code'],
        geom: 'gis',
        anchor: { lon: `COALESCE(t.longitude, ${centroid('X')})`, lat: `COALESCE(t.latitude, ${centroid('Y')})` },
        readOnly: ['longitude', 'latitude', 'shape_area', 'objectid'],
        invalidates: ['plans', 'camps-gates'],
        columns: {
            name: { validate: requiredText(200), label: 'الاسم', type: 'text', required: true },
            asm_code: { validate: text(40), label: 'رمز ASM', type: 'text' },
            capacity: { validate: nonNegativeInt(1000000), label: 'الطاقة', type: 'number' },
            platform_id: { validate: uuid, label: 'المشعر', type: 'select', options: 'platforms', check: fk('platforms') },
        },
    }),
    parking: referenceResource({
        table: 'parking', label: 'المواقف', icon: 'fa-square-parking',
        scoped: ({ plans }) => `EXISTS (SELECT 1 FROM plans p WHERE ((p.get_type_parking = 'parking' AND p.get_parking_id = t.id) OR (p.set_type_parking = 'parking' AND p.set_parking_id = t.id))${plans})`,
        colorBy: { sql: 't.street', label: 'الشارع' },
        list: ['name', 'area', 'street', 'capacity'],
        search: ['name', 'area', 'street'],
        geom: 'gis',
        anchor: { lon: centroid('X'), lat: centroid('Y') },
        readOnly: ['shape_area', 'objectid'],
        columns: {
            name: { validate: requiredText(200), label: 'الاسم', type: 'text', required: true },
            area: { validate: text(120), label: 'المنطقة', type: 'text' },
            street: { validate: text(120), label: 'الشارع', type: 'text' },
            capacity: { validate: nonNegativeInt(1000000), label: 'الطاقة', type: 'number' },
        },
    }),
    bus_stops: referenceResource({
        table: 'bus_stops', label: 'محطات الحافلات', icon: 'fa-bus-simple',
        scoped: ({ plans }) => `EXISTS (SELECT 1 FROM plans p WHERE p.end_point_type = 'bus_stop' AND p.end_point_id = t.id${plans})`,
        colorBy: { sql: 't.area', label: 'المنطقة' },
        list: ['name', 'area'],
        search: ['name', 'area'],
        geom: 'gis',
        anchor: { lon: centroid('X'), lat: centroid('Y') },
        readOnly: ['shape_area', 'objectid'],
        columns: {
            name: { validate: requiredText(200), label: 'الاسم', type: 'text', required: true },
            area: { validate: text(120), label: 'المنطقة', type: 'text' },
        },
    }),
    bus_warehouses: referenceResource({
        table: 'bus_warehouses', label: 'المخازن', icon: 'fa-warehouse',
        scoped: ({ plans }) => `EXISTS (SELECT 1 FROM plans p WHERE ((p.get_type_parking = 'bus_warehouse' AND p.get_parking_id = t.id) OR (p.set_type_parking = 'bus_warehouse' AND p.set_parking_id = t.id))${plans})`,
        colorBy: { sql: 't.area', label: 'المنطقة' },
        list: ['name', 'area', 'city', 'capacity'],
        search: ['name', 'area', 'city'],
        geom: 'gis',
        anchor: { lon: centroid('X'), lat: centroid('Y') },
        readOnly: ['shape_area', 'objectid'],
        columns: {
            name: { validate: requiredText(200), label: 'الاسم', type: 'text', required: true },
            area: { validate: text(120), label: 'المنطقة', type: 'text' },
            city: { validate: text(120), label: 'المدينة', type: 'text' },
            capacity: { validate: nonNegativeInt(1000000), label: 'الطاقة', type: 'number' },
        },
    }),
    drop_off_areas: referenceResource({
        table: 'drop_off_areas', label: 'ساحات الانزال', icon: 'fa-flag',
        scoped: ({ plans }) => `EXISTS (SELECT 1 FROM plans p WHERE p.end_point_type = 'dropOffArea' AND p.end_point_id = t.id${plans})`,
        colorBy: { sql: 't.street', label: 'المسار' },
        list: ['name', 'area', 'street'],
        search: ['name', 'area', 'street'],
        geom: 'gis',
        anchor: { lon: centroid('X'), lat: centroid('Y') },
        readOnly: ['shape_area', 'objectid'],
        columns: {
            name: { validate: requiredText(200), label: 'الاسم', type: 'text', required: true },
            area: { validate: text(120), label: 'المنطقة', type: 'text' },
            street: { validate: text(120), label: 'الشارع', type: 'text' },
        },
    }),
    transport_companies: referenceResource({
        table: 'transport_companies', label: 'شركات النقل', icon: 'fa-truck-moving',
        scoped: ({ centers }) => `EXISTS (SELECT 1 FROM mashaers_trips mt WHERE mt.transport_company_name_ar = t.name${centers})`,
        list: ['name'],
        invalidates: [],
        columns: {
            name: { validate: requiredText(200), label: 'الاسم', type: 'text', required: true },
        },
    }),
});

function mayEdit(user, resource) {
    if (!RESOURCES[resource]) return false;
    if (isAdmin(user)) return true;
    return resource === 'plans' && ['company', 'center'].includes((user.scope || {}).kind);
}

// Reference data is shared: a company or centre user needs to see the camps,
// residences and entrances their own plans point at, but must not change data
// every other centre depends on. So viewing is open to any scoped user and
// writing stays with mayEdit — admins only for these tables.
function mayView(user, resource) {
    const spec = RESOURCES[resource];
    if (!spec) return false;
    if (mayEdit(user, resource)) return true;
    return Boolean(spec.reference) && ['company', 'center'].includes((user.scope || {}).kind);
}

// The entity list the edit-mode nav renders, each flagged with whether this
// user may write to it so the UI can render the form read-only.
function catalogFor(user) {
    return Object.entries(RESOURCES)
        .filter(([name, spec]) => spec.reference && mayView(user, name))
        .map(([name, spec]) => ({
            name, label: spec.label, icon: spec.icon,
            geometry: Boolean(spec.geom),
            // What the map editor should let you draw here: a polygon, a line,
            // a single point, or nothing at all.
            geometryKind: spec.pointColumns
                ? 'point'
                : (spec.geom ? ((GEOMETRY_TARGETS[name] || {}).family === 'linear' ? 'linear' : 'areal') : null),
            // Whether records of this entity wear the icon as a data mark (on
            // the map and in the grid). The nav still uses `icon` as its label
            // glyph either way.
            mapIcon: spec.mapIcon !== false,
            editable: mayEdit(user, name),
        }));
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

// The record form can redraw a shape on the map, so writes carry an optional
// `geometry` field: a GeoJSON string. It is not a column — residences have no
// shape at all and store a point as two numeric columns — so it is resolved
// here rather than in validate().
const GEOMETRY_FIELD = 'geometry';

function wantsGeometry(spec, patch) {
    return Object.prototype.hasOwnProperty.call(patch || {}, GEOMETRY_FIELD)
        && (spec.geom || spec.pointColumns);
}

// Turn the drawn GeoJSON into what this entity actually stores: an EWKT shape
// for the seven tables with a `gis` column, or a longitude/latitude pair for
// residences, which have no geometry column.
async function resolveGeometry(client, resource, spec, raw) {
    const text = raw === null || raw === undefined ? '' : String(raw).trim();
    if (!text) return { clear: true };

    if (spec.pointColumns) {
        let point = null;
        try { point = JSON.parse(text); } catch (_e) { return { error: 'geometry: تعذر قراءة الشكل' }; }
        const coords = point && point.type === 'Point' && Array.isArray(point.coordinates)
            ? point.coordinates : null;
        if (!coords || coords.length < 2) return { error: 'geometry: هذا العنصر يقبل نقطة فقط' };
        const [lon, lat] = coords.map(Number);
        if (!Number.isFinite(lon) || lon < -180 || lon > 180) return { error: 'geometry: خط طول خارج النطاق' };
        if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { error: 'geometry: دائرة عرض خارج النطاق' };
        return { point: { [spec.pointColumns.lon]: lon, [spec.pointColumns.lat]: lat } };
    }

    // The same checker the CSV import uses: SRID forced to 4326, 2D, valid, and
    // coerced to whatever type the column declares.
    const result = await checkGeometry(client, resource, text);
    if (result.error) return { error: `geometry: ${result.error}` };
    return { ewkt: result.ewkt };
}

async function updateRow({ resource, id, patch, user }) {
    if (!mayEdit(user, resource)) {
        return { ok: false, status: 403, error: 'Not permitted to edit this resource' };
    }
    if (!uuid(id)) return { ok: false, status: 400, error: 'Invalid id' };

    const spec = RESOURCES[resource];
    // Geometry is not a column, so it is pulled out before validate() sees it.
    const geometryWanted = wantsGeometry(spec, patch);
    const geometryRaw = geometryWanted ? patch[GEOMETRY_FIELD] : undefined;
    const rest = { ...patch };
    delete rest[GEOMETRY_FIELD];

    const { clean, parking, rejected } = validate(spec, rest);
    if (rejected.length) return { ok: false, status: 400, error: 'Invalid fields', rejected };
    if (!Object.keys(clean).length && !parking.length && !geometryWanted) {
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
        let geometrySql = null;
        if (geometryWanted) {
            const resolved = await resolveGeometry(client, resource, spec, geometryRaw);
            if (resolved.error) {
                await client.query('ROLLBACK');
                return { ok: false, status: 400, error: 'Invalid fields', rejected: [resolved.error] };
            }
            if (resolved.point) Object.assign(assignments, resolved.point);
            else if (resolved.clear) {
                if (spec.pointColumns) {
                    assignments[spec.pointColumns.lon] = null;
                    assignments[spec.pointColumns.lat] = null;
                } else geometrySql = { sql: 'NULL', value: null };
            } else geometrySql = { sql: 'ST_GeomFromEWKT(', value: resolved.ewkt };
        }
        for (const [field, parsed] of parking) {
            const compound = spec.compound[field];
            assignments[compound.idColumn] = parsed.id;
            assignments[compound.typeColumn] = parsed.type;
        }

        const columns = Object.keys(assignments);
        const values = columns.map((c) => assignments[c]);
        const setSql = columns.map((c, i) => `${c} = $${i + 1}`);
        if (geometrySql) {
            if (geometrySql.value === null) setSql.push(`${spec.geom} = NULL`);
            else {
                values.push(geometrySql.value);
                setSql.push(`${spec.geom} = ST_GeomFromEWKT($${values.length})`);
            }
        }
        const idParam = values.length + 1;
        const own = spec.ownership(scope, idParam + 1);

        // A geometry-only edit touches no column, so fall back to the id rather
        // than building `SELECT  FROM`.
        const before = await client.query(
            `SELECT ${columns.length ? columns.join(', ') : 'id'} FROM ${spec.table} WHERE id = $1`, [id]
        );

        // Ownership lives in the WHERE clause rather than a prior SELECT, so a row
        // cannot change hands between the check and the write.
        const result = await client.query(
            `UPDATE ${spec.table} SET ${setSql.join(', ')}, updated_at = now()
             WHERE id = $${idParam} AND (${own.sql})
             RETURNING id${columns.length ? ', ' + columns.join(', ') : ''}`,
            [...values, id, ...own.values]
        );

        if (!result.rowCount) {
            await client.query('ROLLBACK');
            return { ok: false, status: 404, error: 'Not found or not permitted' };
        }

        await client.query('COMMIT');
        console.log(
            `[write] ${user.username} (${user.typeCode || user.role}) ${resource}/${id} ` +
            (columns.map((c) => `${c}: ${before.rows[0]?.[c]} -> ${result.rows[0][c]}`)
                .concat(geometrySql ? ['geometry redrawn'] : []).join(', ') || 'no column change')
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

    const [transport, timings, parking, platforms, entrances, dropOffs] = await Promise.all([
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
        pool.query('SELECT id, name FROM platforms ORDER BY name'),
        pool.query("SELECT id, COALESCE(asm_code || ' — ', '') || name AS name FROM entrances ORDER BY asm_code NULLS LAST, name"),
        pool.query('SELECT id, name FROM drop_off_areas ORDER BY name'),
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
        platforms: platforms.rows,
        entrances: entrances.rows,
        drop_off_areas: dropOffs.rows,
    };
    optionsCache = { data, builtAt: Date.now() };
    return data;
}

// ── Reference data reads and creates ───────────────────────────────────────
// `list`, `search`, `order` and `anchor` are developer-defined constants, never
// request input, so they are safe to interpolate; the search term is bound.

// Reference tables have no owner column, so "belongs to this user" is derived
// from what their own plans (or bus roster) reference. Admins get empty clauses,
// which makes the same predicate mean "used by anyone".
const SCOPE_ALL = { plans: '', centers: '' };

function scopeClausesFor(user) {
    if (isAdmin(user)) return SCOPE_ALL;
    const scope = user.scope || {};
    const id = uuid(scope.id);
    if (scope.kind === 'center' && id) {
        return {
            plans: ` AND p.owner_id = '${id}'`,
            centers: ` AND mt.service_center_id = '${id}'`,
        };
    }
    if (scope.kind === 'company' && id) {
        const centres = `(SELECT id FROM service_centers WHERE company_id = '${id}')`;
        return { plans: ` AND p.owner_id IN ${centres}`, centers: ` AND mt.service_center_id IN ${centres}` };
    }
    return { plans: ' AND FALSE', centers: ' AND FALSE' };
}

const LIST_LIMIT_DEFAULT = 60;
// High enough that the UI can ask for a whole entity in one request — the
// largest is paths at ~5k. Geometry is simplified for the list, and the API is
// gzipped, so even the big ones stay a few hundred KB on the wire.
const LIST_LIMIT_MAX = 6000;

// `t.area` -> 'area'; a subquery or expression -> null. Lets the client know
// when a derived value is really just one of the table's own columns.
function plainColumn(sql) {
    const match = /^\s*t\.([a-z_][a-z0-9_]*)\s*$/i.exec(String(sql || ''));
    return match ? match[1] : null;
}

function referenceSpec(resource, user) {
    const spec = RESOURCES[resource];
    if (!spec || !spec.reference) return { error: { ok: false, status: 404, error: 'Unknown entity' } };
    if (!mayView(user, resource)) return { error: { ok: false, status: 403, error: 'Not permitted' } };
    return { spec };
}

async function listRows({ resource, user, q = '', filter = null, limit, offset = 0 }) {
    const { spec, error } = referenceSpec(resource, user);
    if (error) return error;

    const columns = [...new Set(['id', ...spec.list])].map((c) => `t.${c}`);
    if (spec.anchor) columns.push(`${spec.anchor.lon} AS lon`, `${spec.anchor.lat} AS lat`);
    // Real shapes so the map can draw the records rather than centroid dots.
    // Simplified to ~3m and trimmed to 6 decimals: indistinguishable at map
    // zoom, but a whole page of polygons stays a sane payload. The detail
    // endpoint still serves the exact geometry for the selected record.
    if (spec.geom) {
        columns.push(
            `ST_AsGeoJSON(COALESCE(ST_SimplifyPreserveTopology(t.${spec.geom}, 0.00003), t.${spec.geom}), 6) AS geojson`
        );
    }
    // The value the map colours by — platform, district, street or transport
    // type, whichever actually distinguishes this entity's records.
    if (spec.colorBy) columns.push(`${spec.colorBy.sql} AS color_key`);
    // Which glyph each record wears, when the entity varies it by a column.
    if (spec.iconBy) columns.push(`${spec.iconBy.sql} AS icon_key`);

    // The KPI tiles double as filters: each one narrows the list and the map to
    // the rows it counts. The tile values themselves stay table-wide, so the
    // numbers do not move when you filter by one of them.
    const clauses = [];
    const params = [];
    const term = String(q || '').trim();

    // A company or centre user sees only the records their own plans (or bus
    // roster) reference; an admin sees the whole table. Applied to the rows and
    // to every count, so the tiles describe what the user can actually see.
    const admin = isAdmin(user);
    const visible = admin ? null : (spec.scoped ? spec.scoped(scopeClausesFor(user)) : 'FALSE');
    if (visible) clauses.push(visible);
    const scopeSql = visible ? ` WHERE ${visible}` : '';
    if (term && spec.search.length) {
        params.push(`%${term}%`);
        clauses.push(`(${spec.search.map((c) => `t.${c}::text ILIKE $1`).join(' OR ')})`);
    }

    const located = spec.geom
        ? `t.${spec.geom} IS NOT NULL`
        : (spec.anchor ? `${spec.anchor.lon} IS NOT NULL AND ${spec.anchor.lat} IS NOT NULL` : null);

    const globalUsage = admin && spec.scoped ? spec.scoped(SCOPE_ALL) : null;
    const FILTERS = {
        used: globalUsage,
        unused: globalUsage ? `NOT (${globalUsage})` : null,
        located,
        unlocated: located ? `NOT (${located})` : null,
    };
    const filterKey = Object.prototype.hasOwnProperty.call(FILTERS, String(filter)) ? String(filter) : null;
    const filterSql = filterKey ? FILTERS[filterKey] : null;
    if (filterSql) clauses.push(filterSql);

    const where = clauses.length ? clauses.join(' AND ') : 'TRUE';

    const take = Math.min(LIST_LIMIT_MAX, Math.max(1, Number(limit) || LIST_LIMIT_DEFAULT));
    const skip = Math.max(0, Number(offset) || 0);

    // Totals are table-wide and ignore the search: they describe the data, not
    // the page. `used` counts the rows the plans actually reference.
    const [rows, total, used, locatable, stats] = await Promise.all([
        pool.query(
            `SELECT ${columns.join(', ')} FROM ${spec.table} t
             WHERE ${where} ORDER BY ${spec.order} NULLS LAST LIMIT ${take} OFFSET ${skip}`,
            params
        ),
        pool.query(`SELECT count(*)::int AS n FROM ${spec.table} t${scopeSql}`),
        // "Used in plans" only distinguishes anything for an admin: a scoped
        // user's rows are, by definition, the ones their plans use.
        admin && spec.scoped
            ? pool.query(`SELECT count(*)::int AS n FROM ${spec.table} t WHERE ${spec.scoped(SCOPE_ALL)}`)
            : Promise.resolve({ rows: [{ n: null }] }),
        located
            ? pool.query(`SELECT count(*)::int AS n FROM ${spec.table} t WHERE ${located}${visible ? ` AND ${visible}` : ''}`)
            : Promise.resolve({ rows: [{ n: null }] }),
        // Entity-specific figures, scoped the same way as the rows.
        spec.stats
            ? pool.query(spec.stats.sql(scopeClausesFor(user)))
            : Promise.resolve({ rows: [null] }),
    ]);
    const matched = clauses.length
        ? (await pool.query(`SELECT count(*)::int AS n FROM ${spec.table} t WHERE ${where}`, params)).rows[0].n
        : total.rows[0].n;

    return {
        ok: true,
        resource,
        label: spec.label,
        rows: rows.rows,
        columns: spec.list,
        // Arabic headers for the grid view, from the same descriptors the form
        // uses — so a column is never labelled one way in the table and another
        // in the editor.
        columnLabels: spec.list.reduce((acc, name) => {
            acc[name] = (spec.columns[name] && spec.columns[name].label) || name;
            return acc;
        }, {}),
        editable: mayEdit(user, resource),
        // `column` is set only when the discriminant is a plain column of this
        // table, so the grid can tell that e.g. parking's colour key and its
        // "الشارع" column are the same data and not show it twice.
        colorBy: spec.colorBy
            ? { label: spec.colorBy.label, column: plainColumn(spec.colorBy.sql) }
            : null,
        icons: spec.iconBy
            ? {
                label: spec.iconBy.label, map: spec.iconBy.map,
                fallback: spec.iconBy.fallback, column: plainColumn(spec.iconBy.sql),
            }
            : null,
        total: total.rows[0].n,
        matched,
        used: used.rows[0].n,
        locatable: locatable.rows[0].n,
        stats: spec.stats ? { values: stats.rows[0], tiles: spec.stats.tiles } : null,
        filter: filterKey,
        limit: take,
        offset: skip,
    };
}

async function readRow({ resource, id, user }) {
    const { spec, error } = referenceSpec(resource, user);
    if (error) return error;
    if (!uuid(id)) return { ok: false, status: 400, error: 'Invalid id' };

    const columns = [...new Set(['id', ...Object.keys(spec.columns), ...spec.readOnly])].map((c) => `t.${c}`);
    if (spec.anchor) columns.push(`${spec.anchor.lon} AS lon`, `${spec.anchor.lat} AS lat`);
    // The shape is sent so the map can draw it; it is never written back.
    if (spec.geom) columns.push(`ST_AsGeoJSON(t.${spec.geom}) AS geojson`);

    const visible = isAdmin(user) ? null : (spec.scoped ? spec.scoped(scopeClausesFor(user)) : 'FALSE');
    const { rows } = await pool.query(
        `SELECT ${columns.join(', ')} FROM ${spec.table} t WHERE t.id = $1${visible ? ` AND ${visible}` : ''}`,
        [id]
    );
    if (!rows.length) return { ok: false, status: 404, error: 'Not found' };
    return { ok: true, row: rows[0], readOnly: spec.readOnly };
}

async function createRow({ resource, values, user }) {
    const { spec, error } = referenceSpec(resource, user);
    if (error) return error;
    // Creating shared reference data is an admin action, with no existing row
    // for the ownership clause to test.
    if (!isAdmin(user)) return { ok: false, status: 403, error: 'Not permitted' };

    const geometryWanted = wantsGeometry(spec, values);
    const geometryRaw = geometryWanted ? values[GEOMETRY_FIELD] : undefined;
    const rest = { ...values };
    delete rest[GEOMETRY_FIELD];

    const { clean, rejected } = validate(spec, rest);
    for (const [name, column] of Object.entries(spec.columns)) {
        if (column.required && (clean[name] === undefined || clean[name] === null)) {
            rejected.push(`${name}: ${column.label} مطلوب`);
        }
    }
    if (rejected.length) return { ok: false, status: 400, error: 'Invalid fields', rejected };

    const client = await writePool.connect();
    try {
        await client.query('BEGIN');
        const refProblems = await checkReferences(client, spec, clean, null);
        if (refProblems.length) {
            await client.query('ROLLBACK');
            return { ok: false, status: 400, error: 'Invalid fields', rejected: refProblems };
        }

        const assignments = { ...clean };
        let geometryEwkt = null;
        if (geometryWanted) {
            const resolved = await resolveGeometry(client, resource, spec, geometryRaw);
            if (resolved.error) {
                await client.query('ROLLBACK');
                return { ok: false, status: 400, error: 'Invalid fields', rejected: [resolved.error] };
            }
            if (resolved.point) Object.assign(assignments, resolved.point);
            else if (!resolved.clear) geometryEwkt = resolved.ewkt;
        }

        const id = crypto.randomUUID();
        const columns = Object.keys(assignments);
        const params = [id, ...columns.map((c) => assignments[c])];
        const names = [...columns];
        const placeholders = columns.map((_, i) => `$${i + 2}`);
        if (geometryEwkt) {
            params.push(geometryEwkt);
            names.push(spec.geom);
            placeholders.push(`ST_GeomFromEWKT($${params.length})`);
        }
        const result = await client.query(
            `INSERT INTO ${spec.table} (id${names.length ? ', ' + names.join(', ') : ''}, created_at, updated_at)
             VALUES ($1${placeholders.length ? ', ' + placeholders.join(', ') : ''}, now(), now())
             RETURNING id`,
            params
        );
        await client.query('COMMIT');

        console.log(`[write] ${user.username} (${user.typeCode || user.role}) CREATED ${resource}/${id}`);
        for (const dataset of spec.invalidates) invalidate(dataset);
        return { ok: true, id: result.rows[0].id };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// Field descriptors the editor renders from, so the UI never hardcodes the list.
function geometryKindFor(resource) {
    const spec = RESOURCES[resource];
    if (!spec) return null;
    if (spec.pointColumns) return 'point';
    if (!spec.geom) return null;
    return (GEOMETRY_TARGETS[resource] || {}).family === 'linear' ? 'linear' : 'areal';
}

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

module.exports = {
    updateRow, deleteRow, createRow, listRows, readRow,
    mayEdit, mayView, isAdmin, catalogFor, RESOURCES, getEditOptions, fieldsFor,
    geometryKindFor,
};
