#!/usr/bin/env node
// Dump the live database schema (tables, columns, constraints, views, row
// counts) to a JSON file, read-only. Feeds the ERD page generator, so the
// diagram is regenerated from the database rather than maintained by hand.
//
// Usage (any working directory):
//   node server/scripts/extract-schema.js [output.json]     # default: ./schema.json
// Also used as a module by build-erd.js: extractSchema() returns the same object.

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

async function extractSchema() {
    const pool = new Pool({
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT),
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
    });
    const q = async (sql, params) => (await pool.query(sql, params)).rows;

    const tables = (await q(`SELECT table_name FROM information_schema.tables
                             WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).map((r) => r.table_name);
    const views = (await q(`SELECT table_name FROM information_schema.views WHERE table_schema = 'public' ORDER BY 1`)).map((r) => r.table_name);

    const columns = await q(`
        SELECT c.table_name, c.column_name, c.ordinal_position,
               CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name
                    WHEN c.data_type = 'character varying' THEN 'varchar'
                    WHEN c.data_type = 'timestamp without time zone' THEN 'timestamp'
                    WHEN c.data_type = 'time without time zone' THEN 'time'
                    WHEN c.data_type = 'double precision' THEN 'double'
                    ELSE c.data_type END AS type,
               c.is_nullable = 'YES' AS nullable, c.column_default
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
        ORDER BY c.table_name, c.ordinal_position`);

    // Column arrays come back as text[] so they arrive as real arrays, not "{a,b}".
    const constraints = await q(`
        SELECT con.conname, con.contype, rel.relname AS table_name,
               (SELECT array_agg(a.attname::text ORDER BY k.ord)
                  FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
               frel.relname AS ref_table,
               (SELECT array_agg(a.attname::text ORDER BY k.ord)
                  FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_columns,
               con.confdeltype AS on_delete, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
        LEFT JOIN pg_class frel ON frel.oid = con.confrelid
        WHERE n.nspname = 'public' AND con.contype IN ('p', 'f', 'u', 'c')
        ORDER BY rel.relname, con.contype, con.conname`);

    const counts = {};
    for (const t of tables) counts[t] = Number((await q(`SELECT count(*) AS n FROM "${t}"`))[0].n);

    const viewDefs = {};
    for (const v of views) viewDefs[v] = (await q('SELECT pg_get_viewdef($1::regclass, true) AS d', [v]))[0].d;

    await pool.end();

    return {
        extracted_at: new Date().toISOString(),
        database: process.env.PGDATABASE,
        tables, views, columns, constraints, counts, viewDefs,
    };
}

module.exports = { extractSchema };

if (require.main === module) {
    const out = path.resolve(process.argv[2] || 'schema.json');
    extractSchema()
        .then((schema) => {
            fs.writeFileSync(out, JSON.stringify(schema, null, 1));
            console.log(`[schema] ${schema.tables.length} tables, ${schema.views.length} views, ${schema.columns.length} columns, ` +
                `${schema.constraints.filter((c) => c.contype === 'f').length} foreign keys -> ${out}`);
        })
        .catch((err) => {
            console.error('[schema] failed:', err.message);
            process.exit(1);
        });
}
