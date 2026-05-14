import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DemoState } from '../src/domain/types';
import { loadLocalEnvFile } from '../src/server/env';
import { createPgStateDatabaseFromEnv } from '../src/server/pgStateDatabase';
import { runPostgresCutover } from '../src/server/postgresCutover';
import {
  formatPostgresCutoverReport,
  postgresCutoverHelp,
  resolvePostgresCutoverCliConfig
} from '../src/server/postgresCutoverCli';
import type { PostgresMigrationFile } from '../src/server/postgresMigrationRunner';

await loadLocalEnvFile(join(process.cwd(), '.env.local'));

const config = resolvePostgresCutoverCliConfig(process.argv.slice(2), process.env, process.cwd());

if (config.help) {
  process.stdout.write(`${postgresCutoverHelp()}\n`);
  process.exit(0);
}

const [state, migrations] = await Promise.all([
  readFile(config.inputPath, 'utf8').then((raw) => JSON.parse(raw) as DemoState),
  readMigrationFiles(config.migrationsDir)
]);
const db = await createPgStateDatabaseFromEnv(process.env);

try {
  const report = await runPostgresCutover({
    db,
    state,
    migrations,
    tenantId: config.tenantId,
    apply: config.apply,
    replace: config.replace
  });

  process.stdout.write(config.json ? `${JSON.stringify(report, null, 2)}\n` : formatPostgresCutoverReport(report));

  if (!report.ok) {
    process.exitCode = 1;
  }
} finally {
  await db.close();
}

async function readMigrationFiles(migrationsDir: string): Promise<PostgresMigrationFile[]> {
  const fileNames = (await readdir(migrationsDir))
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    fileNames.map(async (fileName) => {
      const path = join(migrationsDir, fileName);
      return {
        path,
        fileName: basename(path),
        sql: await readFile(path, 'utf8')
      };
    })
  );
}
