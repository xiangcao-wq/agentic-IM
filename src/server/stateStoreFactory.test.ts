// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PostgresStateStore, type PostgresStateDatabase } from './postgresStateStore';
import { createConfiguredStateStore } from './stateStoreFactory';

describe('createConfiguredStateStore', () => {
  it('keeps JSON as the default runtime store', () => {
    const config = createConfiguredStateStore({
      dbPath: 'data/agent-im-db.json',
      env: {}
    });

    expect(config.mode).toBe('json');
    expect(config.stateStore).toBeUndefined();
    expect(config.agentEventLogMode).toBeUndefined();
    expect(config.description).toContain('data/agent-im-db.json');
  });

  it('requires a database URL before enabling Postgres runtime storage', () => {
    expect(() =>
      createConfiguredStateStore({
        dbPath: 'data/agent-im-db.json',
        env: { AGENT_IM_STATE_STORE: 'postgres' }
      })
    ).toThrow('AGENTBRIDGE_DATABASE_URL or DATABASE_URL');
  });

  it('creates a tenant-scoped Postgres StateStore when explicitly enabled', () => {
    const fakeDb = createFakePostgresDatabase();
    const config = createConfiguredStateStore({
      dbPath: 'data/agent-im-db.json',
      env: {
        AGENT_IM_STATE_STORE: 'postgres',
        AGENTBRIDGE_DATABASE_URL: 'postgres://user:secret@example.supabase.co:5432/postgres',
        AGENTBRIDGE_TENANT_ID: 'review-demo'
      },
      createPostgresDatabase: () => fakeDb
    });

    expect(config.mode).toBe('postgres');
    expect(config.stateStore).toBeInstanceOf(PostgresStateStore);
    expect(config.agentEventLogMode).toBe('jsonl-local');
    expect(config.description).toBe('postgres tenant review-demo');
  });

  it('rejects unknown store modes instead of silently falling back', () => {
    expect(() =>
      createConfiguredStateStore({
        dbPath: 'data/agent-im-db.json',
        env: { AGENT_IM_STATE_STORE: 'sqlite' }
      })
    ).toThrow('Unsupported AGENT_IM_STATE_STORE');
  });
});

function createFakePostgresDatabase(): PostgresStateDatabase {
  return {
    async query() {
      return { rows: [] };
    },
    async transaction(run) {
      return run({
        async query() {
          return { rows: [] };
        }
      });
    }
  };
}
