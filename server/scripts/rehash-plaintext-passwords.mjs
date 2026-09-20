#!/usr/bin/env node
// One-time migration: find every users row whose `password` column is NOT a
// bcrypt hash and re-hash it in place, treating the stored value as the
// plaintext password.
//
// Background: auth.js verifies logins with bcrypt.compareSync(), which only
// succeeds when the stored value is a bcrypt hash. Rows seeded with plaintext
// passwords can never log in. This script fixes them once.
//
// Safety:
//   * Dry run by default. It prints what it WOULD change and writes nothing.
//   * Pass --apply to actually update rows.
//   * Uses the write connection (PGW_USER/PGW_PASSWORD) from .env, kept
//     separate from the read-only dashboard user.
//   * Rows that already hold a bcrypt hash are skipped. Rows with a null or
//     empty password are skipped and reported (they have nothing to hash).
//   * Runs inside a single transaction: all rows update or none do.
//
// Usage (from the server directory):
//   node scripts/rehash-plaintext-passwords.mjs            # dry run
//   node scripts/rehash-plaintext-passwords.mjs --apply    # write changes

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from the server directory (one level up from scripts/).
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const SALT_ROUNDS = 10;

// A stored value is already a bcrypt hash when it matches this shape:
// $2a$/$2b$/$2y$, a two-digit cost, then a 22-char salt + 31-char digest.
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function isBcryptHash(value) {
    return typeof value === 'string' && BCRYPT_RE.test(value);
}

async function main() {
    const client = new Client({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT),
        database: process.env.PGDATABASE,
        user: process.env.PGW_USER,
        password: process.env.PGW_PASSWORD,
    });

    await client.connect();
    console.log(
        `[rehash] connected to ${process.env.PGDATABASE} on ` +
        `${process.env.PGHOST}:${process.env.PGPORT} as ${process.env.PGW_USER}`
    );
    console.log(`[rehash] mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY RUN (no writes)'}`);

    const { rows } = await client.query(
        'SELECT id, email, password FROM users ORDER BY id'
    );

    const toRehash = [];
    let alreadyHashed = 0;
    const emptyPassword = [];

    for (const row of rows) {
        if (isBcryptHash(row.password)) {
            alreadyHashed++;
        } else if (row.password === null || row.password === '') {
            emptyPassword.push(row);
        } else {
            toRehash.push(row);
        }
    }

    console.log(`[rehash] total users:        ${rows.length}`);
    console.log(`[rehash] already bcrypt:     ${alreadyHashed}`);
    console.log(`[rehash] null/empty (skip):  ${emptyPassword.length}`);
    console.log(`[rehash] plaintext to fix:   ${toRehash.length}`);

    if (emptyPassword.length) {
        console.log('[rehash] rows with no password (left untouched):');
        for (const r of emptyPassword) console.log(`         - #${r.id} ${r.email}`);
    }

    if (!toRehash.length) {
        console.log('[rehash] nothing to do.');
        await client.end();
        return;
    }

    if (!APPLY) {
        console.log('[rehash] would re-hash these rows (dry run):');
        for (const r of toRehash) console.log(`         - #${r.id} ${r.email}`);
        console.log('[rehash] re-run with --apply to write the changes.');
        await client.end();
        return;
    }

    let updated = 0;
    try {
        await client.query('BEGIN');
        for (const r of toRehash) {
            const hash = bcrypt.hashSync(r.password, SALT_ROUNDS);
            await client.query('UPDATE users SET password = $1 WHERE id = $2', [hash, r.id]);
            updated++;
            console.log(`         re-hashed #${r.id} ${r.email}`);
        }
        await client.query('COMMIT');
        console.log(`[rehash] committed. ${updated} row(s) updated.`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[rehash] error, rolled back — no rows changed:', err.message);
        process.exitCode = 1;
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error('[rehash] fatal:', err.message);
    process.exit(1);
});
