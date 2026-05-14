import { resolve } from 'node:path';
import type { PostgresMigrationRunReport } from './postgresMigrationRunner';

export interface PostgresMigrationCliConfig {
  apply: boolean;
  json: boolean;
  help: boolean;
  migrationsDir: string;
}

export function resolvePostgresMigrationCliConfig(args: string[], cwd = process.cwd()): PostgresMigrationCliConfig {
  const config: PostgresMigrationCliConfig = {
    apply: false,
    json: false,
    help: false,
    migrationsDir: resolve(cwd, 'supabase/migrations')
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      config.apply = true;
    } else if (arg === '--json') {
      config.json = true;
    } else if (arg === '--migrations') {
      config.migrationsDir = resolve(cwd, readArgValue(args, ++index, arg));
    } else if (arg === '--help' || arg === '-h') {
      config.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return config;
}

export function formatPostgresMigrationRunReport(report: PostgresMigrationRunReport): string {
  const status = report.ok ? (report.apply ? 'PASS' : 'DRY-RUN') : 'FAIL';
  const lines = [
    `Postgres migrations: ${status}`,
    `Applied now: ${report.appliedCount}`,
    `Pending: ${report.pendingCount}`
  ];

  if (!report.apply) {
    lines.push('No database changes were applied. Re-run with --apply to execute pending migrations.');
  }

  for (const migration of report.migrations) {
    lines.push(
      `- ${migration.version} ${migration.status} ${migration.description}${
        migration.error ? ` (${migration.error})` : ''
      }`
    );
  }

  return `${lines.join('\n')}\n`;
}

export function postgresMigrationHelp(): string {
  return [
    'Usage: tsx scripts/postgres-migrate.ts [--apply] [--migrations supabase/migrations] [--json]',
    '',
    'Requires AGENTBRIDGE_DATABASE_URL or DATABASE_URL.',
    'Default mode is a dry-run. Add --apply to execute pending migrations.'
  ].join('\n');
}

function readArgValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
