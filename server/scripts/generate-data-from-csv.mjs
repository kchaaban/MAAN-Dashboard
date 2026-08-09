import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const SIMULATION_CSV_PATTERN = 'simulation_data_view_v2';
const PREFERRED_SIMULATION_CSV = 'simulation_data_view_updated.csv';
const STATIC_DATA_MODULES = ['cameras.js', 'districts.js', 'camps_gates.js', 'makaf_paths.js'];

/**
 * Generate data modules from CSV/Excel/GeoJSON files.
 * Usage:
 *   node generate-data-from-csv.mjs              # Auto-find and regenerate all
 *   node generate-data-from-csv.mjs camps        # Regenerate only camps from latest CSV
 *   node generate-data-from-csv.mjs camps-excel  # Regenerate camps from assign_camps.xlsx
 *   node generate-data-from-csv.mjs residences   # Regenerate only residences
 *   node generate-data-from-csv.mjs simulation   # Regenerate only simulation (data.js)
 *   node generate-data-from-csv.mjs exit-paths   # Regenerate Tarwiya exit path GeoJSON data
 *   node generate-data-from-csv.mjs both         # Regenerate camps and residences
 *   node generate-data-from-csv.mjs all          # Regenerate all three
 *   node generate-data-from-csv.mjs <csv-file>   # Specific file by name
 */

function findLatestCsv(pattern) {
    const csvFiles = fs.readdirSync(dataDir)
        .filter(file => file.includes(pattern) && file.endsWith('.csv'))
        .sort()
        .reverse();

    if (csvFiles.length === 0) {
        return null;
    }
    return path.join(dataDir, csvFiles[0]);
}

function findLatestSimulationCsv() {
    const preferredPath = path.join(dataDir, PREFERRED_SIMULATION_CSV);
    if (fs.existsSync(preferredPath)) {
        return preferredPath;
    }
    return findLatestCsv(SIMULATION_CSV_PATTERN);
}

async function generateFromExcel(excelPath, variableName, outputBaseName) {
    if (!fs.existsSync(excelPath)) {
        console.error(`❌ File not found: ${excelPath}`);
        return false;
    }

    try {
        // Load workbook
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(excelPath);
        const worksheet = workbook.worksheets[0];

        if (!worksheet) {
            console.error('❌ No worksheet found in Excel file');
            return false;
        }

        // Extract data and convert to CSV
        let headers = [];
        const rows = [];

        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) {
                headers = row.values.slice(1);
            } else {
                rows.push(row.values.slice(1));
            }
        });

        const csvLines = [];
        csvLines.push(headers.map(h => `"${(h || '').toString().replace(/"/g, '""')}"`).join(','));

        rows.forEach(row => {
            const csvRow = row.map((cell) => {
                if (cell === null || cell === undefined) {
                    return '';
                }
                const str = cell.toString().replace(/"/g, '""');
                if (str.includes(',') || str.includes('\n') || str.includes('"')) {
                    return `"${str}"`;
                }
                return str;
            });
            csvLines.push(csvRow.join(','));
        });

        const csvContent = csvLines.join('\n');
        const jsContent = `const ${variableName} = \`${csvContent}\`;\n`;

        // Write to all three locations
        const outputPaths = [
            path.join(dataDir, `${outputBaseName}.js`),
            path.join(dataDir, '..', '..', 'public', 'data', `${outputBaseName}.js`),
            path.join(dataDir, '..', '..', 'dist', 'data', `${outputBaseName}.js`)
        ];

        outputPaths.forEach(outputPath => {
            const dirPath = path.dirname(outputPath);
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }
            fs.writeFileSync(outputPath, jsContent, 'utf-8');
            const size = fs.statSync(outputPath).size;
            console.log(`  ✓ ${path.basename(outputPath)} (${(size / 1024).toFixed(2)} KB)`);
        });

        console.log(`\n✓ Generated from: ${path.relative(process.cwd(), excelPath)}\n`);
        return true;
    } catch (error) {
        console.error(`❌ Error reading Excel: ${error.message}`);
        return false;
    }
}

function generateFromCsv(csvPath, variableName, outputBaseName) {
    if (!fs.existsSync(csvPath)) {
        console.error(`❌ File not found: ${csvPath}`);
        return false;
    }

    // Read CSV content
    const csvContent = fs.readFileSync(csvPath, 'utf-8');

    // Generate JavaScript module
    const jsContent = `const ${variableName} = \`${csvContent}\`;\n`;

    // Write to all three locations
    const outputPaths = [
        path.join(dataDir, `${outputBaseName}.js`),
        path.join(dataDir, '..', '..', 'public', 'data', `${outputBaseName}.js`),
        path.join(dataDir, '..', '..', 'dist', 'data', `${outputBaseName}.js`)
    ];

    outputPaths.forEach(outputPath => {
        const dirPath = path.dirname(outputPath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        fs.writeFileSync(outputPath, jsContent, 'utf-8');
        const size = fs.statSync(outputPath).size;
        console.log(`  ✓ ${path.basename(outputPath)} (${(size / 1024).toFixed(2)} KB)`);
    });

    console.log(`\n✓ Generated from: ${path.relative(process.cwd(), csvPath)}\n`);
    return true;
}

function writeGeneratedModule(jsContent, outputPaths) {
    outputPaths.forEach(outputPath => {
        const dirPath = path.dirname(outputPath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        fs.writeFileSync(outputPath, jsContent, 'utf-8');
        const size = fs.statSync(outputPath).size;
        console.log(`  ✓ ${path.relative(process.cwd(), outputPath)} (${(size / 1024).toFixed(2)} KB)`);
    });
}

function syncStaticDataModules() {
    console.log('🧩 Static Data Modules:');

    const targetDirs = [
        path.join(dataDir, '..', '..', 'public', 'data'),
        path.join(dataDir, '..', '..', 'dist', 'data')
    ];

    targetDirs.forEach(targetDir => {
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
    });

    let copiedCount = 0;

    STATIC_DATA_MODULES.forEach(fileName => {
        const sourcePath = path.join(dataDir, fileName);

        if (!fs.existsSync(sourcePath)) {
            console.warn(`  ⚠ Missing source file: ${path.relative(process.cwd(), sourcePath)}`);
            return;
        }

        targetDirs.forEach(targetDir => {
            const targetPath = path.join(targetDir, fileName);
            fs.copyFileSync(sourcePath, targetPath);
            const size = fs.statSync(targetPath).size;
            console.log(`  ✓ ${path.relative(process.cwd(), targetPath)} (${(size / 1024).toFixed(2)} KB)`);
            copiedCount += 1;
        });
    });

    if (copiedCount === 0) {
        console.warn('  ⚠ No static data modules were copied');
        return false;
    }

    console.log('');
    return true;
}

function generateFromGeojson(geojsonPath, variableName, outputBaseName) {
    if (!fs.existsSync(geojsonPath)) {
        console.error(`❌ File not found: ${geojsonPath}`);
        return false;
    }

    const geojson = JSON.parse(fs.readFileSync(geojsonPath, 'utf-8'));
    const jsContent = `const ${variableName} = ${JSON.stringify(geojson)};\n`;
    const outputPaths = [
        path.join(dataDir, '..', '..', 'public', `${outputBaseName}.js`),
        path.join(dataDir, '..', '..', 'dist', `${outputBaseName}.js`)
    ];

    writeGeneratedModule(jsContent, outputPaths);
    console.log(`\n✓ Generated from: ${path.relative(process.cwd(), geojsonPath)}\n`);
    return true;
}

function hasExitPathSources() {
    const minMinaPath = path.join(dataDir, 'MIN_MINASM.geojson');
    const exitPointsPath = path.join(dataDir, 'ExitPoints.geojson');
    return fs.existsSync(minMinaPath) && fs.existsSync(exitPointsPath);
}

function generateExitPaths(strict = false) {
    console.log('🚪 Tarwiya Exit Paths:');
    const minMinaPath = path.join(dataDir, 'MIN_MINASM.geojson');
    const exitPointsPath = path.join(dataDir, 'ExitPoints.geojson');

    if (!fs.existsSync(minMinaPath) || !fs.existsSync(exitPointsPath)) {
        if (strict) {
            if (!fs.existsSync(minMinaPath)) {
                console.error(`❌ File not found: ${minMinaPath}`);
            }
            if (!fs.existsSync(exitPointsPath)) {
                console.error(`❌ File not found: ${exitPointsPath}`);
            }
            return false;
        }

        console.log('  ⚠ Skipping exit paths: required GeoJSON files not found in server/data');
        return false;
    }

    const minMinaOk = generateFromGeojson(
        minMinaPath,
        'MIN_MINASM_DATA',
        'min_minasm'
    );
    const exitPointsOk = generateFromGeojson(
        exitPointsPath,
        'EXIT_POINTS_DATA',
        'exit_points'
    );
    return minMinaOk && exitPointsOk;
}

async function main() {
    const arg = process.argv[2]?.toLowerCase() || 'all';
    const validArgs = ['all', 'both', 'residences', 'camps', 'camps-excel', 'simulation', 'data', 'exit-paths'];

    console.log('📦 Generating data modules from CSV/Excel/GeoJSON files...\n');

    syncStaticDataModules();

    let success = false;

    // Handle camps-excel special case
    if (arg === 'camps-excel') {
        console.log('📋 Camps Data (from Excel):');
        const excelPath = path.join(dataDir, 'assign_camps.xlsx');
        if (await generateFromExcel(excelPath, 'ASSIGN_CAMPS_DATA', 'assign_camps')) {
            success = true;
        }
        if (!success) {
            process.exit(1);
        }
        return;
    }

    // Determine what to regenerate
    const shouldRegenerateCamps = arg === 'all' || arg === 'both' || arg === 'camps' ||
                                  (!validArgs.includes(arg) && arg.includes('camp'));
    const shouldRegenerateResidences = arg === 'all' || arg === 'both' || arg === 'residences' ||
                                       (!validArgs.includes(arg) && arg.includes('residence'));
    const shouldRegenerateSimulation = arg === 'all' || arg === 'simulation' || arg === 'data' ||
                                       (!validArgs.includes(arg) && arg.includes('simulation'));
    const shouldRegenerateExitPaths = arg === 'all' || arg === 'exit-paths';

    // Handle camps
    if (shouldRegenerateCamps) {
        const campsCsv = arg === 'camps' || arg === 'both' || arg === 'all' || arg === undefined
            ? findLatestCsv('assign_camp')
            : (arg.includes('camp') ? path.join(dataDir, arg) : null);

        if (campsCsv) {
            console.log('📋 Camps Data:');
            if (generateFromCsv(campsCsv, 'ASSIGN_CAMPS_DATA', 'assign_camps')) {
                success = true;
            }
        }
    }

    // Handle residences
    if (shouldRegenerateResidences) {
        const residencesCsv = arg === 'residences' || arg === 'both' || arg === 'all' || arg === undefined
            ? findLatestCsv('assign_residences')
            : (arg.includes('residence') ? path.join(dataDir, arg) : null);

        if (residencesCsv) {
            console.log('🏘️  Residences Data:');
            if (generateFromCsv(residencesCsv, 'ASSIGN_RESIDENCES_DATA', 'assign_residences')) {
                success = true;
            }
        }
    }

    // Handle simulation data
    if (shouldRegenerateSimulation) {
        const simulationCsv = arg === 'simulation' || arg === 'data' || arg === 'all' || arg === undefined
            ? findLatestSimulationCsv()
            : (arg.includes('simulation') || arg.includes('data') ? path.join(dataDir, arg) : null);

        if (simulationCsv) {
            console.log('📊 Simulation Data (Plans):');
            if (generateFromCsv(simulationCsv, 'CSV_DATA', 'data')) {
                success = true;
            }
        }
    }

    if (shouldRegenerateExitPaths) {
        const strictExitPaths = arg === 'exit-paths';
        if (generateExitPaths(strictExitPaths)) {
            success = true;
        } else if (!strictExitPaths && hasExitPathSources()) {
            success = true;
        }
    }

    if (!success) {
        console.error('❌ No data files found or processed');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
