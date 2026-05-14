// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { DemoState } from '../domain/types';
import { POSTGRES_STATE_TABLES } from './postgresStateSchema';
import type { PostgresQueryResult, PostgresStateDatabase, PostgresStateQueryRunner } from './postgresStateStore';
import { runPostgresStateSmoke } from './postgresStateSmoke';

describe('runPostgresStateSmoke', () => {
  it('passes when migration metadata and table rows match the expected JSON state', async () => {
    const expectedState = createDemoState();
    const db = FakeSmokeDatabase.fromState(expectedState, { migrationApplied: true });

    const report = await runPostgresStateSmoke({
      db,
      expectedState,
      tenantId: 'review-demo'
    });

    expect(report.ok).toBe(true);
    expect(report.tenantId).toBe('review-demo');
    expect(report.checks.migration).toMatchObject({
      ok: true,
      version: '202605140001'
    });
    expect(report.checks.tables.every((table) => table.ok)).toBe(true);
    expect(report.checks.parity).toMatchObject({
      ok: true,
      expectedCollections: POSTGRES_STATE_TABLES.length,
      actualCollections: POSTGRES_STATE_TABLES.length
    });
    expect(report.checks.parity.firstMessageId).toBe(expectedState.messages[0].id);
  });

  it('fails without mutating the database when the migration was not applied', async () => {
    const expectedState = createDemoState();
    const db = FakeSmokeDatabase.fromState(expectedState, { migrationApplied: false });

    const report = await runPostgresStateSmoke({
      db,
      expectedState,
      tenantId: 'review-demo'
    });

    expect(report.ok).toBe(false);
    expect(report.checks.migration).toMatchObject({
      ok: false,
      version: '202605140001'
    });
    expect(db.writeStatements).toEqual([]);
  });

  it('reports collection count mismatches before runtime cutover', async () => {
    const expectedState = createDemoState();
    const dbState: DemoState = {
      ...expectedState,
      messages: expectedState.messages.slice(1)
    };
    const db = FakeSmokeDatabase.fromState(dbState, { migrationApplied: true });

    const report = await runPostgresStateSmoke({
      db,
      expectedState,
      tenantId: 'review-demo'
    });

    const messages = report.checks.tables.find((table) => table.collection === 'messages');

    expect(report.ok).toBe(false);
    expect(messages).toMatchObject({
      ok: false,
      expectedRows: expectedState.messages.length,
      actualRows: expectedState.messages.length - 1
    });
    expect(report.checks.parity.ok).toBe(false);
  });
});

interface StoredRow {
  tenant_id: string;
  id: string;
  data: Record<string, unknown>;
  position: number;
}

class FakeSmokeDatabase implements PostgresStateDatabase {
  readonly writeStatements: string[] = [];
  private readonly rows = new Map<string, StoredRow[]>();

  private constructor(private readonly migrationApplied: boolean) {}

  static fromState(state: DemoState, options: { migrationApplied: boolean }): FakeSmokeDatabase {
    const db = new FakeSmokeDatabase(options.migrationApplied);
    for (const spec of POSTGRES_STATE_TABLES) {
      const records = state[spec.collection] as unknown as Array<Record<string, unknown>>;
      db.rows.set(
        spec.tableName,
        records.map((record, position) => ({
          tenant_id: 'review-demo',
          id: String(record[spec.primaryJsonField]),
          data: record,
          position
        }))
      );
    }
    return db;
  }

  async query<Row = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    const normalized = normalizeSql(text);

    if (isWriteStatement(normalized)) {
      this.writeStatements.push(normalized);
    }

    if (normalized.startsWith('SELECT version FROM agentbridge_schema_migrations')) {
      return {
        rows: this.migrationApplied ? [{ version: params[0] } as Row] : []
      };
    }

    if (normalized.startsWith('SELECT COUNT(*)::int AS count FROM')) {
      const tableName = tableNameAfter(normalized, 'FROM');
      const tenantId = String(params[0]);
      const count = (this.rows.get(tableName) ?? []).filter((row) => row.tenant_id === tenantId).length;
      return { rows: [{ count } as Row] };
    }

    if (normalized.startsWith('SELECT data FROM')) {
      const tableName = tableNameAfter(normalized, 'FROM');
      const tenantId = String(params[0]);
      return {
        rows: (this.rows.get(tableName) ?? [])
          .filter((row) => row.tenant_id === tenantId)
          .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
          .map((row) => ({ data: row.data }) as Row)
      };
    }

    throw new Error(`Unhandled SQL in fake smoke database: ${normalized}`);
  }

  async transaction<T>(run: (client: PostgresStateQueryRunner) => Promise<T>): Promise<T> {
    return run(this);
  }
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function tableNameAfter(statement: string, marker: 'FROM'): string {
  const parts = statement.split(`${marker} `);
  if (parts.length < 2) {
    throw new Error(`Cannot parse table name from SQL: ${statement}`);
  }
  return parts[1].split(' ')[0];
}

function isWriteStatement(statement: string): boolean {
  return /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/.test(statement);
}
