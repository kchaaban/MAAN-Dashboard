#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="/home/azureuser/dev/"
DST_DIR="/var/www/planning-dashboard/"

echo "Deploying planning dashboard..."
echo "Source: ${SRC_DIR}"
echo "Target: ${DST_DIR}"

sudo mkdir -p "${DST_DIR}"

sudo rsync -av --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude '*.md' \
  --exclude '.DS_Store' \
  "${SRC_DIR}" "${DST_DIR}"

sudo chown -R www-data:www-data "${DST_DIR}"
sudo find "${DST_DIR}" -type d -exec chmod 755 {} \;
sudo find "${DST_DIR}" -type f -exec chmod 644 {} \;

sudo nginx -t
sudo systemctl reload nginx

echo "Done."
echo "Open: http://74.162.44.10/planning/"
