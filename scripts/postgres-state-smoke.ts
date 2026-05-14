import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DemoState } from '../src/domain/types';
import { loadLocalEnvFile } from '../src/server/env';
import { createPgStateDatabaseFromEnv } from '../src/server/pgStateDatabase';
import { runPostgresStateSmoke } from '../src/server/postgresStateSmoke';
import {
  formatPostgresStateSmokeReport,
  postgresStateSmokeHelp,
  resolvePostgresStateSmokeCliConfig
} from '../src/server/postgresStateSmokeCli';

await loadLocalEnvFile(join(process.cwd(), '.env.local'));

const config = resolvePostgresStateSmokeCliConfig(process.argv.slice(2), process.env);

if (config.help) {
  process.stdout.write(`${postgresStateSmokeHelp()}\n`);
  process.exit(0);
}

const expectedState = JSON.parse(await readFile(config.dbPath, 'utf8')) as DemoState;
const db = await createPgStateDatabaseFromEnv(process.env);

try {
  const report = await runPostgresStateSmoke({
    db,
    expectedState,
    tenantId: config.tenantId
  });

  process.stdout.write(config.json ? `${JSON.stringify(report, null, 2)}\n` : formatPostgresStateSmokeReport(report));

  if (!report.ok) {
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
