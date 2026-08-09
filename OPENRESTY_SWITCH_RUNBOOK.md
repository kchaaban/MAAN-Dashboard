# OpenResty/Nginx Switch Runbook (Remove maan-dashboard-fe Permanently)

Goal:
- Route `maan.firstcity.ai/maan-dashboard/` to backend app on `127.0.0.1:3100`
- Stop depending on Vite dev server (`maan-dashboard-fe`)

Prerequisites:
- Backend PM2 app `maan-dashboard` is online on port `3100`
- You have root/sudo access to OpenResty/Nginx config

## 1) Find the active server block file

Run as root:

sudo nginx -T | grep -n "server_name\|maan.firstcity.ai\|proxy_pass\|listen" -n

If that does not show enough context, print full config:

sudo nginx -T > /tmp/nginx-full-dump.txt

Then locate the active file path(s) containing `server_name maan.firstcity.ai`.

## 2) Update server block to proxy to backend (3100)

Inside the active `server { ... }` for `maan.firstcity.ai`, use this exact routing logic:

server {
    listen 80;
    server_name maan.firstcity.ai;

    # Optional but recommended for large API payloads
    client_max_body_size 200m;

    # Canonical trailing slash
    location = /maan-dashboard {
        return 301 /maan-dashboard/;
    }

    # Route dashboard and data files to backend static/app server
    location /maan-dashboard/ {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300;
    }
}

Important:
- Remove or disable any proxy target that points to `127.0.0.1:5173`.
- Keep only the `3100` upstream for `/maan-dashboard/`.

## 3) Validate and reload OpenResty/Nginx

Run as root:

sudo nginx -t
sudo systemctl reload nginx || sudo nginx -s reload

## 4) Verify domain before deleting dev frontend process

Run:

curl -I http://maan.firstcity.ai/maan-dashboard/
curl -I "http://maan.firstcity.ai/maan-dashboard/data/cameras.js?v=20260610"

Expected:
- both return `200`

## 5) Remove dev frontend process permanently

After successful verification:

pm2 delete maan-dashboard-fe
pm2 save
pm2 list

Expected:
- only `maan-dashboard` remains online

## 6) Post-switch smoke test

Run:

curl -s -o /tmp/maan_live.html -w "%{http_code}\n" http://maan.firstcity.ai/maan-dashboard/
curl -s -o /tmp/maan_cam.js -w "%{http_code}\n" "http://maan.firstcity.ai/maan-dashboard/data/cameras.js?v=20260610"

Both should return `200`.

## Rollback (if needed)

If a bad gateway appears after step 2:

1. Restore prior Nginx/OpenResty config backup
2. Reload Nginx/OpenResty
3. Recreate frontend dev process:

pm2 start npm --name maan-dashboard-fe --cwd /home/ubuntu/maan-dashboard -- run dev
pm2 save
