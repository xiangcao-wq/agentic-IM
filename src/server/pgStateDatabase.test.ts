// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PgStateDatabase,
  resolvePostgresPoolConfig,
  type PgPoolClientLike,
  type PgPoolLike
} from './pgStateDatabase';

describe('PgStateDatabase', () => {
  it('delegates plain queries to the pool', async () => {
    const pool = new FakePgPool();
    const db = new PgStateDatabase(pool);

    await db.query('SELECT $1::text AS value', ['ok']);

    expect(pool.queries).toEqual([{ text: 'SELECT $1::text AS value', params: ['ok'] }]);
  });

  it('commits successful transactions and releases the client', async () => {
    const pool = new FakePgPool();
    const db = new PgStateDatabase(pool);

    const result = await db.transaction(async (client) => {
      await client.query('SELECT 1');
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(pool.client.queries.map((query) => query.text)).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(pool.client.released).toBe(true);
  });

  it('rolls back failed transactions and releases the client', async () => {
    const pool = new FakePgPool();
    const db = new PgStateDatabase(pool);

    await expect(
      db.transaction(async (client) => {
        await client.query('SELECT 1');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(pool.client.queries.map((query) => query.text)).toEqual(['BEGIN', 'SELECT 1', 'ROLLBACK']);
    expect(pool.client.released).toBe(true);
  });
});

describe('resolvePostgresPoolConfig', () => {
  it('requires an explicit Postgres connection string', () => {
    expect(() => resolvePostgresPoolConfig({})).toThrow('AGENTBRIDGE_DATABASE_URL or DATABASE_URL');
  });

  it('builds a Supabase-compatible SSL config without exposing secrets', () => {
    const config = resolvePostgresPoolConfig({
      AGENTBRIDGE_DATABASE_URL: 'postgres://user:secret@example.supabase.co:5432/postgres',
      AGENTBRIDGE_DATABASE_SSL: 'true',
      AGENTBRIDGE_DATABASE_SSL_REJECT_UNAUTHORIZED: 'false'
    });

    expect(config).toEqual({
      connectionString: 'postgres://user:secret@example.supabase.co:5432/postgres',
      ssl: { rejectUnauthorized: false }
    });
  });
});

interface QueryCall {
  text: string;
  params: readonly unknown[];
}

class FakePgPool implements PgPoolLike {
  readonly queries: QueryCall[] = [];
  readonly client = new FakePgClient();

  async query(text: string, params: readonly unknown[] = []) {
    this.queries.push({ text, params });
    return { rows: [] };
  }

  async connect(): Promise<PgPoolClientLike> {
    return this.client;
  }
}

class FakePgClient implements PgPoolClientLike {
  readonly queries: QueryCall[] = [];
  released = false;

  async query(text: string, params: readonly unknown[] = []) {
    this.queries.push({ text, params });
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}
