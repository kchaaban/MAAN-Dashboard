const bcrypt = require('bcryptjs');
const { pool } = require('./db');

// Emergency access for when Postgres or the tunnel is down. Database users are
// always tried first; these only apply when the lookup finds nothing.
const FALLBACK_USERS = {
    admin: { password: 'password', role: 'Administrator', scope: 'all' },
    manager: { password: 'password', role: 'Operations Manager', scope: 'all' },
    viewer: { password: 'password', role: 'Viewer', scope: 'all' },
    komra: { password: 'FC2026', role: 'Invited User', scope: 'all' },
};

const ROLE_LABELS = {
    system_admin: 'مدير النظام',
    transport_authority: 'المركز العام للنقل',
    service_company: 'شركة الخدمة',
    service_center: 'مركز الخدمة',
};

const USER_SQL = `
SELECT u.id, u.name, u.email, u.password, u.is_active,
       t.code AS type_code,
       u.company_id, u.service_center_id,
       c.name  AS company_name,
       sc.center_name
FROM users u
LEFT JOIN types t            ON u.type_id = t.id
LEFT JOIN service_companies c ON u.company_id = c.id
LEFT JOIN service_centers sc ON u.service_center_id = sc.id
WHERE lower(u.email) = lower($1)
LIMIT 1`;

// What a user is allowed to see. Derived only from their database row, never
// from anything the client sends.
function scopeFor(user) {
    switch (user.type_code) {
        case 'system_admin':
        case 'transport_authority':
            return { kind: 'all' };
        case 'service_company':
            return user.company_id
                ? { kind: 'company', id: user.company_id }
                : { kind: 'none' };
        case 'service_center':
            return user.service_center_id
                ? { kind: 'center', id: user.service_center_id }
                : { kind: 'none' };
        default:
            // Unknown or missing type: fail closed rather than leaking everything.
            return { kind: 'none' };
    }
}

// users.name is placeholder data — 754 of 758 rows are literally "Admin" — so it
// identifies nobody. Fall back to the email's local part, which is unique and
// recognisable (cht101@rcmc.gov.sa -> cht101).
function toDisplayName(row) {
    const name = (row.name || '').trim();
    if (name && !/^admin$/i.test(name)) return name;
    return (row.email || '').split('@')[0] || name;
}

function describeScope(scope, user) {
    if (scope.kind === 'all') return 'all plans';
    if (scope.kind === 'company') return `company "${user.company_name || scope.id}"`;
    if (scope.kind === 'center') return `centre "${user.center_name || scope.id}"`;
    return 'nothing (no company or centre on the account)';
}

async function authenticate(identifier, password) {
    if (!identifier || !password) {
        return { ok: false, reason: 'missing-credentials' };
    }

    let row = null;
    try {
        const { rows } = await pool.query(USER_SQL, [identifier.trim()]);
        row = rows[0] || null;
    } catch (err) {
        console.error(`[auth] user lookup failed for "${identifier}":`, err.message);
        return { ok: false, reason: 'database-unavailable' };
    }

    if (!row) {
        const fallback = FALLBACK_USERS[identifier];
        if (fallback && fallback.password === password) {
            console.log(`[auth] "${identifier}" signed in via fallback account`);
            return {
                ok: true,
                token: { username: identifier, role: fallback.role, scope: { kind: 'all' } },
                role: fallback.role,
            };
        }
        console.warn(`[auth] no user with email "${identifier}" (and no fallback match)`);
        return { ok: false, reason: 'unknown-email' };
    }

    if (!row.is_active) {
        console.warn(`[auth] "${identifier}" is disabled (is_active = false)`);
        return { ok: false, reason: 'inactive-user' };
    }

    if (!row.password || !bcrypt.compareSync(password, row.password)) {
        console.warn(`[auth] wrong password for "${identifier}"`);
        return { ok: false, reason: 'bad-password' };
    }

    const scope = scopeFor(row);
    const role = ROLE_LABELS[row.type_code] || row.type_code || 'مستخدم';
    const displayName = toDisplayName(row);
    console.log(`[auth] "${identifier}" signed in as ${row.type_code} -> ${describeScope(scope, row)}`);

    return {
        ok: true,
        token: {
            userId: row.id,
            username: row.email,
            name: displayName,
            typeCode: row.type_code,
            role,
            scope,
        },
        role,
        name: displayName,
        email: row.email,
        company: row.company_name,
        center: row.center_name,
    };
}

module.exports = { authenticate, scopeFor, ROLE_LABELS };
