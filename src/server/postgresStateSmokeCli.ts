import { resolve } from 'node:path';
import type { PostgresStateSmokeReport } from './postgresStateSmoke';

export interface PostgresStateSmokeCliConfig {
  dbPath: string;
  tenantId: string;
  json: boolean;
  help: boolean;
}

export function resolvePostgresStateSmokeCliConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): PostgresStateSmokeCliConfig {
  const config: PostgresStateSmokeCliConfig = {
    dbPath: resolve(cwd, env.AGENT_IM_DB_PATH ?? 'data/agent-im-db.json'),
    tenantId: env.AGENTBRIDGE_TENANT_ID?.trim() || 'default',
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--db' || arg === '--input') {
      config.dbPath = resolve(cwd, readArgValue(args, ++index, arg));
    } else if (arg === '--tenant') {
      config.tenantId = readArgValue(args, ++index, arg);
    } else if (arg === '--json') {
      config.json = true;
    } else if (arg === '--help' || arg === '-h') {
      config.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return config;
}

export function formatPostgresStateSmokeReport(report: PostgresStateSmokeReport): string {
  const failingTables = report.checks.tables.filter((table) => !table.ok);
  const lines = [
    `Postgres state smoke: ${report.ok ? 'PASS' : 'FAIL'}`,
    `Tenant: ${report.tenantId}`,
    `Migration ${report.checks.migration.version}: ${report.checks.migration.ok ? 'ready' : 'missing'}`,
    `Parity: ${report.checks.parity.ok ? 'ready' : 'mismatch'}`
  ];

  if (report.checks.parity.firstMessageId) {
    lines.push(`First message: ${report.checks.parity.firstMessageId}`);
  }

  if (failingTables.length > 0) {
    lines.push('Mismatched tables:');
    for (const table of failingTables) {
      lines.push(
        `- ${table.tableName}: ${table.actualRows ?? 'unknown'}/${table.expectedRows}${
          table.error ? ` (${table.error})` : ''
        }`
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export function postgresStateSmokeHelp(): string {
  return [
    'Usage: tsx scripts/postgres-state-smoke.ts [--db data/agent-im-db.json] [--tenant default] [--json]',
    '',
    'Requires AGENTBRIDGE_DATABASE_URL or DATABASE_URL.',
    'Runs a read-only Postgres/Supabase state parity smoke check before runtime cutover.'
  ].join('\n');
}

function readArgValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
