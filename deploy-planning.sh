#!/usr/bin/env bash
# Deploys the planning dashboard (frontend build + Express server) to the OCI VM.
#
#   ./deploy-planning.sh              build, upload, install, restart, health check
#   ./deploy-planning.sh --dry-run    build and show what would be uploaded
#
# Run from a dev machine. The frontend is built locally (public/data/*.js are
# not in git, so the build needs this working copy); the server code, the build
# and server/data are rsynced to the VM, where PM2 runs server/index.js, which
# serves both the API and dist/ under /maan-dashboard/ (nginx proxies to :3100).
#
# The VM keeps its own server/.env (never overwritten). On the first deploy it
# is created from the local server/.env with the database pointed at the VM's
# own Postgres (127.0.0.1:5432) and a fresh JWT_SECRET.
set -euo pipefail

# ── Configuration (override with env vars) ───────────────────────────────────
REMOTE_HOST="${REMOTE_HOST:-ubuntu@130.110.108.187}"   # maan.firstcity.ai, "oci" in ~/.ssh/config
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/maan-dashboard}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/maan-dashboard-backups}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/bus-data-analysis_key.pem}"
PM2_APP="${PM2_APP:-maan-dashboard}"
APP_PORT="${APP_PORT:-3100}"
BASE_PATH="/maan-dashboard/"
PUBLIC_URL="https://maan.firstcity.ai/maan-dashboard/"
# ─────────────────────────────────────────────────────────────────────────────

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${LOCAL_DIR}"

# ClearAllForwardings: the "oci" host entry opens DB tunnels we don't want here.
SSH_OPTS=(-i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new -o ClearAllForwardings=yes -o ConnectTimeout=15)
RSYNC_SSH="ssh ${SSH_OPTS[*]}"
remote() { ssh "${SSH_OPTS[@]}" "${REMOTE_HOST}" "$@"; }

echo "==> Pre-flight checks"
[[ -f "${SSH_KEY}" ]] || { echo "❌ SSH key not found: ${SSH_KEY} (set SSH_KEY=...)"; exit 1; }
for f in public/data/cameras.js public/data/districts.js public/data/makaf_paths.js server/.env; do
    [[ -f "$f" ]] || { echo "❌ Missing $f (not in git; copy it into this working copy first)"; exit 1; }
done
if [[ -n "$(git status --porcelain)" ]]; then
    echo "⚠️  Uncommitted changes will be deployed:"
    git status --short | sed 's/^/     /'
fi
echo "    deploying $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
remote true || { echo "❌ Cannot reach ${REMOTE_HOST}"; exit 1; }

echo "==> Building frontend"
# Build outside the repo so the tracked dist/ is left untouched.
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "${BUILD_DIR}"' EXIT
npx vite build --base="${BASE_PATH}" --outDir "${BUILD_DIR}" --emptyOutDir --logLevel warn
for f in index.html app.js auth.js min_minasm.js exit_points.js data/cameras.js data/districts.js data/makaf_paths.js; do
    [[ -f "${BUILD_DIR}/$f" ]] || { echo "❌ Build is missing $f"; exit 1; }
done
echo "$(git rev-parse --short HEAD) $(date -u +%FT%TZ)" > "${BUILD_DIR}/version.txt"

RSYNC_KEEP=(-az --exclude .DS_Store -e "${RSYNC_SSH}")   # add/update only
[[ ${DRY_RUN} -eq 1 ]] && RSYNC_KEEP+=(--dry-run --itemize-changes)
RSYNC_FLAGS=("${RSYNC_KEEP[@]}" --delete)    # mirror

if [[ ${DRY_RUN} -eq 0 ]]; then
    echo "==> Backing up current deployment on the VM"
    STAMP="$(date +%Y%m%d-%H%M%S)"
    remote "mkdir -p '${BACKUP_DIR}' && cd '${REMOTE_DIR}' && \
        tar -czf '${BACKUP_DIR}/${STAMP}.tgz' --exclude=node_modules dist server && \
        ls -1t '${BACKUP_DIR}'/*.tgz | tail -n +11 | xargs -r rm -f"
    echo "    ${BACKUP_DIR}/${STAMP}.tgz"
fi

echo "==> Uploading frontend build → ${REMOTE_DIR}/dist"
rsync "${RSYNC_FLAGS[@]}" "${BUILD_DIR}/" "${REMOTE_HOST}:${REMOTE_DIR}/dist/"

echo "==> Uploading server code → ${REMOTE_DIR}/server"
# server/data is excluded here (and synced below without --delete) so files
# that only exist on the VM are kept. .env and node_modules stay VM-specific.
rsync "${RSYNC_FLAGS[@]}" \
    --exclude node_modules --exclude .env --exclude data/ \
    server/ "${REMOTE_HOST}:${REMOTE_DIR}/server/"
rsync "${RSYNC_KEEP[@]}" server/data/ "${REMOTE_HOST}:${REMOTE_DIR}/server/data/"

if [[ ${DRY_RUN} -eq 1 ]]; then
    echo "Dry run: nothing changed on the VM."
    exit 0
fi

echo "==> Checking server/.env on the VM"
if remote "test -f '${REMOTE_DIR}/server/.env'"; then
    echo "    present (kept as is)"
else
    echo "    missing: creating it from the local server/.env (database → 127.0.0.1:5432)"
    sed -e 's/^PGHOST=.*/PGHOST=127.0.0.1/' -e 's/^PGPORT=.*/PGPORT=5432/' -e '/^JWT_SECRET=/d' server/.env \
        | remote "umask 077 && cat > '${REMOTE_DIR}/server/.env'"
fi
# Without JWT_SECRET the server falls back to a hard-coded key.
remote "grep -q '^JWT_SECRET=.' '${REMOTE_DIR}/server/.env' || \
    { printf '\nJWT_SECRET=%s\n' \"\$(openssl rand -hex 32)\" >> '${REMOTE_DIR}/server/.env' && echo '    added JWT_SECRET (users must sign in again)'; }
    chmod 600 '${REMOTE_DIR}/server/.env'"

echo "==> Installing server dependencies and restarting PM2 app '${PM2_APP}'"
# Login shell + nvm so node/npm/pm2 are on PATH.
remote "bash -lc '
    set -e
    [ -s \"\$HOME/.nvm/nvm.sh\" ] && . \"\$HOME/.nvm/nvm.sh\" >/dev/null
    cd \"${REMOTE_DIR}/server\"
    npm ci --omit=dev --no-audit --no-fund --loglevel=error
    pm2 restart \"${PM2_APP}\" --update-env >/dev/null
    pm2 save >/dev/null
'"

echo "==> Health check"
ok=0
for _ in $(seq 1 15); do
    if remote "curl -fsS http://127.0.0.1:${APP_PORT}/maan-dashboard/api/db-health >/dev/null && \
               curl -fsS -o /dev/null http://127.0.0.1:${APP_PORT}/maan-dashboard/"; then
        ok=1; break
    fi
    sleep 2
done
if [[ ${ok} -eq 1 ]]; then
    echo "    app and database OK ($(remote "cat '${REMOTE_DIR}/dist/version.txt'"))"
    echo ""
    echo "Done. Live at: ${PUBLIC_URL}"
else
    echo "❌ Health check failed. Recent logs:"
    remote "bash -lc '. \"\$HOME/.nvm/nvm.sh\" >/dev/null; pm2 logs \"${PM2_APP}\" --lines 30 --nostream'" || true
    echo ""
    echo "Roll back with:"
    echo "  ssh oci 'cd ${REMOTE_DIR} && rm -rf dist server && tar -xzf ${BACKUP_DIR}/${STAMP}.tgz && cd server && npm ci --omit=dev && pm2 restart ${PM2_APP}'"
    exit 1
fi
