#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"   # repo root on this machine

# Deployment mode:
#   auto   -> local mode if LOCAL_LIVE_DIR exists (i.e. running on the prod VM),
#             otherwise remote mode (the normal case from a MacBook/dev machine)
#   local  -> deploy directly to LOCAL_LIVE_DIR (no SSH; run this on the VM)
#   remote -> deploy via SSH/rsync to REMOTE_HOST (run this from your MacBook)
DEPLOY_MODE="${DEPLOY_MODE:-auto}"

# Production host: maan.firstcity.ai -> 130.110.108.187 (OCI, user "ubuntu").
# Matches the "oci" entry in ~/.ssh/config.
REMOTE_HOST="${REMOTE_HOST:-ubuntu@130.110.108.187}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/maan-dashboard}"
REMOTE_DIST="${REMOTE_DIR}/dist"

LOCAL_LIVE_DIR="${LOCAL_LIVE_DIR:-/home/ubuntu/maan-dashboard.bak}"
LOCAL_LIVE_DIST="${LOCAL_LIVE_DIR}/dist"

BASE_PATH="/maan-dashboard/"
PM2_APP="maan-dashboard"
PM2_FE_APP="${PM2_FE_APP:-maan-dashboard-fe}"

# SSH key (override with: SSH_KEY=~/.ssh/other_key ./deploy-planning.sh)
SSH_KEY="${SSH_KEY:-$HOME/.ssh/ssh-key-2025-07-21-traffic-analysis.key}"
SSH_OPTS="-i ${SSH_KEY} -o StrictHostKeyChecking=accept-new"
# ─────────────────────────────────────────────────────────────────────────────

if [[ "${DEPLOY_MODE}" == "auto" ]]; then
    if [[ -d "${LOCAL_LIVE_DIR}" ]]; then
        DEPLOY_MODE="local"
    else
        DEPLOY_MODE="remote"
    fi
fi

if [[ "${DEPLOY_MODE}" != "local" && "${DEPLOY_MODE}" != "remote" ]]; then
    echo "❌ Invalid DEPLOY_MODE='${DEPLOY_MODE}'. Use: auto, local, or remote."
    exit 1
fi

echo "==> Deploy mode: ${DEPLOY_MODE}"

echo "==> Regenerating data modules..."
cd "${LOCAL_DIR}"
npm run generate-data

echo "==> Building locally..."
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

if [[ "${DEPLOY_MODE}" == "local" ]]; then
    echo "==> Syncing dist/ to local live path: ${LOCAL_LIVE_DIST} ..."
    mkdir -p "${LOCAL_LIVE_DIST}"
    rsync -az --delete "${DIST_DIR}/" "${LOCAL_LIVE_DIST}/"

    if [[ "${LOCAL_DIR}" != "${LOCAL_LIVE_DIR}" ]]; then
        echo "==> Syncing source to local frontend path: ${LOCAL_LIVE_DIR} ..."
        rsync -az --delete \
            --exclude '.git' \
            --exclude 'node_modules' \
            --exclude 'dist' \
            --exclude 'dist.bak' \
            "${LOCAL_DIR}/" "${LOCAL_LIVE_DIR}/"
    fi

    echo "==> Restarting local PM2 app '${PM2_APP}'..."
    pm2 restart "${PM2_APP}"

    if pm2 describe "${PM2_FE_APP}" >/dev/null 2>&1; then
        echo "==> Restarting local PM2 frontend app '${PM2_FE_APP}'..."
        pm2 restart "${PM2_FE_APP}"
    fi

    pm2 save
else
    if [[ ! -f "${SSH_KEY}" ]]; then
        echo "❌ SSH key not found: ${SSH_KEY}"
        echo "   Set a valid key, e.g.: SSH_KEY=~/.ssh/your_key ./deploy-planning.sh"
        exit 1
    fi

    echo "==> Uploading dist/ to ${REMOTE_HOST}:${REMOTE_DIST} ..."
    rsync -az --delete \
        -e "ssh ${SSH_OPTS}" \
        "${DIST_DIR}/" \
        "${REMOTE_HOST}:${REMOTE_DIST}/"

    echo "==> Restarting PM2 app '${PM2_APP}' on remote host..."
    # Run via a login shell so nvm / npm-global bin dirs are on PATH; fall back
    # to common install locations if 'pm2' still isn't found on PATH.
    REMOTE_RESTART_CMD='
        if ! command -v pm2 >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
            . "$HOME/.nvm/nvm.sh"
        fi
        PM2_BIN="$(command -v pm2 || true)"
        for c in "$HOME"/.nvm/versions/node/*/bin/pm2 /usr/local/bin/pm2 /usr/bin/pm2; do
            [ -n "$PM2_BIN" ] && break
            [ -x "$c" ] && PM2_BIN="$c"
        done
        [ -z "$PM2_BIN" ] && { echo "pm2 not found on remote host" >&2; exit 1; }
        "$PM2_BIN" restart '"${PM2_APP}"' && "$PM2_BIN" save
    '
    ssh ${SSH_OPTS} "${REMOTE_HOST}" "bash -l -c '${REMOTE_RESTART_CMD}'"
fi

echo ""
echo "Done. Live at: http://maan.firstcity.ai/maan-dashboard/"
