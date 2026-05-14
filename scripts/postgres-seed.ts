import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DemoState } from '../src/domain/types';
import { loadLocalEnvFile } from '../src/server/env';
import { createPgStateDatabaseFromEnv } from '../src/server/pgStateDatabase';
import { runPostgresSeedImport } from '../src/server/postgresSeedImport';
import {
  formatPostgresSeedImportReport,
  postgresSeedImportHelp,
  resolvePostgresSeedImportCliConfig
} from '../src/server/postgresSeedImportCli';

await loadLocalEnvFile(join(process.cwd(), '.env.local'));

const config = resolvePostgresSeedImportCliConfig(process.argv.slice(2), process.env, process.cwd());

if (config.help) {
  process.stdout.write(`${postgresSeedImportHelp()}\n`);
  process.exit(0);
}

const state = JSON.parse(await readFile(config.inputPath, 'utf8')) as DemoState;
const db = config.apply ? await createPgStateDatabaseFromEnv(process.env) : undefined;

try {
  const report = await runPostgresSeedImport({
    db,
    state,
    tenantId: config.tenantId,
    apply: config.apply,
    replace: config.replace
  });

  process.stdout.write(config.json ? `${JSON.stringify(report, null, 2)}\n` : formatPostgresSeedImportReport(report));

  if (!report.ok) {
    process.exitCode = 1;
  }
} finally {
  await db?.close();
}
