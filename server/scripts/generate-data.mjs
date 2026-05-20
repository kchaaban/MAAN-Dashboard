import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import xlsx from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataDir = path.join(repoRoot, 'data');
const outputPath = path.join(dataDir, 'data.js');

function getLatestPlansCsv() {
    const preferred = process.env.PLANS_CSV || process.argv[2] || 'simulation_data_view_tarwiya_taseed.csv';
    const preferredPath = path.join(dataDir, preferred);
    if (fs.existsSync(preferredPath)) return preferredPath;

    const csvFiles = fs.readdirSync(dataDir)
        .filter(file => /^simulation_data_view_.*\.csv$/i.test(file))
        .map(file => ({
            file,
            path: path.join(dataDir, file),
            mtimeMs: fs.statSync(path.join(dataDir, file)).mtimeMs
        }))
        .sort((a, b) => b.file.localeCompare(a.file) || b.mtimeMs - a.mtimeMs);

    if (csvFiles.length) return csvFiles[0].path;

    const fallbackPath = path.join(dataDir, 'plans.csv');
    if (fs.existsSync(fallbackPath)) return fallbackPath;

    throw new Error('No plans CSV found in data/. Expected simulation_data_view_*.csv or plans.csv.');
}

function minifyGeojson(text) {
    return JSON.stringify(JSON.parse(text));
}

function workbookFirstSheetRows(filePath) {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    return xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
}

function workbookFirstSheetCsv(filePath) {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    return xlsx.utils.sheet_to_csv(workbook.Sheets[sheetName], { FS: ',', RS: '\n' });
}

function writeCsvDataModule(sourceFile, outputFile, variableName) {
    const sourcePath = path.join(dataDir, sourceFile);
    if (!fs.existsSync(sourcePath)) return false;

    const csvText = workbookFirstSheetCsv(sourcePath);
    const output = `const ${variableName} = ${JSON.stringify(csvText)};\n`;
    fs.writeFileSync(path.join(dataDir, outputFile), output, 'utf8');
    return true;
}

function writeServiceCompaniesModule() {
    const sourcePath = path.join(dataDir, 'service_companies.xlsx');
    if (!fs.existsSync(sourcePath)) return false;

    const rows = workbookFirstSheetRows(sourcePath).map(row => ({
        id: row.ID,
        name: String(row.Name_AR || row.name || '').trim(),
        nameEn: String(row.Name_EN || '').trim(),
        code: String(row.Code || '').trim(),
        color: String(row.Color || '').trim(),
        logo: String(row.Logo || row.logo || '').trim()
    })).filter(row => row.name);

    fs.writeFileSync(
        path.join(dataDir, 'service_companies.js'),
        `const SERVICE_COMPANIES_DATA = ${JSON.stringify(rows, null, 2)};\n`,
        'utf8'
    );
    return true;
}

const csvPath = getLatestPlansCsv();
const csvText = fs.readFileSync(csvPath, 'utf8');
const geojsonFiles = fs.readdirSync(dataDir)
    .filter(file => file.toLowerCase().endsWith('.geojson'))
    .sort((a, b) => a.localeCompare(b));

const lines = [
    `const PLANS_CSV_SOURCE = ${JSON.stringify(path.relative(repoRoot, csvPath))};`,
    `const CSV_DATA = ${JSON.stringify(csvText)};`,
    'const GEOJSON_DATA = [];'
];

geojsonFiles.forEach(file => {
    const fullPath = path.join(dataDir, file);
    const content = minifyGeojson(fs.readFileSync(fullPath, 'utf8'));
    lines.push(`GEOJSON_DATA.push({ filename: ${JSON.stringify(file)}, content: ${JSON.stringify(content)} });`);
});

fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');

const generatedModules = [];
if (writeCsvDataModule('assign_camps.xlsx', 'assign_camps.js', 'ASSIGN_CAMPS_DATA')) {
    generatedModules.push('data/assign_camps.js');
}
if (writeCsvDataModule('assign_residences.xlsx', 'assign_residences.js', 'ASSIGN_RESIDENCES_DATA')) {
    generatedModules.push('data/assign_residences.js');
}
if (writeServiceCompaniesModule()) {
    generatedModules.push('data/service_companies.js');
}

console.log(`Generated ${path.relative(repoRoot, outputPath)}`);
console.log(`Plans CSV: ${path.relative(repoRoot, csvPath)}`);
console.log(`GeoJSON files: ${geojsonFiles.length}`);
if (generatedModules.length) console.log(`Generated modules: ${generatedModules.join(', ')}`);
