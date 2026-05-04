import { join } from 'node:path';
import { createAppServer } from './appServer';

const port = Number(process.env.AGENT_IM_API_PORT ?? 8791);
const dbPath = process.env.AGENT_IM_DB_PATH ?? join(process.cwd(), 'data', 'agent-im-db.json');

const server = await createAppServer({
  dbPath,
  port
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
