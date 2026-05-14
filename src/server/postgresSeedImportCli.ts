import { resolve } from 'node:path';
import type { PostgresSeedImportReport } from './postgresSeedImport';

export interface PostgresSeedImportCliConfig {
  inputPath: string;
  tenantId: string;
  apply: boolean;
  replace: boolean;
  json: boolean;
  help: boolean;
}

export function resolvePostgresSeedImportCliConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): PostgresSeedImportCliConfig {
  const config: PostgresSeedImportCliConfig = {
    inputPath: resolve(cwd, env.AGENT_IM_DB_PATH ?? 'data/agent-im-db.json'),
    tenantId: env.AGENTBRIDGE_TENANT_ID?.trim() || 'default',
    apply: false,
    replace: false,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      config.apply = true;
    } else if (arg === '--replace') {
      config.replace = true;
    } else if (arg === '--db' || arg === '--input') {
      config.inputPath = resolve(cwd, readArgValue(args, ++index, arg));
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

export function formatPostgresSeedImportReport(report: PostgresSeedImportReport): string {
  const status = report.ok ? (report.apply ? 'PASS' : 'DRY-RUN') : 'FAIL';
  const lines = [
    `Postgres state seed: ${status}`,
    `Tenant: ${report.tenantId}`,
    `Rows: ${report.totalRows}`,
    `Existing target rows: ${report.existingRows}`
  ];

  if (report.error) {
    lines.push(`Error: ${report.error}`);
  }

  if (!report.apply) {
    lines.push('No database changes were applied. Re-run with --apply to import the JSON snapshot.');
  }

  for (const collection of report.collections) {
    lines.push(`- ${collection.tableName}: ${collection.rows} rows from ${collection.collection}`);
  }

  return `${lines.join('\n')}\n`;
}

export function postgresSeedImportHelp(): string {
  return [
    'Usage: tsx scripts/postgres-seed.ts [--apply] [--replace] [--input data/agent-im-db.json] [--tenant default] [--json]',
    '',
    'Default mode is a dry-run and only validates/counts the JSON snapshot.',
    'Add --apply to import the snapshot into Postgres. Apply mode requires AGENTBRIDGE_DATABASE_URL or DATABASE_URL.',
    'By default, apply mode refuses to overwrite an existing tenant. Add --replace only when you intentionally want to overwrite that tenant snapshot.'
  ].join('\n');
}

function readArgValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
