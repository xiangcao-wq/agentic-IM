import type { DemoState } from '../domain/types';
import { getStateCollections, type StateCollectionKey, validateDemoStateShape } from './stateSchema';
import { POSTGRES_STATE_TABLES } from './postgresStateSchema';
import { PostgresStateStore, type PostgresStateDatabase } from './postgresStateStore';

export interface PostgresSeedImportCollectionReport {
  collection: StateCollectionKey;
  tableName: string;
  rows: number;
}

export interface PostgresSeedImportOptions {
  db?: PostgresStateDatabase;
  state: DemoState;
  tenantId: string;
  apply: boolean;
  replace?: boolean;
}

export interface PostgresSeedImportReport {
  ok: boolean;
  apply: boolean;
  tenantId: string;
  totalRows: number;
  existingRows: number;
  collections: PostgresSeedImportCollectionReport[];
  error?: string;
}

interface CountRow {
  count: number | string | bigint;
}

export async function runPostgresSeedImport(options: PostgresSeedImportOptions): Promise<PostgresSeedImportReport> {
  const state = validateDemoStateShape(options.state);
  const collections = buildCollectionReport(state);
  const baseReport = {
    apply: options.apply,
    tenantId: options.tenantId,
    totalRows: collections.reduce((sum, collection) => sum + collection.rows, 0),
    existingRows: 0,
    collections
  };

  if (!options.apply) {
    return {
      ok: true,
      ...baseReport
    };
  }

  if (!options.db) {
    return {
      ok: false,
      ...baseReport,
      error: 'Postgres seed apply requires a database connection.'
    };
  }

  try {
    const existingRows = await countExistingTenantRows(options.db, options.tenantId);
    if (existingRows > 0 && !options.replace) {
      return {
        ok: false,
        ...baseReport,
        existingRows,
        error: `Target tenant already has ${existingRows} Postgres state ${existingRows === 1 ? 'row' : 'rows'}. Re-run with --replace to overwrite ${existingRows === 1 ? 'it' : 'them'}.`
      };
    }

    await new PostgresStateStore(options.db, { tenantId: options.tenantId }).write(state);
    return {
      ok: true,
      ...baseReport,
      existingRows
    };
  } catch (error) {
    return {
      ok: false,
      ...baseReport,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function buildCollectionReport(state: DemoState): PostgresSeedImportCollectionReport[] {
  const collections = getStateCollections(state);
  return POSTGRES_STATE_TABLES.map((table) => ({
    collection: table.collection,
    tableName: table.tableName,
    rows: collections[table.collection].length
  }));
}

async function countExistingTenantRows(db: PostgresStateDatabase, tenantId: string): Promise<number> {
  let total = 0;
  for (const table of POSTGRES_STATE_TABLES) {
    const result = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM ${table.tableName} WHERE tenant_id = $1`,
      [tenantId]
    );
    total += normalizeCount(result.rows[0]?.count ?? 0);
  }
  return total;
}

function normalizeCount(value: number | string | bigint): number {
  return typeof value === 'bigint' ? Number(value) : Number(value);
}
