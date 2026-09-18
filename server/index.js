const express = require('express');
const cors = require('cors');
const compression = require('compression');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('./db');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3100;
const JWT_SECRET = process.env.JWT_SECRET || 'maan-super-secret-key';

app.use(cors());
app.use(compression());
app.use(express.json());

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
