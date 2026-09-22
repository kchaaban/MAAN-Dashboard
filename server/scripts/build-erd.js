#!/usr/bin/env node
// Regenerate the database ERD page from the live schema.
//
//   cd server && npm run erd            # -> ../docs/erd.html + ../docs/schema.json
//   node scripts/build-erd.js [outDir]  # any working directory
//
// Reads the schema through extract-schema.js (read-only PGUSER), so the page
// always shows the database as it is. The diagrams are Mermaid: the claude.ai
// artifact host renders <pre class="mermaid"> natively; anywhere else the page
// loads Mermaid from cdnjs itself, so the same file works when opened locally.
//
// Domain grouping is the one hand-maintained part (DOMAINS below). A table the
// list does not know falls into "System & backups" and is reported on stdout.

const fs = require('fs');
const path = require('path');
const { extractSchema } = require('./extract-schema');

const arr = (v) => Array.isArray(v) ? v : String(v || '').replace(/^\{|\}$/g, '').split(',').filter(Boolean);
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => Number(n).toLocaleString('en-US');
const ON_DELETE = { a: 'no action', r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' };

const DOMAINS = [
    { key: 'planning', title: 'Planning', blurb: 'What gets generated and edited: one plans row per bus movement, typed by phase and scheduled into a period window.',
      tables: ['plans', 'plan_types', 'periods', 'timing', 'round_trips', 'plan_desires', 'plan_logs'] },
    { key: 'places', title: 'Places & geometry', blurb: 'Everything a plan moves between. Camps carry four pre-drawn path roles; the rest are PostGIS geometries.',
      tables: ['platforms', 'camps', 'entrances', 'paths', 'residences', 'drop_off_areas', 'bus_stops', 'parking', 'bus_warehouses', 'general_points'] },
    { key: 'org', title: 'Organisation', blurb: 'Who owns plans and who may edit them: service companies, their service centres, users and reference lists.',
      tables: ['service_companies', 'service_centers', 'users', 'types', 'countries', 'organizers', 'transport_companies', 'transport_types'] },
    { key: 'alloc', title: 'Allocation (CSV imports)', blurb: 'What a service centre uploads: pilgrims per camp, residences with phase splits, and the bus roster.',
      tables: ['assign_camps', 'assign_residences', 'mashaers_trips'] },
    { key: 'framework', title: 'Framework (Laravel)', blurb: 'Tables the legacy Laravel app installed: auth/RBAC, queues, cache, sessions. The Node dashboard uses only users, roles and sessions.',
      tables: ['permissions', 'roles', 'model_has_roles', 'model_has_permissions', 'role_has_permissions', 'sessions', 'personal_access_tokens', 'password_reset_tokens', 'cache', 'cache_locks', 'jobs', 'job_batches', 'failed_jobs', 'import_jobs', 'migrations'] },
    { key: 'system', title: 'System & backups', blurb: 'PostGIS reference data and the two tables kept as backups when the old transport_companies contract table was retired.',
      tables: ['spatial_ref_sys', 'transport_companies_bak', 'transport_company_user_bak'] },
];
const DIAGRAM_DOMAINS = ['planning', 'places', 'org', 'alloc'];
const IDENTITY_COLS = new Set(['name', 'name_ar', 'name_en', 'code', 'label', 'center_name', 'office_number', 'license_number', 'asm_code', 'email', 'period', 'start_at', 'end_at', 'round_trip', 'number_of_haj', 'number_of_buses', 'number_of_trips', 'haj_count', 'bus_id', 'transport_company_name_ar', 'start_point_type', 'end_point_type', 'get_type_parking', 'set_type_parking', 'action']);
const AUTH_TABLES = ['users', 'roles', 'permissions', 'model_has_roles', 'model_has_permissions', 'role_has_permissions', 'sessions', 'types', 'service_companies', 'service_centers'];
const SYSTEM_VIEWS = new Set(['geography_columns', 'geometry_columns']);
const VIEW_NOTES = {
    plan_show_view: 'The dashboard’s base view: one row per plan with every lookup joined (owner centre and company, timing, type, transport, entrance, path, desire). server/db.js builds the plans dataset on top of it.',
    final_plan_view: 'Legacy reporting view resolving start/end points and parking across all place tables.',
    simulation_data_view: 'Legacy export shape (the CSV the dashboard used before it read from Postgres).',
    camps_geometries: 'Camp polygons with plan counts per camp.',
    paths_powerbi: 'paths flattened for Power BI.',
};

function render(s) {
    const pks = new Map();
    const fks = [];
    const uks = new Map();
    for (const c of s.constraints) {
        if (c.contype === 'p') pks.set(c.table_name, arr(c.columns));
        if (c.contype === 'u') uks.set(c.table_name, [...(uks.get(c.table_name) || []), arr(c.columns)]);
        if (c.contype === 'f') fks.push({ table: c.table_name, cols: arr(c.columns), ref: c.ref_table, refCols: arr(c.ref_columns), onDelete: ON_DELETE[c.on_delete] || c.on_delete, name: c.conname });
    }
    const colsOf = (t) => s.columns.filter((c) => c.table_name === t);
    const fkOfCol = (t, col) => fks.find((f) => f.table === t && f.cols.length === 1 && f.cols[0] === col);
    const isPk = (t, col) => (pks.get(t) || []).includes(col);
    const isUk = (t, col) => (uks.get(t) || []).some((u) => u.length === 1 && u[0] === col);
    const incoming = (t) => fks.filter((f) => f.ref === t);

    const domains = DOMAINS.map((d) => ({ ...d, tables: d.tables.filter((t) => s.tables.includes(t)) }));
    const known = new Set(domains.flatMap((d) => d.tables));
    const unassigned = s.tables.filter((t) => !known.has(t));
    if (unassigned.length) domains.find((d) => d.key === 'system').tables.push(...unassigned);

    const cascadeCount = fks.filter((f) => f.onDelete === 'cascade').length;
    const setNullCount = fks.filter((f) => f.onDelete === 'set null').length;

    // ---- mermaid
    const mermaidType = (t) => t.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '');
    function erEntity(t) {
        const lines = [];
        for (const c of colsOf(t)) {
            const pk = isPk(t, c.column_name), fk = !!fkOfCol(t, c.column_name), uk = isUk(t, c.column_name);
            if (!(pk || fk || uk || IDENTITY_COLS.has(c.column_name))) continue;
            const keys = [pk && 'PK', fk && 'FK', uk && 'UK'].filter(Boolean).join(', ');
            lines.push(`        ${mermaidType(c.type)} ${c.column_name}${keys ? ' ' + keys : ''}`);
        }
        const hidden = colsOf(t).length - lines.length;
        if (hidden > 0) lines.push(`        omitted columns_${hidden} "see table below"`);
        return `    ${t} {\n${lines.join('\n')}\n    }`;
    }
    function erRelations(tables) {
        const set = new Set(tables);
        return fks.filter((f) => set.has(f.table) && set.has(f.ref)).map((f) => {
            const col = colsOf(f.table).find((c) => c.column_name === f.cols[0]);
            const optional = !col || col.nullable;
            return `    ${f.ref} ${optional ? '|o' : '||'}--o{ ${f.table} : "${f.cols.join(',')}"`;
        }).join('\n');
    }
    const diagramTables = domains.filter((d) => DIAGRAM_DOMAINS.includes(d.key)).flatMap((d) => d.tables);
    const mainEr = `erDiagram\n${diagramTables.map(erEntity).join('\n')}\n${erRelations(diagramTables)}`;
    const authTables = AUTH_TABLES.filter((t) => s.tables.includes(t));
    const authEr = `erDiagram\n${authTables.map(erEntity).join('\n')}\n${erRelations(authTables)}\n    users |o..o{ model_has_roles : "model_type + model_id (no FK)"\n    users |o..o{ model_has_permissions : "model_type + model_id (no FK)"`;
    const relationCount = erRelations(diagramTables).split('\n').filter(Boolean).length;

    // ---- table cards
    function tableCard(t) {
        const rows = colsOf(t).map((c) => {
            const fk = fkOfCol(t, c.column_name);
            const badges = [
                isPk(t, c.column_name) ? '<span class="badge pk">PK</span>' : '',
                fk ? '<span class="badge fk">FK</span>' : '',
                isUk(t, c.column_name) ? '<span class="badge uk">UQ</span>' : '',
            ].join('');
            const ref = fk ? `<span class="ref">→ <a href="#t-${esc(fk.ref)}">${esc(fk.ref)}</a>.${esc(fk.refCols.join(','))}<span class="ondel"> · ${esc(fk.onDelete)}</span></span>` : '';
            return `<tr><td class="col">${esc(c.column_name)}${badges}</td><td class="type">${esc(c.type)}${c.nullable ? '<span class="null" title="nullable">?</span>' : ''}</td><td class="refcell">${ref}</td></tr>`;
        }).join('');
        const multiUk = (uks.get(t) || []).filter((u) => u.length > 1).map((u) => `<span class="pill">unique (${esc(u.join(', '))})</span>`).join('');
        const inc = incoming(t);
        const incHtml = inc.length
            ? `<div class="incoming"><span class="incoming-label">Referenced by</span> ${inc.map((f) => `<a href="#t-${esc(f.table)}"><code>${esc(f.table)}.${esc(f.cols.join(','))}</code></a>`).join(' ')}</div>`
            : '';
        const noPk = (pks.get(t) || []).length ? '' : '<span class="pill warn">no primary key</span>';
        return `
<article class="table-card" id="t-${esc(t)}">
  <header>
    <h4><code>${esc(t)}</code></h4>
    <span class="rows" title="row count at extraction">${num(s.counts[t] ?? 0)} rows</span>
  </header>
  <div class="pills">${noPk}${multiUk}</div>
  <div class="scroll"><table><tbody>${rows}</tbody></table></div>
  ${incHtml}
</article>`;
    }

    // ---- views
    const viewBases = (v) => {
        const d = s.viewDefs[v] || '';
        return [...new Set([...d.matchAll(/(?:FROM|JOIN)\s+(?:public\.)?([a-z_]+)/g)].map((m) => m[1]))].filter((t) => s.tables.includes(t) || s.views.includes(t));
    };
    const viewsHtml = s.views.filter((v) => !SYSTEM_VIEWS.has(v)).map((v) => `
<div class="view-row">
  <div class="view-name"><code>${esc(v)}</code></div>
  <div class="view-bases">${viewBases(v).map((t) => s.views.includes(t) ? `<code class="isview">${esc(t)}</code>` : `<a href="#t-${esc(t)}"><code>${esc(t)}</code></a>`).join(' ')}</div>
  <div class="view-note">${esc(VIEW_NOTES[v] || '')}</div>
</div>`).join('');

    const totals = {
        tables: s.tables.length, views: s.views.length, columns: s.columns.length,
        fks: fks.length, rows: Object.values(s.counts).reduce((a, b) => a + Number(b), 0),
    };
    const extracted = new Date(s.extracted_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const domainSections = domains.map((d) => `
<section class="domain" id="d-${d.key}">
  <div class="domain-head">
    <span class="swatch ${d.key}"></span>
    <h3>${esc(d.title)}</h3>
    <span class="count">${d.tables.length} tables</span>
  </div>
  <p class="blurb">${esc(d.blurb)}</p>
  <div class="cards">${d.tables.map(tableCard).join('')}</div>
</section>`).join('');
    const legend = domains.filter((d) => DIAGRAM_DOMAINS.includes(d.key)).map((d) => `<a class="chip" href="#d-${d.key}"><span class="swatch ${d.key}"></span>${esc(d.title)}</a>`).join('');

    // Mermaid fallback: only when nothing has rendered the diagrams (i.e. the
    // page is opened outside the artifact host). Plain concatenation so this
    // stays inert inside the surrounding template literal.
    const mermaidFallback = '<script>' +
        'setTimeout(function () {' +
        '  var pending = document.querySelectorAll("pre.mermaid");' +
        '  if (!pending.length || window.mermaid) return;' +
        '  var el = document.createElement("script");' +
        '  el.src = "https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js";' +
        '  el.onload = function () {' +
        '    var dark = document.documentElement.getAttribute("data-theme") === "dark" ||' +
        '      (document.documentElement.getAttribute("data-theme") !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);' +
        '    window.mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "loose" });' +
        '    window.mermaid.run({ nodes: document.querySelectorAll("pre.mermaid") });' +
        '  };' +
        '  document.head.appendChild(el);' +
        '}, 2500);' +
        '</script>';

    return { unassigned, relationCount, diagramTables, html: `<title>Transport DB ERD</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root {
  --bg: #f5f7f6; --surface: #ffffff; --surface-2: #eef2f0; --ink: #1a231f; --muted: #5d6b66; --line: #d6ddd9;
  --accent: #0f7f6b; --accent-soft: #e2f2ed; --accent-ink: #0a5a4c; --warn: #9a6b12; --warn-soft: #fbf1dc;
  --planning: #0f7f6b; --places: #3b6fb6; --org: #8a5bb5; --alloc: #c4772a; --framework: #7a8580; --system: #a0a8a4;
  --pk: #0f7f6b; --fk: #3b6fb6; --uk: #8a5bb5; --badge-ink: #ffffff;
  --shadow: 0 1px 2px rgba(20, 30, 26, .06), 0 6px 18px rgba(20, 30, 26, .06);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #111715; --surface: #1a2220; --surface-2: #202a27; --ink: #e7ece9; --muted: #98a6a0; --line: #2c3834;
    --accent: #3fc9a7; --accent-soft: #163229; --accent-ink: #8fe3cd; --warn: #e0ad4a; --warn-soft: #33290f;
    --planning: #3fc9a7; --places: #7fa9e6; --org: #bd97e2; --alloc: #e8a260; --framework: #8b9993; --system: #6f7b76;
    --pk: #3fc9a7; --fk: #7fa9e6; --uk: #bd97e2; --badge-ink: #0f1513;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.35);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #111715; --surface: #1a2220; --surface-2: #202a27; --ink: #e7ece9; --muted: #98a6a0; --line: #2c3834;
  --accent: #3fc9a7; --accent-soft: #163229; --accent-ink: #8fe3cd; --warn: #e0ad4a; --warn-soft: #33290f;
  --planning: #3fc9a7; --places: #7fa9e6; --org: #bd97e2; --alloc: #e8a260; --framework: #8b9993; --system: #6f7b76;
  --pk: #3fc9a7; --fk: #7fa9e6; --uk: #bd97e2; --badge-ink: #0f1513;
  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.35);
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
code, .mono { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
a { color: var(--accent-ink); text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 1240px; margin: 0 auto; padding-inline: 16px; padding-block: 0 56px; }
h1, h2, h3, h4 { text-wrap: balance; margin: 0; }
h1 { font-size: clamp(1.7rem, 3vw, 2.4rem); font-weight: 600; letter-spacing: -.01em; }
h2 { font-size: 1.35rem; font-weight: 600; margin-block: 44px 8px; padding-top: 12px; }
h3 { font-size: 1.05rem; font-weight: 600; }
.lede { color: var(--muted); max-width: 66ch; margin: 8px 0 0; }
.facts { display: flex; flex-wrap: wrap; gap: 10px 18px; margin-top: 18px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.fact { display: flex; flex-direction: column; gap: 2px; min-width: 96px; }
.fact b { font-size: 1.35rem; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.1; }
.fact span { color: var(--muted); font-size: .78rem; letter-spacing: .04em; text-transform: uppercase; }
.fact.src { margin-inline-start: auto; text-align: end; min-width: 0; }
.fact.src b { font-size: .95rem; font-weight: 500; }
header.top { padding-block: 34px 0; }
nav.toc { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; display: flex; gap: 4px; overflow-x: auto; margin-top: 18px; padding: 8px 0; background: var(--bg); border-bottom: 1px solid var(--line); }
nav.toc a { white-space: nowrap; padding: 6px 10px; border-radius: 6px; color: var(--muted); font-size: .88rem; font-weight: 500; }
nav.toc a:hover { background: var(--surface-2); color: var(--ink); text-decoration: none; }
.legend { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 14px; }
.chip { display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--ink); font-size: .85rem; }
.chip:hover { text-decoration: none; border-color: var(--accent); }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; background: var(--muted); }
.swatch.planning { background: var(--planning); } .swatch.places { background: var(--places); } .swatch.org { background: var(--org); }
.swatch.alloc { background: var(--alloc); } .swatch.framework { background: var(--framework); } .swatch.system { background: var(--system); }
figure { margin: 0; }
figcaption { color: var(--muted); font-size: .9rem; margin-top: 10px; max-width: 80ch; }
.diagram { border: 1px solid var(--line); border-radius: 12px; background: var(--surface); padding: 12px; overflow-x: auto; }
.diagram pre.mermaid { margin: 0; min-width: 900px; }
.diagram.small pre.mermaid { min-width: 620px; }
.reading { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px 24px; margin-top: 14px; color: var(--muted); font-size: .92rem; }
.reading b { color: var(--ink); font-weight: 600; }
.mech { border: 1px solid var(--line); border-radius: 12px; background: var(--surface); padding: 16px; overflow-x: auto; }
.mech svg { display: block; max-width: 100%; height: auto; min-width: 640px; color: var(--ink); }
.domain { margin-top: 30px; }
.domain-head { display: flex; align-items: center; gap: 10px; }
.domain-head .count { color: var(--muted); font-size: .85rem; }
.blurb { color: var(--muted); margin: 6px 0 14px; max-width: 78ch; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr)); gap: 14px; }
.table-card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px 12px; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 8px; scroll-margin-top: 64px; }
.table-card header { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.table-card h4 { font-size: 1rem; font-weight: 600; }
.table-card h4 code { font-size: .95rem; color: var(--ink); }
.rows { color: var(--muted); font-size: .8rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pills { display: flex; flex-wrap: wrap; gap: 6px; }
.pills:empty { display: none; }
.pill { font-size: .75rem; padding: 2px 8px; border-radius: 999px; background: var(--surface-2); color: var(--muted); }
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.scroll { overflow-x: auto; }
.table-card table { border-collapse: collapse; width: 100%; font-size: .82rem; }
.table-card td { padding: 3px 6px 3px 0; border-top: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
.table-card tr:first-child td { border-top: 0; }
td.col { font-family: "IBM Plex Mono", ui-monospace, monospace; font-weight: 500; }
td.type { color: var(--muted); font-family: "IBM Plex Mono", ui-monospace, monospace; }
td.refcell { color: var(--muted); }
.null { color: var(--muted); margin-inline-start: 3px; opacity: .8; }
.badge { display: inline-block; margin-inline-start: 6px; padding: 0 5px; border-radius: 4px; font: 600 .68rem/1.5 "IBM Plex Sans", system-ui, sans-serif; letter-spacing: .04em; vertical-align: 1px; color: var(--badge-ink); }
.badge.pk { background: var(--pk); } .badge.fk { background: var(--fk); } .badge.uk { background: var(--uk); }
.ref a { color: var(--accent-ink); }
.ondel { opacity: .8; }
.incoming { font-size: .8rem; color: var(--muted); border-top: 1px dashed var(--line); padding-top: 8px; line-height: 1.9; }
.incoming-label { text-transform: uppercase; letter-spacing: .05em; font-size: .7rem; margin-inline-end: 6px; }
.incoming code { background: var(--surface-2); padding: 1px 5px; border-radius: 4px; }
.views { border: 1px solid var(--line); border-radius: 10px; background: var(--surface); overflow: hidden; }
.view-row { display: grid; grid-template-columns: 200px 1fr; gap: 6px 18px; padding: 12px 14px; border-top: 1px solid var(--line); }
.view-row:first-child { border-top: 0; }
.view-name code { font-weight: 500; }
.view-bases { display: flex; flex-wrap: wrap; gap: 6px; }
.view-bases code { background: var(--surface-2); padding: 1px 6px; border-radius: 4px; font-size: .8rem; }
.view-bases code.isview { outline: 1px dashed var(--line); }
.view-note { grid-column: 2; color: var(--muted); font-size: .88rem; }
.notes { display: grid; gap: 10px; }
.note { border: 1px solid var(--line); border-inline-start: 3px solid var(--accent); border-radius: 8px; background: var(--surface); padding: 10px 14px; }
.note.warn { border-inline-start-color: var(--warn); }
.note h4 { font-size: .95rem; font-weight: 600; margin-bottom: 4px; }
.note p { margin: 0; color: var(--muted); font-size: .92rem; }
footer { margin-top: 44px; color: var(--muted); font-size: .82rem; border-top: 1px solid var(--line); padding-top: 14px; }
@media (max-width: 640px) {
  .view-row { grid-template-columns: 1fr; }
  .view-note { grid-column: 1; }
  .fact.src { margin-inline-start: 0; text-align: start; }
}
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
</style>

<div class="wrap">
<header class="top">
  <h1>Transport DB ERD</h1>
  <p class="lede">Entity-relationship map of the <code>${esc(s.database)}</code> Postgres database behind the planning platform — read straight from <code>information_schema</code> and <code>pg_constraint</code>, so it shows the schema as it is, not as documented.</p>
  <div class="facts">
    <div class="fact"><b>${totals.tables}</b><span>tables</span></div>
    <div class="fact"><b>${totals.columns}</b><span>columns</span></div>
    <div class="fact"><b>${totals.fks}</b><span>foreign keys</span></div>
    <div class="fact"><b>${totals.views}</b><span>views</span></div>
    <div class="fact"><b>${num(totals.rows)}</b><span>rows</span></div>
    <div class="fact src"><b>${esc(extracted)}</b><span>extracted from live DB</span></div>
  </div>
  <nav class="toc" aria-label="Sections">
    <a href="#diagram">Diagram</a><a href="#mechanism">Plan endpoints</a><a href="#d-planning">Planning</a><a href="#d-places">Places</a><a href="#d-org">Organisation</a><a href="#d-alloc">Allocation</a><a href="#d-framework">Framework</a><a href="#views">Views</a><a href="#notes">Notes</a>
  </nav>
</header>

<h2 id="diagram">Domain diagram</h2>
<p class="lede">Every foreign key between the ${diagramTables.length} domain tables. Entities list their keys and identifying columns; the full column set is in the tables below. A relationship reads <em>parent ‖–o{ child : column</em>; a hollow circle on the parent side means the child’s column is nullable.</p>
<div class="legend">${legend}</div>
<figure>
  <div class="diagram"><pre class="mermaid">
${mainEr}
  </pre></div>
  <figcaption>Foreign-key graph of the planning, places, organisation and allocation tables. <code>plans</code> is the hub: it references service_centers (owner), users (creator), plan_types, timing, transport_types, entrances, paths, residences and plan_desires. <code>camps</code> references <code>paths</code> four times, one per path role.</figcaption>
</figure>
<div class="reading">
  <div><b>Cardinality.</b> All ${totals.fks} foreign keys are many-to-one; there are no join tables in the domain — the Laravel RBAC tables are the only ones.</div>
  <div><b>On delete.</b> ${setNullCount} of ${totals.fks} keys are <code>set null</code>; <code>cascade</code> (${cascadeCount}) is used only where the child is meaningless without the parent (timing and round_trips → plan_types, plan_logs → plans, mashaers_trips → service_centers, users → types, RBAC pivots).</div>
  <div><b>Identity.</b> Every domain table uses a <code>uuid</code> primary key. Unique constraints exist only on countries, roles, permissions, transport_types.code and transport_companies.name.</div>
</div>

<h2 id="mechanism">How a plan points at places</h2>
<p class="lede">The diagram above can’t show the most important edges, because they aren’t foreign keys. A plan’s start, end and parking are <em>type-discriminated</em> pairs: a <code>*_type</code> string names the table and an <code>*_id</code> uuid the row. Nothing in the database enforces them; <code>plan_show_view</code>, <code>final_plan_view</code> and the dashboard resolve them by unioning the place tables.</p>
<figure>
  <div class="mech">
  <svg viewBox="0 0 900 330" role="img" aria-label="plans row in the centre; dashed type-discriminated edges to residences, camps, bus_stops and drop_off_areas for start and end points and to parking and bus_warehouses for get/set parking; solid foreign-key edges to entrances and paths">
    <defs>
      <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker>
    </defs>
    <g font-family="IBM Plex Sans, system-ui, sans-serif" font-size="12" fill="currentColor">
      <rect x="360" y="105" width="180" height="120" rx="8" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5"/>
      <text x="450" y="128" text-anchor="middle" font-weight="600" font-size="14">plans</text>
      <g font-family="IBM Plex Mono, ui-monospace, monospace" font-size="11">
        <text x="372" y="150">start_point_type / _id</text>
        <text x="372" y="168">end_point_type / _id</text>
        <text x="372" y="186">get_parking_id · get_type_parking</text>
        <text x="372" y="204">set_parking_id · set_type_parking</text>
      </g>
      <text x="130" y="54" text-anchor="middle" font-size="11" fill="var(--muted)">start_point_type =</text>
      <g font-family="IBM Plex Mono, ui-monospace, monospace" font-size="11.5">
        <rect x="40" y="66" width="180" height="26" rx="6" fill="none" stroke="currentColor"/><text x="130" y="84" text-anchor="middle">residence → residences</text>
        <rect x="40" y="100" width="180" height="26" rx="6" fill="none" stroke="currentColor"/><text x="130" y="118" text-anchor="middle">camp → camps</text>
        <rect x="40" y="134" width="180" height="26" rx="6" fill="none" stroke="currentColor"/><text x="130" y="152" text-anchor="middle">dropOffArea → drop_off_areas</text>
        <rect x="40" y="168" width="180" height="26" rx="6" fill="none" stroke="currentColor"/><text x="130" y="186" text-anchor="middle">bus_stop → bus_stops</text>
      </g>
      <path d="M360 150 C300 150, 280 79, 220 79" fill="none" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
      <path d="M360 150 C300 150, 280 113, 220 113" fill="none" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
      <path d="M360 150 C300 150, 280 147, 220 147" fill="none" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
      <path d="M360 150 C300 150, 280 181, 220 181" fill="none" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
      <text x="770" y="54" text-anchor="middle" font-size="11" fill="var(--muted)">end_point_type =</text>
      <g font-family="IBM Plex Mono, ui-monospace, monospace" font-size="11.5">
        <rect x="680" y="66" width="180" height="26" rx="6" fill="none" stroke="currentColor"/><text x="770" y="84" text-anchor="middle">camp → camps</text>
        <rect x="680" y="100" width="180" height="26" rx="6" fill="none" stroke="currentColor"/><text x="770" y="118" text-anchor="middle">dropOffArea → drop_off_areas</text>
        <rect x="680" y="134" width="180" height="26" rx="6" fill="none" stroke="currentColor"/><text x="770" y="152" text-anchor="middle">bus_stop → bus_stops</text>
      </g>
      <path d="M540 168 C600 168, 620 79, 680 79" fill="none" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
      <path d="M540 168 C600 168, 620 113, 680 113" fill="none" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
      <path d="M540 168 C600 168, 620 147, 680 147" fill="none" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
      <text x="450" y="258" text-anchor="middle" font-size="11" fill="var(--muted)">get_type_parking / set_type_parking =</text>
      <g font-family="IBM Plex Mono, ui-monospace, monospace" font-size="11.5">
        <rect x="255" y="270" width="180" height="26" rx="6" fill="none" stroke="currentColor"/><text x="345" y="288" text-anchor="middle">parking → parking</text>
        <rect x="465" y="270" width="200" height="26" rx="6" fill="none" stroke="currentColor"/><text x="565" y="288" text-anchor="middle">bus_warehouse → bus_warehouses</text>
      </g>
      <path d="M420 225 L365 270" fill="none" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
      <path d="M480 225 L545 270" fill="none" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
      <g font-family="IBM Plex Mono, ui-monospace, monospace" font-size="11.5">
        <rect x="40" y="228" width="150" height="26" rx="6" fill="none" stroke="var(--accent)"/><text x="115" y="246" text-anchor="middle">entrances</text>
        <rect x="40" y="262" width="150" height="26" rx="6" fill="none" stroke="var(--accent)"/><text x="115" y="280" text-anchor="middle">paths</text>
      </g>
      <path d="M360 200 C300 200, 260 241, 190 241" fill="none" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#arr)"/>
      <path d="M360 210 C300 210, 260 275, 190 275" fill="none" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#arr)"/>
      <text x="262" y="232" font-size="10.5" fill="var(--muted)">entrance_id (FK)</text>
      <text x="262" y="300" font-size="10.5" fill="var(--muted)">path_id (FK)</text>
      <g font-size="11" fill="var(--muted)">
        <line x1="700" y1="300" x2="740" y2="300" stroke="currentColor" stroke-dasharray="5 4"/><text x="748" y="304">type + id, no constraint</text>
        <line x1="700" y1="320" x2="740" y2="320" stroke="var(--accent)" stroke-width="1.5"/><text x="748" y="324">foreign key</text>
      </g>
    </g>
  </svg>
  </div>
  <figcaption>Which table a plan’s start, end and parking ids point into is decided by the sibling <code>*_type</code> string, not by a constraint. Only <code>entrance_id</code> and <code>path_id</code> are enforced. In the data today: tarwia and direct_taseed run residence → camp, taseed_tarwia camp → camp, efada camp → dropOffArea, nafra dropOffArea → bus_stop.</figcaption>
</figure>

<h2 id="tables">Tables by domain</h2>
<p class="lede">Every column of every table, with keys, nullability (<span class="null">?</span>), foreign-key targets and their delete rule, and the row count at extraction. Cards link to each other through their references.</p>
${domainSections}

<h2 id="views">Views</h2>
<p class="lede">Read-only shapes built over the tables. The dashboard reads <code>plan_show_view</code>; the others are legacy reporting surfaces. <code>geography_columns</code> and <code>geometry_columns</code> are PostGIS catalog views and are omitted.</p>
<div class="views">${viewsHtml}</div>

<h2 id="auth">Users, roles and permissions</h2>
<p class="lede">Laravel’s RBAC (spatie/permission layout). The pivots point at users through <code>model_type</code> + <code>model_id</code> — the same type-discriminated pattern as plans — so those two edges are dotted.</p>
<figure>
  <div class="diagram small"><pre class="mermaid">
${authEr}
  </pre></div>
  <figcaption>The Node dashboard reads <code>users</code> (type_id, company_id, service_center_id decide the access scope) and validates sessions; roles and permissions are honoured for the admin fallback roles only.</figcaption>
</figure>

<h2 id="notes">Notes for whoever changes this schema</h2>
<div class="notes">
  <div class="note warn"><h4>Polymorphic references are unconstrained</h4><p><code>plans.start_point_*</code>, <code>end_point_*</code>, <code>get/set_parking_*</code> and the RBAC <code>model_*</code> pairs have no foreign keys. A deleted camp or drop-off leaves dangling plan rows; the views hide them with LEFT JOINs.</p></div>
  <div class="note warn"><h4><code>plans.transport_company_id</code> is orphaned</h4><p>Its target was the old contract table, retired and kept as <code>transport_companies_bak</code> (no primary key). Today’s <code>transport_companies</code> is a different table — the renamed <code>transports</code> name list — and nothing references it. The column stays because <code>plan_show_view</code> selects it; a plan’s suppliers come from <code>mashaers_trips</code> per service centre.</p></div>
  <div class="note"><h4><code>camps</code> carries four path roles</h4><p><code>path_entrance_id</code> (entrance → camp, Mina only: 628/630 set, Arafat 0/703), <code>path_camp_id</code> (Mina → Arafat, shared by 627 same-label camp pairs), <code>path_dropoff_id</code> (Arafat camp → Muzdalifah drop-off, 698/703), <code>path_residence_id</code> (unused). <code>drop_off_area_id</code> was added for efada generation; 674/703 Arafat camps are set.</p></div>
  <div class="note"><h4><code>mashaers_trips</code> is a bus roster</h4><p>One row per bus dispatched to a centre: <code>bus_id</code>, transport type, supplying company. Rows cascade with their service centre. It replaces the contract-style table that was retired.</p></div>
  <div class="note"><h4><code>assign_camps</code> / <code>assign_residences</code> were swapped into their right names</h4><p>Until 2026-09-21 the per-camp allocation lived in <code>assign_data</code> and the residence list in <code>assign_camps</code>. They now match the API datasets (<code>assign-camps</code>, <code>assign-residences</code>); constraint names were renamed with them.</p></div>
  <div class="note warn"><h4>No uniqueness where the import relies on it</h4><p>Nothing prevents two <code>service_centers</code> with the same (<code>company_id</code>, <code>office_number</code>) or two <code>service_companies</code> with the same name; the CSV import matches by exactly those and takes the first hit with a warning.</p></div>
  <div class="note"><h4>Config tables with duplicates</h4><p><code>round_trips</code> holds several rows for (efada, ترددي); the newest <code>updated_at</code> wins. <code>timing</code> has three placeholder 01:01–01:01 rows for efada period 1 beside the real window. <code>periods</code> should be ordered by <code>code</code>, not name.</p></div>
  <div class="note"><h4>Text where numbers are meant</h4><p><code>assign_residences.haj_count/tarwia/direct_taseed</code>, <code>round_trips.round_trip</code>, <code>plans.period</code> and <code>camps.gate_lat/gate_lon</code> (three coordinate conventions mixed) are varchar or inconsistently encoded; readers cast and normalise.</p></div>
  <div class="note"><h4>Shared residences</h4><p>A <code>residences</code> row is referenced by plans of up to 13 different service centres — one building housing several companies’ pilgrims — so start-point uniqueness is not per centre.</p></div>
</div>

<footer>Generated from the live <code>${esc(s.database)}</code> database (${esc(extracted)}) via the read-only <code>ro_user</code>; row counts are exact at that moment. Regenerate with <code>npm run erd</code> in <code>server/</code> — nothing here is hand-maintained.</footer>
</div>
${mermaidFallback}
` };
}

async function main() {
    const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'docs'));
    fs.mkdirSync(outDir, { recursive: true });
    const schema = await extractSchema();
    const { html, unassigned, relationCount, diagramTables } = render(schema);
    fs.writeFileSync(path.join(outDir, 'schema.json'), JSON.stringify(schema, null, 1));
    fs.writeFileSync(path.join(outDir, 'erd.html'), html);
    console.log(`[erd] ${schema.tables.length} tables, ${schema.columns.length} columns, ` +
        `${schema.constraints.filter((c) => c.contype === 'f').length} foreign keys, ${schema.views.length} views`);
    console.log(`[erd] diagram: ${diagramTables.length} entities, ${relationCount} relations`);
    if (unassigned.length) console.log(`[erd] not in DOMAINS, shown under System & backups: ${unassigned.join(', ')}`);
    console.log(`[erd] wrote ${path.join(outDir, 'erd.html')} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB) and schema.json`);
}

main().catch((err) => {
    console.error('[erd] failed:', err.message);
    process.exit(1);
});
