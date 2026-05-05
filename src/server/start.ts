import { join } from 'node:path';
import { createAppServer } from './appServer';
import { loadLocalEnvFile } from './env';

await loadLocalEnvFile(join(process.cwd(), '.env.local'));

const port = Number(process.env.AGENT_IM_API_PORT ?? 8791);
const dbPath = process.env.AGENT_IM_DB_PATH ?? join(process.cwd(), 'data', 'agent-im-db.json');

const server = await createAppServer({
  dbPath,
  port,
  autopilotWorker: {
    enabled: parseBooleanEnv(process.env.AGENT_IM_AUTOPILOT_WORKER, true),
    intervalMs: parseNumberEnv(process.env.AGENT_IM_AUTOPILOT_WORKER_INTERVAL_MS, 60_000),
    limit: parseNumberEnv(process.env.AGENT_IM_AUTOPILOT_WORKER_LIMIT, 20),
    roomIds: parseCsvEnv(process.env.AGENT_IM_AUTOPILOT_WORKER_ROOM_IDS),
    runOnStart: parseBooleanEnv(process.env.AGENT_IM_AUTOPILOT_WORKER_RUN_ON_START, true)
  }
});

console.log(`Agent IM API running at ${server.url}`);
console.log(`Persistent database: ${dbPath}`);

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.close();
  process.exit(0);
});

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCsvEnv(value: string | undefined): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
