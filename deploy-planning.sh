#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"   # repo root on this machine
REMOTE_HOST="azureuser@74.162.44.10"
REMOTE_DIR="/home/azureuser/maan-dashboard"
REMOTE_DIST="${REMOTE_DIR}/dist"
BASE_PATH="/maan-dashboard/"
PM2_APP="maan-dashboard"
# SSH key (override with: SSH_KEY=~/.ssh/other_key ./deploy-planning.sh)
SSH_KEY="${SSH_KEY:-$HOME/.ssh/ssh-key-2025-07-21-traffic-analysis.key}"
SSH_OPTS="-i ${SSH_KEY} -o StrictHostKeyChecking=accept-new"
# ─────────────────────────────────────────────────────────────────────────────

echo "==> Building locally..."
cd "${LOCAL_DIR}"
npm run build -- --base="${BASE_PATH}"

DIST_DIR="${LOCAL_DIR}/dist"

echo "==> Copying extra assets into dist/..."
cp "${LOCAL_DIR}/public/app.js"          "${DIST_DIR}/app.js"
cp "${LOCAL_DIR}/public/auth.js"         "${DIST_DIR}/auth.js" 2>/dev/null || true
cp "${LOCAL_DIR}/public/min_minasm.js"   "${DIST_DIR}/min_minasm.js"
cp "${LOCAL_DIR}/public/exit_points.js"  "${DIST_DIR}/exit_points.js"
mkdir -p "${DIST_DIR}/data"
cp "${LOCAL_DIR}/server/data/data.js"         "${DIST_DIR}/data/data.js"
cp "${LOCAL_DIR}/server/data/assign_camps.js" "${DIST_DIR}/data/assign_camps.js"
cp "${LOCAL_DIR}/server/data/assign_residences.js" "${DIST_DIR}/data/assign_residences.js"
cp "${LOCAL_DIR}/server/data/"*.png           "${DIST_DIR}/data/" 2>/dev/null || true

echo "==> Patching asset paths in dist/index.html..."
python3 - <<'PYDEPLOY'
from pathlib import Path
import re
index_path = Path('dist/index.html')
html = index_path.read_text()
html = re.sub(r'/maan-dashboard/assets/%D8%B4%D8%B9%D8%A7%D8%B1%20%D8%A7%D9%84%D9%87%D9%8A%D8%A6%D8%A9%20%D8%A7%D9%84%D9%85%D9%84%D9%83%D9%8A%D8%A9-[^" ]+\.png', 'data/%D8%B4%D8%B9%D8%A7%D8%B1%20%D8%A7%D9%84%D9%87%D9%8A%D8%A6%D8%A9%20%D8%A7%D9%84%D9%85%D9%84%D9%83%D9%8A%D8%A9.png', html)
html = re.sub(r'/maan-dashboard/assets/%D8%B4%D8%B9%D8%A7%D8%B1%20%D8%A7%D9%84%D9%85%D8%B1%D9%83%D8%B2%20%D8%A7%D9%84%D8%B9%D8%A7%D9%85%20%D9%84%D9%84%D9%86%D9%82%D9%84-[^" ]+\.png', 'data/%D8%B4%D8%B9%D8%A7%D8%B1%20%D8%A7%D9%84%D9%85%D8%B1%D9%83%D8%B2%20%D8%A7%D9%84%D8%B9%D8%A7%D9%85%20%D9%84%D9%84%D9%86%D9%82%D9%84.png', html)
html = re.sub(r'/maan-dashboard/assets/alliance-logo-[^" ]+\.png', 'data/alliance-logo.png', html)
index_path.write_text(html)
print("  index.html patched.")
PYDEPLOY

echo "==> Uploading dist/ to ${REMOTE_HOST}:${REMOTE_DIST} ..."
rsync -az --delete \
    -e "ssh ${SSH_OPTS}" \
    "${DIST_DIR}/" \
    "${REMOTE_HOST}:${REMOTE_DIST}/"

echo "==> Restarting PM2 app '${PM2_APP}'..."
ssh ${SSH_OPTS} "${REMOTE_HOST}" "pm2 restart ${PM2_APP} && pm2 save"

echo ""
echo "Done. Live at: http://74.162.44.10/maan-dashboard/"
