const express = require('express');
const cors = require('cors');
const compression = require('compression');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('./db');
const auth = require('./auth');
const writes = require('./writes');
const plansImport = require('./plans-import');
const entityIo = require('./entity-io');
const routingResults = require('./routing-results');

const app = express();
const PORT = process.env.PORT || 3100;
const JWT_SECRET = process.env.JWT_SECRET || 'maan-super-secret-key';

app.use(cors());
app.use(compression());
// The plan import ships four CSV files as JSON strings; allow a generous body.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '25mb' }));

app.post('/maan-dashboard/api/login', async (req, res) => {
    // The field is still called "username" for the existing login form; database
    // accounts are identified by email.
    const { username, email, password } = req.body;
    const result = await auth.authenticate(email || username, password);

    if (!result.ok) {
        return res.status(result.reason === 'database-unavailable' ? 502 : 401)
            .json({ error: 'Invalid credentials', reason: result.reason });
    }

    const token = jwt.sign(result.token, JWT_SECRET, { expiresIn: '8h' });
    res.json({
        token,
        role: result.role,
        name: result.name,
        company: result.company,
        center: result.center,
    });
});

// Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};


// Live datasets straight from Postgres, scoped to the caller, cached per scope
// and served pre-gzipped.
const isAdmin = (user) =>
    ['system_admin', 'transport_authority'].includes(user.typeCode) ||
    ['Administrator', 'Operations Manager'].includes(user.role);

app.get('/maan-dashboard/api/db/:dataset', authenticateToken, async (req, res) => {
    const { dataset } = req.params;

    if (!db.DATASETS[dataset]) {
        return res.status(404).json({ error: 'Unknown dataset' });
    }

    // The scope is signed into the token at login. A token without one predates
    // this change; send the user back to log in rather than guessing.
    if (!req.user.scope) {
        return res.status(401).json({ error: 'Session predates access scoping; please sign in again' });
    }
    const scope = req.user.scope;

    try {
        const entry = await db.getDataset(dataset, scope);
        res.setHeader('Content-Type', entry.contentType);
        res.setHeader('X-Row-Count', entry.rowCount);
        res.setHeader('X-Scope', db.scopeKey(scope));
        res.setHeader('Cache-Control', 'no-cache');

        if (req.acceptsEncodings('gzip')) {
            res.setHeader('Content-Encoding', 'gzip');
            return res.send(entry.gzipped);
        }
        return res.send(zlib.gunzipSync(entry.gzipped));
    } catch (err) {
        console.error(`[api] dataset ${dataset} failed:`, err.message);
        return res.status(502).json({ error: 'Database unavailable', detail: err.message });
    }
});

app.post('/maan-dashboard/api/db-refresh', authenticateToken, (req, res) => {
    if (!isAdmin(req.user)) {
        return res.status(403).json({ error: 'Access denied: insufficient permissions' });
    }
    db.invalidate(req.query.dataset);
    res.json({ ok: true, refreshed: req.query.dataset || 'all' });
});

// Edit endpoint. Permission and ownership are enforced in writes.js from the
// signed token; nothing about who the caller is comes from the request body.
app.patch('/maan-dashboard/api/db/:resource/:id', authenticateToken, async (req, res) => {
    if (!req.user.scope) {
        return res.status(401).json({ error: 'Session predates access scoping; please sign in again' });
    }

    try {
        const result = await writes.updateRow({
            resource: req.params.resource,
            id: req.params.id,
            patch: req.body,
            user: req.user,
        });

        if (!result.ok) {
            return res.status(result.status).json({ error: result.error, rejected: result.rejected });
        }
        return res.json({ ok: true, row: result.row, before: result.before });
    } catch (err) {
        console.error(`[api] edit ${req.params.resource}/${req.params.id} failed:`, err.message);
        return res.status(502).json({ error: 'Update failed', detail: err.message });
    }
});

app.delete('/maan-dashboard/api/db/:resource/:id', authenticateToken, async (req, res) => {
    if (!req.user.scope) {
        return res.status(401).json({ error: 'Session predates access scoping; please sign in again' });
    }

    try {
        const result = await writes.deleteRow({
            resource: req.params.resource,
            id: req.params.id,
            user: req.user,
        });

        if (!result.ok) return res.status(result.status).json({ error: result.error });
        return res.json({ ok: true, id: result.id });
    } catch (err) {
        console.error(`[api] delete ${req.params.resource}/${req.params.id} failed:`, err.message);
        return res.status(502).json({ error: 'Delete failed', detail: err.message });
    }
});

// What the signed-in user may edit, plus the field descriptors and dropdown
// contents the editor renders from, so the UI never hardcodes the field list.
// ── Reference data (edit mode) ─────────────────────────────────────────────
// The entity nav, its lists and single rows. Updates and deletes go through the
// existing /api/db/:resource/:id endpoints, which already enforce the same
// permission and ownership rules.

app.get('/maan-dashboard/api/entities', authenticateToken, (req, res) => {
    res.json({ entities: writes.catalogFor(req.user) });
});

app.get('/maan-dashboard/api/entities/:resource', authenticateToken, async (req, res) => {
    try {
        const result = await writes.listRows({
            resource: req.params.resource,
            user: req.user,
            q: req.query.q,
            filter: req.query.filter,
            limit: req.query.limit,
            offset: req.query.offset,
        });
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        return res.json(result);
    } catch (err) {
        console.error(`[api] list ${req.params.resource} failed:`, err.message);
        return res.status(502).json({ error: 'Database unavailable', detail: err.message });
    }
});

// ── Bulk export / import of reference data ─────────────────────────────────
// Export is open to any admin; import is system_admin only, and always runs
// analyze first so the caller sees what a commit would change.

app.get('/maan-dashboard/api/entities/:resource/export', authenticateToken, async (req, res) => {
    try {
        const result = await entityIo.exportCsv({ resource: req.params.resource, user: req.user });
        if (!result.ok) return res.status(result.status).json({ error: result.error });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.setHeader('X-Row-Count', result.rowCount);
        return res.send(result.csv);
    } catch (err) {
        console.error(`[api] export ${req.params.resource} failed:`, err.message);
        return res.status(502).json({ error: 'Export failed', detail: err.message });
    }
});

// The CSV arrives as a raw body, not wrapped in JSON: the paths export is 22MB
// of GeoJSON, and JSON-escaping every quote in it would push the upload past any
// sane body limit for no gain.
const csvBody = express.text({ type: ['text/csv', 'text/plain'], limit: process.env.CSV_BODY_LIMIT || '64mb' });

for (const [step, run] of [['analyze', entityIo.analyzeImport], ['commit', entityIo.commitImport]]) {
    app.post(`/maan-dashboard/api/entities/:resource/import/${step}`, authenticateToken, csvBody, async (req, res) => {
        try {
            const csv = typeof req.body === 'string' ? req.body : (req.body && req.body.csv);
            const result = await run({
                resource: req.params.resource, csv, user: req.user,
            });
            if (!result.ok) {
                return res.status(result.status || 400).json({ error: result.error, report: result.report });
            }
            return res.json(result);
        } catch (err) {
            console.error(`[api] import ${step} ${req.params.resource} failed:`, err.message);
            return res.status(502).json({ error: 'Import failed', detail: err.message });
        }
    });
}

app.get('/maan-dashboard/api/entities/:resource/:id', authenticateToken, async (req, res) => {
    try {
        const result = await writes.readRow({
            resource: req.params.resource, id: req.params.id, user: req.user,
        });
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        return res.json(result);
    } catch (err) {
        console.error(`[api] read ${req.params.resource}/${req.params.id} failed:`, err.message);
        return res.status(502).json({ error: 'Database unavailable', detail: err.message });
    }
});

app.post('/maan-dashboard/api/entities/:resource', authenticateToken, async (req, res) => {
    try {
        const result = await writes.createRow({
            resource: req.params.resource, values: req.body, user: req.user,
        });
        if (!result.ok) {
            return res.status(result.status).json({ error: result.error, rejected: result.rejected });
        }
        return res.status(201).json({ ok: true, id: result.id });
    } catch (err) {
        console.error(`[api] create ${req.params.resource} failed:`, err.message);
        return res.status(502).json({ error: 'Create failed', detail: err.message });
    }
});

app.get('/maan-dashboard/api/db-permissions', authenticateToken, async (req, res) => {
    const resources = Object.keys(writes.RESOURCES).filter((r) => writes.mayEdit(req.user, r));
    const editable = resources.reduce((acc, resource) => {
        acc[resource] = writes.fieldsFor(resource);
        return acc;
    }, {});
    // Field descriptors for everything the user may see, so a read-only viewer
    // still gets a populated form — just with the controls disabled.
    const viewable = Object.keys(writes.RESOURCES)
        .filter((r) => writes.mayView(req.user, r))
        .reduce((acc, resource) => { acc[resource] = writes.fieldsFor(resource); return acc; }, {});

    let options = {};
    if (resources.length) {
        try {
            options = await writes.getEditOptions();
        } catch (err) {
            console.error('[api] edit options failed:', err.message);
        }
    }

    res.json({
        isAdmin: writes.isAdmin(req.user), scope: req.user.scope,
        editable, viewable, options,
        ...entityIo.capabilitiesFor(req.user),
    });
});

// Service-centre plan import. `analyze` previews what would be written;
// `commit` replaces the centre's data and generates plans. Both take
// { files: { assignCampUsers, assignResidences, periodPreferences, mashaersTrips } }
// where each value is the raw CSV text of the corresponding upload.
app.get('/maan-dashboard/api/plan-import/capabilities', authenticateToken, (req, res) => {
    res.json({ mayImport: plansImport.mayImport(req.user), scope: req.user.scope });
});

app.post('/maan-dashboard/api/plan-import/analyze', authenticateToken, async (req, res) => {
    if (!req.user.scope) {
        return res.status(401).json({ error: 'Session predates access scoping; please sign in again' });
    }
    const result = await plansImport.analyze({ files: req.body.files, user: req.user });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    res.json(result.summary);
});

app.post('/maan-dashboard/api/plan-import/commit', authenticateToken, async (req, res) => {
    if (!req.user.scope) {
        return res.status(401).json({ error: 'Session predates access scoping; please sign in again' });
    }
    const result = await plansImport.commit({ files: req.body.files, user: req.user });
    if (!result.ok) {
        return res.status(result.status || 400).json({ error: result.error, detail: result.detail });
    }
    res.json(result.summary);
});

// Route-optimization runs (read-only). Plan-level results follow the caller's scope.
app.get('/maan-dashboard/api/routing/runs', authenticateToken, async (req, res) => {
    try {
        if (!req.user.scope) {
            return res.status(401).json({ error: 'Session predates access scoping; please sign in again' });
        }
        res.json(await routingResults.listRuns(req.user.scope));
    } catch (err) {
        console.error('[api] routing runs failed:', err.message);
        res.status(502).json({ error: 'Database unavailable', detail: err.message });
    }
});

app.get('/maan-dashboard/api/routing/runs/:id', authenticateToken, async (req, res) => {
    if (!req.user.scope) {
        return res.status(401).json({ error: 'Session predates access scoping; please sign in again' });
    }
    const runId = Number(req.params.id);
    if (!Number.isInteger(runId) || runId <= 0) return res.status(400).json({ error: 'Invalid run id' });
    try {
        const detail = await routingResults.runDetail(runId, req.user.scope);
        if (!detail) return res.status(404).json({ error: 'Unknown run' });
        res.json(detail);
    } catch (err) {
        console.error('[api] routing run failed:', err.message);
        res.status(502).json({ error: 'Database unavailable', detail: err.message });
    }
});

app.get('/maan-dashboard/api/db-health', async (req, res) => {
    try {
        const { rows } = await db.pool.query('select now() as now');
        res.json({ ok: true, now: rows[0].now });
    } catch (err) {
        res.status(502).json({ ok: false, error: err.message });
    }
});

// Serve frontend static files
const distPath = path.join(__dirname, '..', 'dist');
app.use('/maan-dashboard', express.static(distPath));

// Catch-all to serve index.html for SPA routing (if any)
app.use('/maan-dashboard', (req, res) => {
    if (fs.existsSync(path.join(distPath, 'index.html'))) {
        res.sendFile(path.join(distPath, 'index.html'));
    } else {
        res.status(404).send('Please run "npm run build" in the root directory first.');
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);

    // Warm only the unscoped caches; per-company and per-centre scopes are small
    // and build on demand at first request.
    Promise.all(Object.keys(db.DATASETS).map((name) =>
        db.getDataset(name, { kind: 'all' })
          .catch((err) => console.error(`[warm] ${name} failed:`, err.message))
    )).then(() => console.log('[warm] datasets ready'));
});
