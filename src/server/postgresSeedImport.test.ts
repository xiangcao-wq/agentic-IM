// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import {
  runPostgresSeedImport,
  type PostgresSeedImportReport
} from './postgresSeedImport';
import type {
  PostgresQueryResult,
  PostgresStateDatabase,
  PostgresStateQueryRunner
} from './postgresStateStore';

describe('Postgres seed import', () => {
  it('dry-runs JSON state imports without writing to Postgres', async () => {
    const db = new RecordingPostgresDatabase();
    const state = createDemoState();

    const report = await runPostgresSeedImport({
      db,
      state,
      tenantId: 'review-demo',
      apply: false
    });

    expect(report.ok).toBe(true);
    expect(report.apply).toBe(false);
    expect(report.tenantId).toBe('review-demo');
    expect(report.totalRows).toBeGreaterThan(state.messages.length);
    expect(report.collections.find((collection) => collection.collection === 'messages')?.rows).toBe(
      state.messages.length
    );
    expect(db.statements).toEqual([]);
    expect(db.transactionsStarted).toBe(0);
  });

  it('writes the validated JSON snapshot only when apply is set', async () => {
    const db = new RecordingPostgresDatabase();
    const state = createDemoState();
    state.messages = [
      {
        id: 'msg-seed-b',
        type: 'text',
        roomId: 'room-team',
        senderId: 'user-lin',
        senderName: 'Lin Wen',
        body: 'this message should stay first',
        sentAt: '2026-05-04T00:00:00.000Z'
      },
      {
        id: 'msg-seed-a',
        type: 'text',
        roomId: 'room-team',
        senderId: 'user-chen',
        senderName: 'Chen Chen',
        body: 'this message should stay second',
        sentAt: '2026-05-04T00:00:01.000Z'
      }
    ];

    const report = await runPostgresSeedImport({
      db,
      state,
      tenantId: 'review-demo',
      apply: true
    });

    expect(report.ok).toBe(true);
    expect(report.apply).toBe(true);
    expect(db.transactionsStarted).toBe(1);
    expect(db.statements.some((statement) => statement.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(db.statements.some((statement) => statement.startsWith('DELETE FROM agentbridge_users'))).toBe(true);
    expect(db.rowsFor('agentbridge_messages').map((row) => row.id)).toEqual(['msg-seed-b', 'msg-seed-a']);
    expect(db.rowsFor('agentbridge_messages').map((row) => row.position)).toEqual([0, 1]);
  });

  it('blocks apply when the target tenant already has data unless replace is explicit', async () => {
    const db = new RecordingPostgresDatabase();
    db.seedExistingRow('agentbridge_users', 'review-demo', 'user-existing');

    const report = await runPostgresSeedImport({
      db,
      state: createDemoState(),
      tenantId: 'review-demo',
      apply: true
    });

    expect(report).toMatchObject<Partial<PostgresSeedImportReport>>({
      ok: false,
      apply: true,
      tenantId: 'review-demo',
      existingRows: 1,
      error: 'Target tenant already has 1 Postgres state row. Re-run with --replace to overwrite it.'
    });
    expect(db.transactionsStarted).toBe(0);
    expect(db.statements.some((statement) => statement.startsWith('DELETE FROM'))).toBe(false);
  });

  it('allows explicit replace when the target tenant already has data', async () => {
    const db = new RecordingPostgresDatabase();
    db.seedExistingRow('agentbridge_users', 'review-demo', 'user-existing');

    const report = await runPostgresSeedImport({
      db,
      state: createDemoState(),
      tenantId: 'review-demo',
      apply: true,
      replace: true
    });

    expect(report.ok).toBe(true);
    expect(report.existingRows).toBe(1);
    expect(db.transactionsStarted).toBe(1);
    expect(db.rowsFor('agentbridge_users').some((row) => row.id === 'user-existing')).toBe(false);
  });

  it('reports a failed apply without pretending the seed succeeded', async () => {
    const db = new RecordingPostgresDatabase();
    db.failWrites = true;

    const report = await runPostgresSeedImport({
      db,
      state: createDemoState(),
      tenantId: 'review-demo',
      apply: true
    });

    expect(report).toMatchObject<Partial<PostgresSeedImportReport>>({
      ok: false,
      apply: true,
      tenantId: 'review-demo',
      error: 'database write failed'
    });
  });
});

interface StoredRow {
  tenant_id: string;
  id: string;
  data: Record<string, unknown>;
  position: number;
  created_at: string;
  updated_at: string;
}

class RecordingPostgresDatabase implements PostgresStateDatabase {
  readonly statements: string[] = [];
  transactionsStarted = 0;
  failWrites = false;
  private readonly rows = new Map<string, StoredRow[]>();

  rowsFor(tableName: string): StoredRow[] {
    return [...(this.rows.get(tableName) ?? [])];
  }

  seedExistingRow(tableName: string, tenantId: string, id: string): void {
    this.rows.set(tableName, [
      ...(this.rows.get(tableName) ?? []),
      {
        tenant_id: tenantId,
        id,
        data: { id },
        position: 0,
        created_at: '2026-05-04T00:00:00.000Z',
        updated_at: '2026-05-04T00:00:00.000Z'
      }
    ]);
  }

  async query<Row = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    return this.handleQuery<Row>(text, params);
  }

  async transaction<T>(run: (client: PostgresStateQueryRunner) => Promise<T>): Promise<T> {
    this.transactionsStarted += 1;
    return run({
      query: (text, params) => this.handleQuery(text, params)
    });
  }

  private async handleQuery<Row>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    const normalized = normalizeSql(text);
    this.statements.push(normalized);

    if (normalized.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rows: [] };
    }

    if (normalized.startsWith('SELECT COUNT(*)::int AS count FROM')) {
      const tableName = tableNameAfter(normalized, 'FROM');
      const tenantId = String(params[0]);
      const count = (this.rows.get(tableName) ?? []).filter((row) => row.tenant_id === tenantId).length;
      return { rows: [{ count } as Row] };
    }

    if (normalized.startsWith('DELETE FROM')) {
      if (this.failWrites) {
        throw new Error('database write failed');
      }
      const tableName = tableNameAfter(normalized, 'FROM');
      const tenantId = String(params[0]);
      this.rows.set(
        tableName,
        (this.rows.get(tableName) ?? []).filter((row) => row.tenant_id !== tenantId)
      );
      return { rows: [] };
    }

    if (normalized.startsWith('INSERT INTO')) {
      if (this.failWrites) {
        throw new Error('database write failed');
      }
      const tableName = normalized.split(' ')[2];
      const row: StoredRow = {
        tenant_id: String(params[0]),
        id: String(params[1]),
        data: params[2] as Record<string, unknown>,
        position: Number(params[3]),
        created_at: String(params[4]),
        updated_at: String(params[5])
      };
      this.rows.set(tableName, [...(this.rows.get(tableName) ?? []), row]);
      return { rows: [] };
    }

    throw new Error(`Unhandled SQL in test fake: ${normalized}`);
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
