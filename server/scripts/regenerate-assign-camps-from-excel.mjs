#!/usr/bin/env node

/**
 * Regenerate assign_camps.js from assign_camps.xlsx Excel file
 * Usage:
 *   node regenerate-assign-camps-from-excel.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');

async function regenerateAssignCampsFromExcel() {
    const excelPath = path.join(dataDir, 'assign_camps.xlsx');

    if (!fs.existsSync(excelPath)) {
        console.error(`❌ File not found: ${excelPath}`);
        process.exit(1);
    }

    console.log('📊 Reading assign_camps.xlsx...');

    // Load workbook
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(excelPath);
    const worksheet = workbook.worksheets[0];

    if (!worksheet) {
        console.error('❌ No worksheet found in Excel file');
        process.exit(1);
    }

    // Extract data
    let headers = [];
    const rows = [];

    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) {
            // Header row
            headers = row.values.slice(1); // Skip first empty cell
        } else {
            // Data rows
            rows.push(row.values.slice(1)); // Skip first empty cell
        }
    });

    console.log(`✓ Found ${rows.length} data rows`);
    console.log(`✓ Columns: ${headers.join(', ')}`);

    // Convert to CSV format
    const csvLines = [];

    // Add header
    csvLines.push(headers.map(h => `"${(h || '').toString().replace(/"/g, '""')}"`).join(','));

    // Add data rows
    rows.forEach(row => {
        const csvRow = row.map((cell, idx) => {
            if (cell === null || cell === undefined) {
                return '';
            }
            const str = cell.toString().replace(/"/g, '""');
            // Only quote if contains comma, newline, or quote
            if (str.includes(',') || str.includes('\n') || str.includes('"')) {
                return `"${str}"`;
            }
            return str;
        });
        csvLines.push(csvRow.join(','));
    });

    const csvContent = csvLines.join('\n');

    // Generate JavaScript module
    const jsContent = `const ASSIGN_CAMPS_DATA = \`${csvContent}\`;\n`;

    // Write to all locations
    const outputPaths = [
        path.join(dataDir, 'assign_camps.csv'),
        path.join(dataDir, 'assign_camps.js'),
        path.join(dataDir, '..', '..', 'public', 'data', 'assign_camps.js'),
        path.join(dataDir, '..', '..', 'dist', 'data', 'assign_camps.js')
    ];

    console.log('\n📝 Writing output files...');

    for (const outputPath of outputPaths) {
        // Create directory if it doesn't exist
        const dirPath = path.dirname(outputPath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        fs.writeFileSync(outputPath, outputPath.endsWith('.js') ? jsContent : csvContent, 'utf-8');
        const size = fs.statSync(outputPath).size;
        console.log(`  ✓ ${path.basename(outputPath)} (${(size / 1024).toFixed(2)} KB)`);
    }

    console.log(`\n✓ Successfully regenerated from: ${path.relative(process.cwd(), excelPath)}`);
    console.log(`✓ Total rows: ${rows.length}`);
    console.log(`✓ Total columns: ${headers.length}`);
}

regenerateAssignCampsFromExcel().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
