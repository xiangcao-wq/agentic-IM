import { resolve } from 'node:path';
import type { PostgresCutoverReport } from './postgresCutover';

export interface PostgresCutoverCliConfig {
  apply: boolean;
  json: boolean;
  help: boolean;
  inputPath: string;
  migrationsDir: string;
  replace: boolean;
  tenantId: string;
}

export function resolvePostgresCutoverCliConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): PostgresCutoverCliConfig {
  const config: PostgresCutoverCliConfig = {
    apply: false,
    json: false,
    help: false,
    inputPath: resolve(cwd, env.AGENT_IM_DB_PATH ?? 'data/agent-im-db.json'),
    migrationsDir: resolve(cwd, 'supabase/migrations'),
    replace: false,
    tenantId: env.AGENTBRIDGE_TENANT_ID?.trim() || 'default'
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      config.apply = true;
    } else if (arg === '--replace') {
      config.replace = true;
    } else if (arg === '--json') {
      config.json = true;
    } else if (arg === '--db' || arg === '--input') {
      config.inputPath = resolve(cwd, readArgValue(args, ++index, arg));
    } else if (arg === '--migrations') {
      config.migrationsDir = resolve(cwd, readArgValue(args, ++index, arg));
    } else if (arg === '--tenant') {
      config.tenantId = readArgValue(args, ++index, arg);
    } else if (arg === '--help' || arg === '-h') {
      config.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return config;
}

export function formatPostgresCutoverReport(report: PostgresCutoverReport): string {
  const status = report.ok ? (report.apply ? 'PASS' : 'DRY-RUN') : 'FAIL';
  const lines = [
    `Postgres cutover: ${status}`,
    `Tenant: ${report.tenantId}`,
    `Runtime switch: ${report.runtimeSwitch}`
  ];

  for (const step of report.steps) {
    lines.push(`- ${step.name}: ${step.status} (${step.summary})`);
  }

  lines.push('No runtime environment was changed by this command.');
  lines.push('Set AGENT_IM_STATE_STORE=postgres only after this command returns PASS in --apply mode.');

  return `${lines.join('\n')}\n`;
}

export function postgresCutoverHelp(): string {
  return [
    'Usage: tsx scripts/postgres-cutover.ts [--apply] [--replace] [--input data/agent-im-db.json] [--migrations supabase/migrations] [--tenant default] [--json]',
    '',
    'Runs the safe Postgres cutover gate: migrate -> seed -> smoke.',
    'Requires AGENTBRIDGE_DATABASE_URL or DATABASE_URL because migration dry-run checks the target database.',
    'Default mode is a dry-run. Add --apply to execute migrations, import the seed, and run the smoke check.',
    'By default, apply mode refuses to overwrite an existing tenant. Add --replace only when you intentionally want to overwrite that tenant snapshot.',
    'This command never changes AGENT_IM_STATE_STORE or any runtime environment file.'
  ].join('\n');
}

function readArgValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
