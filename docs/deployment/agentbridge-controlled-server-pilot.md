# AgentBridge Controlled Server Pilot Runbook

This runbook describes the smallest controlled server deployment that is worth operating.
It is intentionally conservative: one Node API process, one static web build, one HTTPS
reverse proxy, one JSON state file, and explicit readiness checks.

## Scope

This is a controlled single-user or private pilot deployment.

It is not a public multi-user SaaS deployment yet. `VITE_AGENT_API_TOKEN` is compiled into
the browser bundle, so anyone who can load the web app can inspect that token. For a public
product, add real user authentication before exposing the app broadly.

Recommended exposure:

- Private domain behind HTTPS.
- A long random `AGENT_IM_API_TOKEN`.
- Optional upstream access control such as VPN, private network, or reverse-proxy basic auth.
- One operator with shell access and rollback responsibility.

## Target Architecture

```text
Browser
  |
  | HTTPS https://agentbridge.example.com
  v
Nginx
  |-- serves / from /opt/agentbridge/current/dist
  |-- proxies /api/* to http://127.0.0.1:8791
  v
Node API managed by systemd
  |
  |-- JSON state: /var/lib/agentbridge/data/agent-im-db.json
  |-- media:      /var/lib/agentbridge/media
```

For the first pilot, keep Matrix disabled with `MATRIX_BOOTSTRAP_PATH=none`. Add Matrix
after the basic server deployment has survived a full readiness cycle.

## Server Prerequisites

Use one small Linux VM first. Do not start with Kubernetes.

- Ubuntu 22.04 or 24.04 LTS.
- Node.js matching the development major as closely as practical. Current local verification used:
  - Node `v24.15.0`
  - npm `11.12.1`
- Nginx.
- Git.
- TLS certificate for the deployment host.
- A non-root Linux user named `agentbridge`.

Suggested directories:

```bash
sudo mkdir -p /opt/agentbridge
sudo mkdir -p /opt/agentbridge/releases
sudo mkdir -p /var/lib/agentbridge/data
sudo mkdir -p /var/lib/agentbridge/media
sudo mkdir -p /etc/agentbridge
sudo chown -R agentbridge:agentbridge /opt/agentbridge /var/lib/agentbridge
```

## Environment Variables

Create `/etc/agentbridge/agentbridge.env` on the server. Do not commit this file.

```bash
NODE_ENV=production

AGENT_IM_PUBLIC_MODE=true
AGENT_IM_API_PORT=8791
AGENT_IM_API_TOKEN=<generate-a-long-random-token>
AGENT_IM_ALLOWED_ORIGINS=https://agentbridge.example.com

AGENT_IM_DB_PATH=/var/lib/agentbridge/data/agent-im-db.json
AGENT_IM_MEDIA_DIR=/var/lib/agentbridge/media
MATRIX_BOOTSTRAP_PATH=none

AGENT_IM_ALLOW_NO_AUTH=false
AGENT_IM_ALLOW_QUERY_TOKEN=false

AGENT_IM_AUTOPILOT_WORKER=true
AGENT_IM_AUTOPILOT_WORKER_INTERVAL_MS=60000
AGENT_IM_AUTOPILOT_WORKER_LIMIT=20
AGENT_IM_AUTOPILOT_WORKER_RUN_ON_START=true

DEEPSEEK_API_KEY=<required-for-product-ready-provider-check>
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_HUMAN_MODEL=deepseek-v4-flash
DEEPSEEK_AGENT_MODEL=deepseek-v4-pro
DEEPSEEK_AGENT_THINKING=enabled
DEEPSEEK_AGENT_REASONING_EFFORT=high
```

Generate the token on a trusted machine:

```bash
openssl rand -base64 32
```

Build-time browser variables must match the runtime server token:

```bash
export VITE_AGENT_API_TOKEN="$AGENT_IM_API_TOKEN"
```

If Nginx serves the web app and proxies `/api` on the same host, leave
`VITE_AGENT_API_BASE` unset. Set it only when the API is on a different origin.

Token rotation requires:

1. Update `AGENT_IM_API_TOKEN` in `/etc/agentbridge/agentbridge.env`.
2. Rebuild the web bundle with the new `VITE_AGENT_API_TOKEN`.
3. Restart the API service.
4. Re-run readiness and smoke checks.

## First Deployment

Run these as the `agentbridge` user unless a command uses `sudo`.

```bash
cd /opt/agentbridge/releases
git clone https://github.com/xiangcao-wq/agentic-IM.git initial
cd /opt/agentbridge/releases/initial
git switch main
git pull --ff-only origin main
RELEASE_SHA=$(git rev-parse HEAD)
cd /opt/agentbridge/releases
mv initial "$RELEASE_SHA"
ln -sfnT "/opt/agentbridge/releases/$RELEASE_SHA" /opt/agentbridge/current
cd /opt/agentbridge/current
npm ci
```

Seed the persistent demo state into `/var/lib/agentbridge`:

```bash
set -a
. /etc/agentbridge/agentbridge.env
set +a
npm run demo:prepare
```

Build the web app with the same token that the API will require:

```bash
set -a
. /etc/agentbridge/agentbridge.env
set +a
export VITE_AGENT_API_TOKEN="$AGENT_IM_API_TOKEN"
npm run build
```

## systemd Service

Create `/etc/systemd/system/agentbridge-api.service`:

```ini
[Unit]
Description=AgentBridge API
After=network.target

[Service]
Type=simple
User=agentbridge
Group=agentbridge
WorkingDirectory=/opt/agentbridge/current
EnvironmentFile=/etc/agentbridge/agentbridge.env
ExecStart=/usr/bin/npm run api
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable agentbridge-api
sudo systemctl start agentbridge-api
sudo systemctl status agentbridge-api --no-pager
```

Useful logs:

```bash
journalctl -u agentbridge-api -f
```

## Nginx Reverse Proxy

Create an HTTPS server block similar to this:

```nginx
server {
    listen 443 ssl http2;
    server_name agentbridge.example.com;

    root /opt/agentbridge/current/dist;
    index index.html;

    client_max_body_size 10m;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Frame-Options DENY always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location /api/ {
        proxy_pass http://127.0.0.1:8791/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}

server {
    listen 80;
    server_name agentbridge.example.com;
    return 301 https://$host$request_uri;
}
```

Then:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Readiness Checks

Set local shell variables for checks:

```bash
HOST=https://agentbridge.example.com
TOKEN=<same-token-as-AGENT_IM_API_TOKEN>
```

Auth boundary:

```bash
curl -i "$HOST/api/readiness"
curl -i "$HOST/api/readiness?agent_im_token=$TOKEN"
curl -fsS -H "x-agent-im-token: $TOKEN" "$HOST/api/readiness"
```

Expected:

- No-token readiness returns `401`.
- Query-token-only readiness returns `401`.
- Header-token readiness returns `200`.
- JSON contains `checks.auth.allowQueryToken: false`.
- JSON does not contain the token value.

Provider health may be `unknown` immediately after startup. Warm it explicitly:

```bash
curl -fsS -X POST -H "x-agent-im-token: $TOKEN" "$HOST/api/ai/status/check"
curl -fsS -H "x-agent-im-token: $TOKEN" "$HOST/api/readiness"
```

Run smoke checks against the deployed host:

```bash
set -a
. /etc/agentbridge/agentbridge.env
set +a
export AGENT_IM_API_BASE="$HOST"
export AGENT_IM_API_URL="$HOST"
export AGENT_IM_WEB_BASE="$HOST"
export AGENT_IM_WEB_URL="$HOST"
npm run infra:smoke
```

Full product readiness gate:

```bash
set -a
. /etc/agentbridge/agentbridge.env
set +a
export AGENT_IM_API_BASE="$HOST"
export AGENT_IM_API_URL="$HOST"
export AGENT_IM_WEB_BASE="$HOST"
export AGENT_IM_WEB_URL="$HOST"
export VITE_AGENT_API_TOKEN="$AGENT_IM_API_TOKEN"
npm run readiness:product
```

Do not use `--local-demo` for the final controlled server pilot signoff.

## Deployment Update Procedure

The current JSON state store means this pilot cannot safely run two write-capable API
instances against the same state file for a true blue-green cutover. For existing users,
use a controlled near-zero-downtime update: build and verify the new release in a separate
directory while the old version stays online, then take one short API restart window to
switch `current` and reload Nginx. True zero-downtime writes should wait for the
Postgres-backed storage slice.

Before updating, record the current production SHA:

```bash
cd /opt/agentbridge/current
PREVIOUS_SHA=$(git rev-parse HEAD)
echo "$PREVIOUS_SHA" | tee /opt/agentbridge/previous-known-good-sha.txt
git fetch origin
git status --short --branch
npm run test
set -a
. /etc/agentbridge/agentbridge.env
set +a
export VITE_AGENT_API_TOKEN="$AGENT_IM_API_TOKEN"
npm run build
```

Prepare the new release without touching the live `current` symlink:

```bash
cd /opt/agentbridge/releases
RELEASE_SHA=$(git ls-remote https://github.com/xiangcao-wq/agentic-IM.git refs/heads/main | awk '{print $1}')
if [ ! -d "/opt/agentbridge/releases/$RELEASE_SHA" ]; then
  git clone https://github.com/xiangcao-wq/agentic-IM.git "$RELEASE_SHA"
fi
cd "/opt/agentbridge/releases/$RELEASE_SHA"
git switch main
git reset --hard "$RELEASE_SHA"
npm ci
set -a
. /etc/agentbridge/agentbridge.env
set +a
export VITE_AGENT_API_TOKEN="$AGENT_IM_API_TOKEN"
npm run test
npm run build
```

Cut over with a short API restart and a consistent stopped-state backup:

```bash
sudo systemctl stop agentbridge-api
BACKUP_PATH="/var/lib/agentbridge/data/agent-im-db.$(date +%Y%m%d-%H%M%S).json"
cp /var/lib/agentbridge/data/agent-im-db.json "$BACKUP_PATH"
echo "$BACKUP_PATH" | tee /opt/agentbridge/latest-state-backup.txt
ln -sfnT "/opt/agentbridge/releases/$RELEASE_SHA" /opt/agentbridge/current
set -a
. /etc/agentbridge/agentbridge.env
set +a
export VITE_AGENT_API_TOKEN="$AGENT_IM_API_TOKEN"
cd /opt/agentbridge/current
sudo nginx -t
sudo systemctl start agentbridge-api
sudo systemctl reload nginx
```

Then run the readiness checks above.

## Rollback

Rollback the app code:

```bash
cd /opt/agentbridge/current
PREVIOUS_SHA=$(cat /opt/agentbridge/previous-known-good-sha.txt)
if [ -z "$PREVIOUS_SHA" ]; then
  echo "Missing previous known-good SHA" >&2
  exit 1
fi
if [ ! -d "/opt/agentbridge/releases/$PREVIOUS_SHA" ]; then
  git clone https://github.com/xiangcao-wq/agentic-IM.git "/opt/agentbridge/releases/$PREVIOUS_SHA"
  git -C "/opt/agentbridge/releases/$PREVIOUS_SHA" reset --hard "$PREVIOUS_SHA"
fi
sudo systemctl stop agentbridge-api
ln -sfnT "/opt/agentbridge/releases/$PREVIOUS_SHA" /opt/agentbridge/current
cd /opt/agentbridge/current
set -a
. /etc/agentbridge/agentbridge.env
set +a
export VITE_AGENT_API_TOKEN="$AGENT_IM_API_TOKEN"
npm ci
npm run build
sudo systemctl start agentbridge-api
sudo systemctl reload nginx
```

Rollback runtime data only if the new code corrupted state:

```bash
sudo systemctl stop agentbridge-api
cp /var/lib/agentbridge/data/agent-im-db.<backup-timestamp>.json \
  /var/lib/agentbridge/data/agent-im-db.json
sudo chown agentbridge:agentbridge /var/lib/agentbridge/data/agent-im-db.json
sudo systemctl start agentbridge-api
```

Re-run:

```bash
curl -fsS -H "x-agent-im-token: $TOKEN" "$HOST/api/readiness"
npm run infra:smoke
```

## Go / No-Go Checklist

Go only when all are true:

- `npm run test` passes on the release commit.
- `npm run build` passes with the production token exported as `VITE_AGENT_API_TOKEN`.
- `npm run readiness:product` passes without `--local-demo`.
- `npm run readiness:product` fails if no-token or query-token `/api/readiness` access is accepted.
- `curl "$HOST/api/readiness"` returns `401`.
- `curl "$HOST/api/readiness?agent_im_token=<token>"` returns `401`.
- Authenticated `/api/readiness` returns `200` and no token value.
- `checks.auth.mode` is `public` or `production`.
- `checks.auth.allowQueryToken` is `false`.
- `checks.storage.readable` and `checks.storage.writable` are both `true`.
- `checks.eventLog.readable`, `checks.eventLog.writable`, and `checks.eventLog.valid` are all `true`.
- HTTPS is enabled and HTTP redirects to HTTPS.
- Runtime state has a backup.
- Rollback commit SHA is recorded.

No-go conditions:

- `VITE_AGENT_API_TOKEN` does not match `AGENT_IM_API_TOKEN`.
- Readiness reports `local-demo`, `local-token`, `production-open`, provider `unknown`, or storage not writable.
- The site is reachable by untrusted users without another access boundary.
- Any token or API key appears in logs, screenshots, PRs, or docs.

## Known Limits Before Public Release

These are acceptable for a controlled pilot, but block public launch:

- Browser token is visible to anyone who can load the app.
- No per-user account model or role-based access control.
- JSON file persistence is not a multi-user production database.
- True zero-downtime write traffic requires database-backed storage; the controlled pilot uses a short API restart window.
- No rate limiting on public endpoints.
- No structured log redaction pipeline.
- No CI/CD deployment automation yet.
- Matrix is optional and not yet isolated as an independently operated connector.
