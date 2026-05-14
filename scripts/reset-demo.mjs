import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDemoState } from '../src/domain/demoState.ts';

const dbPath = process.env.AGENT_IM_DB_PATH ?? join(process.cwd(), 'data', 'agent-im-db.json');

await writeFile(dbPath, `${JSON.stringify(createDemoState(), null, 2)}\n`, 'utf8');

console.log(`Reset AgentBridge demo database: ${dbPath}`);
console.log('Matrix room history is not pulled into /api/state until you run the explicit sync action.');
