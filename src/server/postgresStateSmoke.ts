import type { DemoState } from '../domain/types';
import {
  getStateCollections,
  validateDemoStateShape,
  type StateCollectionKey
} from './stateSchema';
import { POSTGRES_STATE_TABLES } from './postgresStateSchema';
import { PostgresStateStore, type PostgresStateDatabase } from './postgresStateStore';

export const POSTGRES_STATE_MIGRATION_VERSION = '202605140001';

export interface PostgresStateSmokeOptions {
  db: PostgresStateDatabase;
  expectedState: DemoState;
  tenantId?: string;
  migrationVersion?: string;
}

export interface PostgresTableSmokeCheck {
  collection: StateCollectionKey;
  tableName: string;
  ok: boolean;
  expectedRows: number;
  actualRows?: number;
  error?: string;
}

export interface PostgresStateSmokeReport {
  ok: boolean;
  tenantId: string;
  checks: {
    migration: {
      ok: boolean;
      version: string;
      error?: string;
    };
    tables: PostgresTableSmokeCheck[];
    parity: {
      ok: boolean;
      expectedCollections: number;
      actualCollections: number;
      firstMessageId?: string;
      error?: string;
    };
  };
}

interface CountRow {
  count: number | string | bigint;
}

interface MigrationRow {
  version: string;
}

export async function runPostgresStateSmoke(options: PostgresStateSmokeOptions): Promise<PostgresStateSmokeReport> {
  const tenantId = options.tenantId ?? 'default';
  const migrationVersion = options.migrationVersion ?? POSTGRES_STATE_MIGRATION_VERSION;
  const expectedState = validateDemoStateShape(options.expectedState);
  const expectedCollections = getStateCollections(expectedState);

  const migration = await checkMigration(options.db, migrationVersion);
  const tables = await Promise.all(
    POSTGRES_STATE_TABLES.map(async (spec): Promise<PostgresTableSmokeCheck> => {
      const expectedRows = expectedCollections[spec.collection].length;
      try {
        const result = await options.db.query<CountRow>(
          `SELECT COUNT(*)::int AS count FROM ${spec.tableName} WHERE tenant_id = $1`,
          [tenantId]
        );
        const actualRows = normalizeCount(result.rows[0]?.count ?? 0);
        return {
          collection: spec.collection,
          tableName: spec.tableName,
          ok: actualRows === expectedRows,
          expectedRows,
          actualRows
        };
      } catch (error) {
        return {
          collection: spec.collection,
          tableName: spec.tableName,
          ok: false,
          expectedRows,
          error: errorMessage(error)
        };
      }
    })
  );
  const parity = await checkParity(options.db, tenantId, expectedCollections);

  return {
    ok: migration.ok && tables.every((table) => table.ok) && parity.ok,
    tenantId,
    checks: {
      migration,
      tables,
      parity
    }
  };
}

async function checkMigration(
  db: PostgresStateDatabase,
  migrationVersion: string
): Promise<PostgresStateSmokeReport['checks']['migration']> {
  try {
    const result = await db.query<MigrationRow>(
      'SELECT version FROM agentbridge_schema_migrations WHERE version = $1',
      [migrationVersion]
    );
    return {
      ok: result.rows.some((row) => row.version === migrationVersion),
      version: migrationVersion,
      ...(result.rows.length === 0 ? { error: 'migration version not found' } : {})
    };
  } catch (error) {
    return {
      ok: false,
      version: migrationVersion,
      error: errorMessage(error)
    };
  }
}

async function checkParity(
  db: PostgresStateDatabase,
  tenantId: string,
  expectedCollections: ReturnType<typeof getStateCollections>
): Promise<PostgresStateSmokeReport['checks']['parity']> {
  try {
    const actualState = await new PostgresStateStore(db, { tenantId }).read();
    const actualCollections = getStateCollections(actualState);
    const collectionsMatch = POSTGRES_STATE_TABLES.every(
      (spec) => actualCollections[spec.collection].length === expectedCollections[spec.collection].length
    );
    const expectedFirstMessageId = expectedCollections.messages[0]?.id;
    const actualFirstMessageId = actualCollections.messages[0]?.id;

    return {
      ok: collectionsMatch && actualFirstMessageId === expectedFirstMessageId,
      expectedCollections: POSTGRES_STATE_TABLES.length,
      actualCollections: POSTGRES_STATE_TABLES.length,
      firstMessageId: actualFirstMessageId
    };
  } catch (error) {
    return {
      ok: false,
      expectedCollections: POSTGRES_STATE_TABLES.length,
      actualCollections: 0,
      error: errorMessage(error)
    };
  }
}

function normalizeCount(value: number | string | bigint): number {
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
