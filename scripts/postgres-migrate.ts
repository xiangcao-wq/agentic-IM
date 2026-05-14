import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { loadLocalEnvFile } from '../src/server/env';
import { createPgStateDatabaseFromEnv } from '../src/server/pgStateDatabase';
import {
  formatPostgresMigrationRunReport,
  postgresMigrationHelp,
  resolvePostgresMigrationCliConfig
} from '../src/server/postgresMigrationCli';
import { runPostgresMigrations, type PostgresMigrationFile } from '../src/server/postgresMigrationRunner';

await loadLocalEnvFile(join(process.cwd(), '.env.local'));

const config = resolvePostgresMigrationCliConfig(process.argv.slice(2), process.cwd());

if (config.help) {
  process.stdout.write(`${postgresMigrationHelp()}\n`);
  process.exit(0);
}

const migrations = await readMigrationFiles(config.migrationsDir);
const db = await createPgStateDatabaseFromEnv(process.env);

try {
  const report = await runPostgresMigrations({
    db,
    migrations,
    apply: config.apply
  });

  process.stdout.write(config.json ? `${JSON.stringify(report, null, 2)}\n` : formatPostgresMigrationRunReport(report));

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
