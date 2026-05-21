import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');

/**
 * Generate assign_camps.js and assign_residences.js from CSV files
 * Usage:
 *   node generate-data-from-csv.mjs              # Auto-find latest files
 *   node generate-data-from-csv.mjs camps        # Regenerate only camps
 *   node generate-data-from-csv.mjs residences   # Regenerate only residences
 *   node generate-data-from-csv.mjs both         # Regenerate both
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
        fs.writeFileSync(outputPath, jsContent, 'utf-8');
        const size = fs.statSync(outputPath).size;
        console.log(`  ✓ ${path.basename(outputPath)} (${(size / 1024).toFixed(2)} KB)`);
    });

    console.log(`\n✓ Generated from: ${path.relative(process.cwd(), csvPath)}\n`);
    return true;
}

function main() {
    const arg = process.argv[2]?.toLowerCase() || 'both';

    console.log('📦 Generating data modules from CSV files...\n');

    let success = false;

    // Handle camps
    if (arg === 'both' || arg === 'camps' || !['both', 'residences', 'camps'].includes(arg)) {
        const campsCsv = arg === 'both' || arg === 'camps' || arg === undefined
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
    if (arg === 'both' || arg === 'residences' || !['both', 'residences', 'camps'].includes(arg)) {
        const residencesCsv = arg === 'both' || arg === 'residences' || arg === undefined
            ? findLatestCsv('assign_residences')
            : (arg.includes('residence') ? path.join(dataDir, arg) : null);

        if (residencesCsv) {
            console.log('🏘️  Residences Data:');
            if (generateFromCsv(residencesCsv, 'ASSIGN_RESIDENCES_DATA', 'assign_residences')) {
                success = true;
            }
        }
    }

    if (!success) {
        console.error('❌ No CSV files found or processed');
        process.exit(1);
    }
}

main();
