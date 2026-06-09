# Data Generation from CSV Files

This script regenerates browser data files from CSV, Excel, and GeoJSON source files.

## Script Location
```
/server/scripts/generate-data-from-csv.mjs
```

## Usage

### Generate All Files (Recommended)
```bash
cd /home/azureuser/maan-dashboard/server
node scripts/generate-data-from-csv.mjs all
```
Automatically finds and uses the latest CSV files for camps, residences, and simulation data, and regenerates Tarwiya exit path data from GeoJSON.

### Generate Camps Only
```bash
node scripts/generate-data-from-csv.mjs camps
```

### Generate Residences Only
```bash
node scripts/generate-data-from-csv.mjs residences
```

### Generate Both (Explicit)
```bash
node scripts/generate-data-from-csv.mjs both
```

### Generate Tarwiya Exit Paths Only
```bash
node scripts/generate-data-from-csv.mjs exit-paths
```
Uses:
```
/server/data/MIN_MINASM.geojson
/server/data/ExitPoints.geojson
```
Outputs:
```
/public/min_minasm.js
/public/exit_points.js
/dist/min_minasm.js
/dist/exit_points.js
```

### Generate from Specific CSV File
```bash
node scripts/generate-data-from-csv.mjs assign_camp_users_2026-05-21T04-24-09-163Z.csv
node scripts/generate-data-from-csv.mjs assign_residences2026-05-21T04-20-52-050Z.csv
```

## CSV File Locations

Place your CSV files in:
```
/server/data/assign_camp_users_*.csv
/server/data/assign_residences*.csv
```

The script automatically finds the **latest** file for each type.

## Output Files Generated

For CSV-backed modules, the script updates **three locations** automatically:

✅ `/server/data/assign_camps.js`
✅ `/public/data/assign_camps.js`
✅ `/dist/data/assign_camps.js`

✅ `/server/data/assign_residences.js`
✅ `/public/data/assign_residences.js`
✅ `/dist/data/assign_residences.js`

For Tarwiya exit path GeoJSON modules, the script updates the browser static roots:

✅ `/public/min_minasm.js`
✅ `/public/exit_points.js`
✅ `/dist/min_minasm.js`
✅ `/dist/exit_points.js`

## Current Files

**Camps Data:**
- Source: `assign_camp_users_2026-05-21T04-24-09-163Z.csv` (1,105 records)
- Output: `assign_camps.js` (104.82 KB)

**Residences Data:**
- Source: `assign_residences2026-05-21T04-20-52-050Z.csv` (4,296 records)
- Output: `assign_residences.js` (488.73 KB)

## How It Works

1. **Reads** the CSV file (with UTF-8 BOM support)
2. **Wraps** it in a JavaScript constant: `const ASSIGN_CAMPS_DATA = \`...\`;`
3. **Writes** to all three locations (server, public, dist)

## Future Updates

When you have new CSV files:
1. Place them in `/server/data/`
2. Run: `node scripts/generate-data-from-csv.mjs all`
3. All files will be automatically updated

## Related Scripts

- `/server/scripts/generate-data.mjs` - Generates all data (Excel + CSV sources)
