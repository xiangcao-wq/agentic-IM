// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { DemoState } from '../domain/types';
import {
  PostgresStateStore,
  type PostgresQueryResult,
  type PostgresStateDatabase,
  type PostgresStateQueryRunner
} from './postgresStateStore';

describe('PostgresStateStore', () => {
  it('initializes an empty tenant with the demo state', async () => {
    const db = new MemoryPostgresStateDatabase();
    const store = new PostgresStateStore(db, { tenantId: 'demo' });

    await store.init();
    const state = await store.read();

    expect(state.rooms.some((room) => room.id === 'room-team')).toBe(true);
    expect(state.agents.some((agent) => agent.id === 'agent-lin')).toBe(true);
    expect(db.rowsFor('agentbridge_users')).toHaveLength(createDemoState().users.length);
  });

  it('preserves collection order when writing and reading state snapshots', async () => {
    const db = new MemoryPostgresStateDatabase();
    const store = new PostgresStateStore(db, { tenantId: 'demo' });
    const state = createDemoState();
    const messages: DemoState['messages'] = [
      {
        id: 'msg-b',
        type: 'text',
        roomId: 'room-team',
        senderId: 'user-lin',
        senderName: 'Lin Wen',
        body: 'second id should stay first',
        sentAt: '2026-05-04T00:00:00.000Z'
      },
      {
        id: 'msg-a',
        type: 'text',
        roomId: 'room-team',
        senderId: 'user-chen',
        senderName: 'Chen Chen',
        body: 'first id should stay second',
        sentAt: '2026-05-04T00:00:01.000Z'
      }
    ];

    await store.write({ ...state, messages });
    const reloaded = await store.read();

    expect(reloaded.messages.map((message) => message.id)).toEqual(['msg-b', 'msg-a']);
    expect(db.rowsFor('agentbridge_messages').map((row) => row.position)).toEqual([0, 1]);
  });

  it('runs updates inside a tenant-locked transaction', async () => {
    const db = new MemoryPostgresStateDatabase();
    const store = new PostgresStateStore(db, { tenantId: 'demo' });

    await store.write(createDemoState());
    await store.update((state) => ({
      ...state,
      messages: [
        ...state.messages,
        {
          id: 'msg-postgres-update',
          type: 'text',
          roomId: 'room-team',
          senderId: 'user-lin',
          senderName: 'Lin Wen',
          body: 'transactional update',
          sentAt: '2026-05-04T00:00:02.000Z'
        }
      ]
    }));

    const reloaded = await store.read();
    const lockIndex = db.statements.findIndex((statement) => statement.includes('pg_advisory_xact_lock'));
    const deleteIndex = db.statements.findIndex((statement) => statement.startsWith('DELETE FROM agentbridge_users'));

    expect(db.transactionsStarted).toBeGreaterThanOrEqual(2);
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(lockIndex);
    expect(reloaded.messages.some((message) => message.id === 'msg-postgres-update')).toBe(true);
  });

  it('reports unhealthy reads and writes without throwing from health checks', async () => {
    const db = new MemoryPostgresStateDatabase();
    db.failQueries = true;
    const store = new PostgresStateStore(db, { tenantId: 'demo' });

    await expect(store.health()).resolves.toEqual({ readable: false, writable: false });
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

class MemoryPostgresStateDatabase implements PostgresStateDatabase {
  readonly statements: string[] = [];
  transactionsStarted = 0;
  failQueries = false;
  private readonly rows = new Map<string, StoredRow[]>();

  rowsFor(tableName: string): StoredRow[] {
    return [...(this.rows.get(tableName) ?? [])];
  }

  async query<Row = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    if (this.failQueries) {
      throw new Error('database unavailable');
    }
    this.statements.push(normalizeSql(text));
    return this.handleQuery<Row>(text, params);
  }

  async transaction<T>(run: (client: PostgresStateQueryRunner) => Promise<T>): Promise<T> {
    this.transactionsStarted += 1;
    return run({
      query: (text, params) => this.query(text, params)
    });
  }

  private async handleQuery<Row>(text: string, params: readonly unknown[]): Promise<PostgresQueryResult<Row>> {
    const normalized = normalizeSql(text);

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

    if (normalized.startsWith('SELECT pg_advisory_xact_lock') || normalized.startsWith('SELECT 1')) {
      return { rows: [] };
    }

    if (normalized.startsWith('CREATE TEMP TABLE')) {
      return { rows: [] };
    }

    if (normalized.startsWith('INSERT INTO agentbridge_health_probe')) {
      return { rows: [] };
    }

    if (normalized.startsWith('DELETE FROM')) {
      const tableName = tableNameAfter(normalized, 'FROM');
      const tenantId = String(params[0]);
      this.rows.set(
        tableName,
        (this.rows.get(tableName) ?? []).filter((row) => row.tenant_id !== tenantId)
      );
      return { rows: [] };
    }

    if (normalized.startsWith('INSERT INTO')) {
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
