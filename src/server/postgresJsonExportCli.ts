import { resolve } from 'node:path';
import type { PostgresJsonExportReport } from './postgresJsonExport';

export interface PostgresJsonExportCliConfig {
  outPath: string;
  tenantId: string;
  json: boolean;
  help: boolean;
}

export interface PostgresJsonExportTransportReport extends Omit<PostgresJsonExportReport, 'state'> {
  outPath: string;
}

export function resolvePostgresJsonExportCliConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): PostgresJsonExportCliConfig {
  const config: PostgresJsonExportCliConfig = {
    outPath: resolve(cwd, 'tmp/agentbridge-postgres-export.json'),
    tenantId: env.AGENTBRIDGE_TENANT_ID?.trim() || 'default',
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--out') {
      config.outPath = resolve(cwd, readArgValue(args, ++index, arg));
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

export function toPostgresJsonExportTransportReport(
  report: PostgresJsonExportReport,
  outPath: string
): PostgresJsonExportTransportReport {
  const { state: _state, ...rest } = report;
  return { ...rest, outPath };
}

export function formatPostgresJsonExportReport(report: PostgresJsonExportReport, outPath: string): string {
  const lines = [
    `Postgres JSON export: ${report.ok ? 'PASS' : 'FAIL'}`,
    `Tenant: ${report.tenantId}`,
    `Rows: ${report.totalRows}`,
    `Output: ${outPath}`
  ];

  if (report.error) {
    lines.push(`Error: ${report.error}`);
  }

  for (const collection of report.collections) {
    lines.push(`- ${collection.tableName}: ${collection.rows} rows from ${collection.collection}`);
  }

  return `${lines.join('\n')}\n`;
}

export function postgresJsonExportHelp(): string {
  return [
    'Usage: tsx scripts/postgres-export-json.ts [--out tmp/agentbridge-postgres-export.json] [--tenant default] [--json]',
    '',
    'Exports a tenant from Postgres back to a JsonStateStore-compatible file for rollback.',
    'This command is read-only against Postgres and never changes AGENT_IM_STATE_STORE.'
  ].join('\n');
}

function readArgValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
