const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3100;
const JWT_SECRET = process.env.JWT_SECRET || 'maan-super-secret-key';

app.use(cors());
app.use(express.json());

// Mock Users with RBAC
const users = {
    'admin': { password: 'password', role: 'Administrator' },
    'manager': { password: 'password', role: 'Operations Manager' },
    'viewer': { password: 'password', role: 'Viewer' },
    'komra': { password: 'FC2026', role: 'Invited User' },
};

app.post('/maan-dashboard/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = users[username];
    if (user && user.password === password) {
        const token = jwt.sign({ username, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
        res.json({ token, role: user.role });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
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

const requireRole = (roles) => (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Access denied: insufficient permissions' });
    }
    next();
};

// Secure Data Endpoint
app.get('/maan-dashboard/api/data/:filename', authenticateToken, (req, res) => {
    const filename = req.params.filename;

    // Only allow specific js files
    const allowedFiles = ['data.js', 'assign_camps.js', 'assign_residences.js', 'service_companies.js'];
    if (!allowedFiles.includes(filename)) {
        return res.status(403).json({ error: 'File not allowed' });
    }

    // Role-Based Access Control
    if (['assign_camps.js', 'assign_residences.js'].includes(filename)) {
        if (!['Operations Manager', 'Administrator'].includes(req.user.role)) {
            // For viewers, return an empty string so the frontend doesn't crash but data is hidden
            return res.status(200).send('// Access denied to detailed assignments');
        }
    }

    const filePath = path.join(__dirname, 'data', filename);
    if (fs.existsSync(filePath)) {
        // Send as Javascript
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.sendFile(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Update data.js from uploaded CSV (Administrator/Operations Manager only)
app.post(
    '/maan-dashboard/api/update-data',
    express.text({ limit: '150mb' }),
    authenticateToken,
    requireRole(['Administrator', 'Operations Manager']),
    (req, res) => {
        const csvText = req.body;
        if (typeof csvText !== 'string' || csvText.trim().length === 0) {
            return res.status(400).json({ error: 'Empty or invalid CSV body' });
        }

        const jsContent = `const CSV_DATA = \`${csvText}\`;\n`;

        const writePaths = [
            path.join(__dirname, 'data', 'data.js'),
            path.join(__dirname, '..', 'dist', 'data', 'data.js'),
            path.join(__dirname, '..', 'public', 'data', 'data.js'),
        ];

        try {
            for (const filePath of writePaths) {
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(filePath, jsContent, 'utf-8');
            }
            const sizeKb = (Buffer.byteLength(jsContent, 'utf-8') / 1024).toFixed(1);
            res.json({ ok: true, sizeKb });
        } catch (err) {
            console.error('Failed to write data.js:', err.message);
            res.status(500).json({ error: 'Failed to write data file' });
        }
    }
);

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
});
