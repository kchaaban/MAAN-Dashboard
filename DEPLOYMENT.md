# Deployment Guide

Production runs on the OCI VM (`maan.firstcity.ai`, `130.110.108.187`, user `ubuntu`):

- PM2 app `maan-dashboard` runs `server/index.js` from `/home/ubuntu/maan-dashboard` on port 3100.
- The server serves both the API (`/maan-dashboard/api/*`) and the built frontend (`dist/`).
- nginx proxies `https://maan.firstcity.ai/maan-dashboard/` to `127.0.0.1:3100`.
- The server reads the `transport` database on the same VM (`127.0.0.1:5432`).

## Deploy

From a dev machine, in the repo root:

```bash
./deploy-planning.sh            # or: npm run deploy
./deploy-planning.sh --dry-run  # build and list what would change on the VM
```

The script:

1. Checks the SSH key, the untracked data files (`public/data/*.js`, `server/.env`) and warns about uncommitted changes.
2. Builds the frontend into a temporary folder (the tracked `dist/` is not touched) and writes `version.txt` with the commit.
3. Backs up the VM's `dist/` and `server/` to `~/maan-dashboard-backups/<timestamp>.tgz` (keeps the last 10).
4. Rsyncs the build to `dist/` and the server code to `server/`. `server/data/` is only added to, never deleted from. `server/.env` and `node_modules` stay as they are on the VM.
5. On the first deploy, creates the VM's `server/.env` from the local one, pointing the database at `127.0.0.1:5432`. Adds a random `JWT_SECRET` if there is none. The file is never overwritten afterwards, so edit it on the VM to change production settings.
6. Runs `npm ci --omit=dev` in `server/`, restarts PM2 with `--update-env` and saves the process list.
7. Checks `/maan-dashboard/api/db-health` and the page itself. If either fails, it prints the PM2 logs and the rollback command.

Settings (env vars): `REMOTE_HOST`, `REMOTE_DIR`, `BACKUP_DIR`, `SSH_KEY` (default `~/.ssh/bus-data-analysis_key.pem`), `PM2_APP`, `APP_PORT`.

## Verify

```bash
curl -s https://maan.firstcity.ai/maan-dashboard/version.txt
curl -s https://maan.firstcity.ai/maan-dashboard/api/db-health
```

## Roll back

```bash
ssh oci 'cd ~/maan-dashboard && rm -rf dist server && tar -xzf ~/maan-dashboard-backups/<timestamp>.tgz \
  && cd server && npm ci --omit=dev && pm2 restart maan-dashboard'
```

## Not deployed by the script

- Route generation and optimization are offline jobs (see `server/sql/routing/README.md`). Long runs go on the VM from `~/routegen`.
- Database schema changes (`server/sql/`) are applied by hand.

## Troubleshooting

- `Missing public/data/...`: these GIS layers are not in git. Copy them into the working copy before deploying.
- Health check fails with a database error: check `PGHOST`/`PGPORT`/credentials in the VM's `server/.env`.
- `pm2 logs maan-dashboard` on the VM shows server errors.
