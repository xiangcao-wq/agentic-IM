import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadLocalEnvFile } from '../src/server/env';
import { createPgStateDatabaseFromEnv } from '../src/server/pgStateDatabase';
import { formatExportedDemoStateJson, runPostgresJsonExport } from '../src/server/postgresJsonExport';
import {
  formatPostgresJsonExportReport,
  postgresJsonExportHelp,
  resolvePostgresJsonExportCliConfig,
  toPostgresJsonExportTransportReport
} from '../src/server/postgresJsonExportCli';
import { PostgresStateStore } from '../src/server/postgresStateStore';

await loadLocalEnvFile(join(process.cwd(), '.env.local'));

const config = resolvePostgresJsonExportCliConfig(process.argv.slice(2), process.env, process.cwd());

if (config.help) {
  process.stdout.write(`${postgresJsonExportHelp()}\n`);
  process.exit(0);
}

const db = await createPgStateDatabaseFromEnv(process.env);

try {
  const report = await runPostgresJsonExport({
    store: new PostgresStateStore(db, { tenantId: config.tenantId }),
    tenantId: config.tenantId
  });

  if (report.ok && report.state) {
    await mkdir(dirname(config.outPath), { recursive: true });
    await writeFile(config.outPath, formatExportedDemoStateJson(report.state), 'utf8');
  }

  process.stdout.write(
    config.json
      ? `${JSON.stringify(toPostgresJsonExportTransportReport(report, config.outPath), null, 2)}\n`
      : formatPostgresJsonExportReport(report, config.outPath)
  );

  if (!report.ok) {
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
