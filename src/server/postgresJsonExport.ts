import type { DemoState } from '../domain/types';
import { POSTGRES_STATE_TABLES } from './postgresStateSchema';
import { getStateCollections, type StateCollectionKey, validateDemoStateShape } from './stateSchema';
import type { StateStore } from './stateStore';

export interface PostgresJsonExportCollectionReport {
  collection: StateCollectionKey;
  tableName: string;
  rows: number;
}

export interface PostgresJsonExportOptions {
  store: Pick<StateStore, 'read'>;
  tenantId: string;
  generatedAt?: string;
}

export interface PostgresJsonExportReport {
  ok: boolean;
  tenantId: string;
  generatedAt: string;
  totalRows: number;
  collections: PostgresJsonExportCollectionReport[];
  state?: DemoState;
  error?: string;
}

export async function runPostgresJsonExport(options: PostgresJsonExportOptions): Promise<PostgresJsonExportReport> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  try {
    const state = validateDemoStateShape(await options.store.read());
    const collections = buildCollectionReport(state);
    return {
      ok: true,
      tenantId: options.tenantId,
      generatedAt,
      totalRows: collections.reduce((sum, collection) => sum + collection.rows, 0),
      collections,
      state
    };
  } catch (error) {
    return {
      ok: false,
      tenantId: options.tenantId,
      generatedAt,
      totalRows: 0,
      collections: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function formatExportedDemoStateJson(state: DemoState): string {
  return `${JSON.stringify(validateDemoStateShape(state), null, 2)}\n`;
}

function buildCollectionReport(state: DemoState): PostgresJsonExportCollectionReport[] {
  const collections = getStateCollections(state);
  return POSTGRES_STATE_TABLES.map((table) => ({
    collection: table.collection,
    tableName: table.tableName,
    rows: collections[table.collection].length
  }));
}
