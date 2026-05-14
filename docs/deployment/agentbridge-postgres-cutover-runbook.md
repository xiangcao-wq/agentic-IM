# AgentBridge Postgres Cutover and Rollback Runbook

This runbook is for the current single-VM deployment where AgentBridge is already running
from `/var/www/agent-im` with the `agentbridge-api` systemd service.

The goal is conservative: keep the existing JSON deployment recoverable, migrate a tenant
into Postgres, verify parity, then switch the runtime only after the database path passes.

## Scope

Use this when all of these are true:

- The current site is already running from `/var/www/agent-im`.
- The API service name is `agentbridge-api`.
- The current state file is `/var/www/agent-im/data/agent-im-db.json`.
- You have a Postgres or Supabase connection string.
- You are prepared to roll back to JSON mode if readiness or smoke checks fail.

This does not create a public multi-user SaaS deployment. It only replaces the state store
for the current controlled server pilot.

## Safety Rules

- Run every dry-run command first.
- Do not add `--replace` unless you intentionally want to overwrite an existing tenant.
- Do not set `AGENT_IM_STATE_STORE=postgres` until cutover returns `PASS`.
- Before switching runtime, back up both `.env.local` and `data/agent-im-db.json`.
- After switching runtime, export a JSON rollback copy from Postgres before any risky
  deploy or rollback operation.

## Variables

Set these in the SSH session:

```bash
APP_DIR=/var/www/agent-im
HOST=http://43.134.161.43
TENANT=review-demo
BACKUP_TS=$(date +%Y%m%d-%H%M%S)
```

If you use a domain later, replace `HOST` with the HTTPS origin.

## 1. Preflight the Current Server

```bash
cd "$APP_DIR"

git status --short --branch
git rev-parse --short HEAD
sudo systemctl status agentbridge-api --no-pager
sudo nginx -t
curl -I "$HOST"
curl -s "$HOST/api/readiness"
```

If readiness is already degraded for a reason unrelated to auth/local demo mode, stop and
fix that before changing storage.

## 2. Create a Stopped-State Backup

Stop writes briefly and copy the current state.

```bash
cd "$APP_DIR"

sudo systemctl stop agentbridge-api
sleep 2

mkdir -p /var/www/backups
cp "$APP_DIR/.env.local" "/var/www/backups/agentbridge-env-$BACKUP_TS.local"
cp "$APP_DIR/data/agent-im-db.json" "/var/www/backups/agentbridge-json-state-$BACKUP_TS.json"
tar -czf "/var/www/backups/agentbridge-release-$BACKUP_TS.tgz" -C /var/www agent-im
echo "$BACKUP_TS" | tee /var/www/backups/latest-postgres-cutover-backup-ts.txt

sudo systemctl start agentbridge-api
sleep 3
sudo systemctl status agentbridge-api --no-pager
```

Rollback to this JSON backup is possible as long as this file exists:

```bash
/var/www/backups/agentbridge-json-state-$BACKUP_TS.json
```

## 3. Configure Postgres Connection

Edit `/var/www/agent-im/.env.local` and add the database connection, but do not switch the
runtime store yet.

```bash
cd "$APP_DIR"
nano .env.local
```

Required values:

```bash
AGENTBRIDGE_DATABASE_URL=postgres://...
AGENTBRIDGE_TENANT_ID=review-demo
AGENTBRIDGE_DATABASE_SSL=true
AGENTBRIDGE_DATABASE_SSL_REJECT_UNAUTHORIZED=false
```

Keep JSON runtime for now:

```bash
AGENT_IM_STATE_STORE=json
```

For hosted Supabase/Postgres, SSL is usually required. Keep the URL private; do not paste
it into screenshots, PRs, or chat logs.

## 4. Run the Cutover Dry-Run

This checks the target database migration state and validates the JSON seed without
writing the JSON snapshot.

```bash
cd "$APP_DIR"
npm run db:cutover:postgres -- --input data/agent-im-db.json --tenant "$TENANT"
```

Expected:

- The command can connect to Postgres.
- Migration status is visible.
- Seed row counts are visible.
- Smoke is skipped because dry-run mode does not write data.
- Runtime switch remains unchanged.

If this fails, leave the API in JSON mode and fix the connection or migration issue first.

## 5. Apply Migration and Seed

Run apply only after the dry-run is understood.

```bash
cd "$APP_DIR"
npm run db:cutover:postgres -- --apply --input data/agent-im-db.json --tenant "$TENANT"
```

If the target tenant already has rows, this command refuses to overwrite them. Only use
`--replace` when you intentionally want to replace the target tenant snapshot:

```bash
npm run db:cutover:postgres -- --apply --replace --input data/agent-im-db.json --tenant "$TENANT"
```

Expected:

- Migration step passes.
- Seed step passes.
- Smoke step passes.
- Report says `Postgres cutover: PASS`.

Do not switch runtime if this command does not return `PASS`.

## 6. Switch Runtime to Postgres

Edit `.env.local`:

```bash
cd "$APP_DIR"
nano .env.local
```

Set:

```bash
AGENT_IM_STATE_STORE=postgres
AGENTBRIDGE_TENANT_ID=review-demo
```

Restart API:

```bash
sudo systemctl restart agentbridge-api
sleep 3
sudo systemctl status agentbridge-api --no-pager
```

Check readiness and provider health:

```bash
curl -s "$HOST/api/readiness"
curl -s -X POST "$HOST/api/ai/status/check"
curl -s "$HOST/api/readiness"
```

If auth is enabled on the server, add the header:

```bash
TOKEN=<AGENT_IM_API_TOKEN>
curl -s -H "x-agent-im-token: $TOKEN" "$HOST/api/readiness"
curl -s -X POST -H "x-agent-im-token: $TOKEN" "$HOST/api/ai/status/check"
```

## 7. Export a JSON Rollback Copy from Postgres

After Postgres mode is running, export the tenant back to JSON. This preserves any data
created after cutover and gives you a safe JSON rollback file.

```bash
cd "$APP_DIR"
npm run db:export:json -- --tenant "$TENANT" --out "/var/www/backups/agentbridge-postgres-export-$BACKUP_TS.json"
ls -lh "/var/www/backups/agentbridge-postgres-export-$BACKUP_TS.json"
```

This command is read-only against Postgres.

## 8. Post-Cutover Smoke

Run the normal server checks:

```bash
cd "$APP_DIR"
curl -I "$HOST"
curl -s "$HOST/api/state" | head -c 500
echo
curl -s "$HOST/api/readiness"
```

If product auth is enabled:

```bash
TOKEN=<AGENT_IM_API_TOKEN>
curl -s -H "x-agent-im-token: $TOKEN" "$HOST/api/state" | head -c 500
echo
curl -s -H "x-agent-im-token: $TOKEN" "$HOST/api/readiness"
```

Also run a simple manual product check in the browser:

- Open the site.
- Send one message in the main group.
- Ask the Agent a simple question.
- Confirm that A2A or pending action data still appears.
- Restart the API once and confirm the message still exists.

Restart persistence check:

```bash
sudo systemctl restart agentbridge-api
sleep 3
curl -s "$HOST/api/state" | head -c 500
echo
```

## 9. Roll Back to JSON Mode

Use this if Postgres runtime is unhealthy but the app code is otherwise fine.

First, export the latest Postgres tenant if possible:

```bash
cd "$APP_DIR"
ROLLBACK_EXPORT="/var/www/backups/agentbridge-postgres-rollback-$(date +%Y%m%d-%H%M%S).json"
npm run db:export:json -- --tenant "$TENANT" --out "$ROLLBACK_EXPORT"
```

If export succeeds, switch `.env.local` back to JSON and point the JSON state at the
exported file:

```bash
sudo systemctl stop agentbridge-api
cp "$ROLLBACK_EXPORT" "$APP_DIR/data/agent-im-db.json"
chmod 600 "$APP_DIR/data/agent-im-db.json"
```

Edit `.env.local`:

```bash
AGENT_IM_STATE_STORE=json
AGENT_IM_DB_PATH=data/agent-im-db.json
```

Restart:

```bash
sudo systemctl start agentbridge-api
sleep 3
sudo systemctl status agentbridge-api --no-pager
curl -s "$HOST/api/readiness"
```

If Postgres export fails, restore the stopped-state JSON backup from step 2:

```bash
BACKUP_TS=$(cat /var/www/backups/latest-postgres-cutover-backup-ts.txt)
sudo systemctl stop agentbridge-api
cp "/var/www/backups/agentbridge-json-state-$BACKUP_TS.json" "$APP_DIR/data/agent-im-db.json"
chmod 600 "$APP_DIR/data/agent-im-db.json"
sudo systemctl start agentbridge-api
```

## 10. Roll Back Code and Data Together

Use this if the new code release is also bad.

```bash
BACKUP_TS=$(cat /var/www/backups/latest-postgres-cutover-backup-ts.txt)
cd /var/www
sudo systemctl stop agentbridge-api
mv agent-im "agent-im-bad-$BACKUP_TS"
tar -xzf "/var/www/backups/agentbridge-release-$BACKUP_TS.tgz" -C /var/www
cp "/var/www/backups/agentbridge-json-state-$BACKUP_TS.json" /var/www/agent-im/data/agent-im-db.json
sudo systemctl start agentbridge-api
sudo systemctl status agentbridge-api --no-pager
```

Then check:

```bash
curl -I "$HOST"
curl -s "$HOST/api/readiness"
```

## Go / No-Go Checklist

Go only when all are true:

- Stopped-state JSON backup exists.
- `.env.local` backup exists.
- `npm run db:cutover:postgres` dry-run succeeds.
- `npm run db:cutover:postgres -- --apply ...` returns `PASS`.
- `AGENT_IM_STATE_STORE=postgres` is set only after cutover passes.
- API restarts cleanly under systemd.
- `/api/readiness` reports storage readable and writable.
- AI provider health is connected or intentionally accepted for demo mode.
- A JSON rollback export from Postgres exists.
- Browser smoke confirms messages persist across API restart.

No-go:

- Cutover apply fails or returns `FAIL`.
- Smoke parity fails.
- Existing tenant rows are present and you did not intend to use `--replace`.
- You cannot produce either a stopped-state JSON backup or a Postgres JSON export.
- Readiness storage is not writable after restart.
- You are unsure which tenant is being used.
