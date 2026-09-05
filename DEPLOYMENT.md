# Deployment Guide

This project uses one script for production publishing:

- `deploy-planning.sh`

The script now supports both local-VM deployment and remote SSH deployment.

## Quick Start (This VM)

Run from project root:

```bash
bash deploy-planning.sh
```

What this does:

1. Regenerates data modules (`npm run generate-data`)
2. Builds production assets with base path `/maan-dashboard/`
3. Syncs `dist/` to local live path `/home/ubuntu/maan-dashboard.bak/dist`
4. Restarts PM2 app `maan-dashboard`
5. Saves PM2 process list

Live URL:

- `http://maan.firstcity.ai/maan-dashboard/`

## Deploying from a MacBook / dev machine

`auto` mode detects there is no local live directory and switches to `remote`
mode automatically, so from your Mac you can just run:

```bash
bash deploy-planning.sh
```

This builds locally (needs Node + `npm install` first) and rsyncs `dist/` over
SSH to the production host, then restarts PM2 there.

Remote target (defaults, override with env vars):

- `REMOTE_HOST=ubuntu@130.110.108.187` (`maan.firstcity.ai`, OCI)
- `REMOTE_DIR=/home/ubuntu/maan-dashboard`
- `SSH_KEY=~/.ssh/ssh-key-2025-07-21-traffic-analysis.key`

## Deployment Modes

Default mode is `auto`.

- `auto`: uses local mode if the local live directory exists (i.e. you are on
  the prod VM), otherwise remote mode
- `local`: deploy directly on the current VM (no SSH key needed)
- `remote`: deploy to the production host over SSH

Examples:

```bash
# Auto-detect mode (recommended)
bash deploy-planning.sh

# Force remote mode with a different key
DEPLOY_MODE=remote SSH_KEY=~/.ssh/your_key bash deploy-planning.sh

# Force local mode (only on the VM)
DEPLOY_MODE=local bash deploy-planning.sh
```

## Safe Usage Checklist

1. Run from repo root: `/home/ubuntu/maan-dashboard`
2. Confirm no failing changes before deploy:

```bash
git status --short
```

3. Deploy:

```bash
bash deploy-planning.sh
```

4. Verify:

```bash
curl -I http://maan.firstcity.ai/maan-dashboard/
curl -I "http://maan.firstcity.ai/maan-dashboard/data/cameras.js?v=20260610"
```

## Troubleshooting

- `SSH key not found`: use local mode on this VM or provide a valid `SSH_KEY` for remote mode.
- `File not found` for GeoJSON exit paths: current behavior is warning-only in full generation unless `exit-paths` is explicitly requested.
- PM2 process name mismatch: check running apps with `pm2 list` and update `PM2_APP` in `deploy-planning.sh` if needed.