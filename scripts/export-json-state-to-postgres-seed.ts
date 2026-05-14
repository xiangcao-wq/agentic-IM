import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DemoState } from '../src/domain/types';
import {
  POSTGRES_STATE_TABLES,
  getPostgresTableSpec,
  type PostgresStateTableSpec
} from '../src/server/postgresStateSchema';
import {
  getStateCollections,
  validateDemoStateShape,
  type StateCollectionKey
} from '../src/server/stateSchema';

export interface PostgresSeedOptions {
  generatedAt?: string;
  tenantId?: string;
}

export function buildPostgresSeedSql(input: DemoState, options: PostgresSeedOptions = {}): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const tenantId = options.tenantId ?? 'default';
  const state = validateDemoStateShape(input);
  const collections = getStateCollections(state);
  const statements: string[] = [
    '-- AgentBridge JSON state seed for Postgres/Supabase.',
    `-- Generated at ${generatedAt}. Re-running this script is idempotent for the same tenant_id/id pairs.`,
    'BEGIN;'
  ];

  for (const collection of Object.keys(collections) as StateCollectionKey[]) {
    const spec = getPostgresTableSpec(collection);
    const records = collections[collection] as unknown as Array<Record<string, unknown>>;
    for (const [position, record] of records.entries()) {
      statements.push(buildInsertStatement(spec, record, tenantId, generatedAt, position));
    }
  }

  statements.push('COMMIT;', '');
  return statements.join('\n');
}

function buildInsertStatement(
  spec: PostgresStateTableSpec,
  record: Record<string, unknown>,
  tenantId: string,
  fallbackTimestamp: string,
  position: number
): string {
  const id = readRequiredString(record, spec.primaryJsonField, spec.collection);
  const createdAt = readOptionalString(record, spec.createdAtJsonField) ?? fallbackTimestamp;
  const updatedAt = readOptionalString(record, spec.updatedAtJsonField) ?? createdAt;
  const json = JSON.stringify(record);

  return [
    `INSERT INTO ${spec.tableName} (tenant_id, id, data, position, created_at, updated_at)`,
    `VALUES (${sqlLiteral(tenantId)}, ${sqlLiteral(id)}, ${sqlLiteral(json)}::jsonb, ${position}, ${sqlLiteral(createdAt)}::timestamptz, ${sqlLiteral(updatedAt)}::timestamptz)`,
    'ON CONFLICT (tenant_id, id) DO UPDATE',
    'SET data = EXCLUDED.data, position = EXCLUDED.position, updated_at = EXCLUDED.updated_at;'
  ].join('\n');
}

function readRequiredString(record: Record<string, unknown>, field: string, collection: StateCollectionKey): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Cannot export ${collection}: missing string field ${field}`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, field: string | undefined): string | undefined {
  if (!field) {
    return undefined;
  }
  const value = record[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args.input ?? process.env.AGENT_IM_DB_PATH ?? join(process.cwd(), 'data', 'agent-im-db.json');
  const tenantId = args.tenant ?? process.env.AGENTBRIDGE_TENANT_ID ?? 'default';
  const raw = await readFile(inputPath, 'utf8');
  const sql = buildPostgresSeedSql(JSON.parse(raw) as DemoState, { tenantId });

  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, sql, 'utf8');
    process.stdout.write(`Wrote ${args.out} for ${POSTGRES_STATE_TABLES.length} AgentBridge tables.\n`);
    return;
  }

  process.stdout.write(sql);
}

function parseArgs(args: string[]): { input?: string; out?: string; tenant?: string } {
  const parsed: { input?: string; out?: string; tenant?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--input') {
      parsed.input = resolve(args[++index]);
    } else if (arg === '--out') {
      parsed.out = resolve(args[++index]);
    } else if (arg === '--tenant') {
      parsed.tenant = args[++index];
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        [
          'Usage: tsx scripts/export-json-state-to-postgres-seed.ts [--input data/agent-im-db.json] [--out tmp/seed.sql] [--tenant default]',
          '',
          'Exports the current AgentBridge JSON DemoState into idempotent SQL INSERT statements.'
        ].join('\n')
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
