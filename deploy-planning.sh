#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="/home/azureuser/maan-dashboard/"
DST_DIR="/home/azureuser/maan-dashboard/dist/"
DIST_DIR="${SRC_DIR}dist/"
BASE_PATH="/maan-dashboard/"
PM2_APP="maan-dashboard"

echo "Deploying Maan dashboard..."
echo "Source: ${SRC_DIR}"
echo "Build: ${DIST_DIR}"
echo "Target: ${DST_DIR}"

cd "${SRC_DIR}"

npm run build -- --base="${BASE_PATH}"

cp public/app.js "${DIST_DIR}app.js"
mkdir -p "${DIST_DIR}data"
cp server/data/data.js "${DIST_DIR}data/data.js"
cp server/data/assign_camps.js "${DIST_DIR}data/assign_camps.js"
cp server/data/*.png "${DIST_DIR}data/" 2>/dev/null || true

python3 - <<'PYDEPLOY'
from pathlib import Path
import re
index_path = Path('/home/azureuser/maan-dashboard/dist/index.html')
html = index_path.read_text()
html = re.sub(r'/maan-dashboard/assets/%D8%B4%D8%B9%D8%A7%D8%B1%20%D8%A7%D9%84%D9%87%D9%8A%D8%A6%D8%A9%20%D8%A7%D9%84%D9%85%D9%84%D9%83%D9%8A%D8%A9-[^" ]+\.png', 'data/%D8%B4%D8%B9%D8%A7%D8%B1%20%D8%A7%D9%84%D9%87%D9%8A%D8%A6%D8%A9%20%D8%A7%D9%84%D9%85%D9%84%D9%83%D9%8A%D8%A9.png', html)
html = re.sub(r'/maan-dashboard/assets/%D8%B4%D8%B9%D8%A7%D8%B1%20%D8%A7%D9%84%D9%85%D8%B1%D9%83%D8%B2%20%D8%A7%D9%84%D8%B9%D8%A7%D9%85%20%D9%84%D9%84%D9%86%D9%82%D9%84-[^" ]+\.png', 'data/%D8%B4%D8%B9%D8%A7%D8%B1%20%D8%A7%D9%84%D9%85%D8%B1%D9%83%D8%B2%20%D8%A7%D9%84%D8%B9%D8%A7%D9%85%20%D9%84%D9%84%D9%86%D9%82%D9%84.png', html)
html = re.sub(r'/maan-dashboard/assets/alliance-logo-[^" ]+\.png', 'data/alliance-logo.png', html)
index_path.write_text(html)
PYDEPLOY

pm2 restart "${PM2_APP}"

echo "Done."
echo "Open: http://74.162.44.10/maan-dashboard/"
