// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATE_COLLECTION_KEYS } from './stateSchema';
import {
  POSTGRES_STATE_TABLES,
  generatePostgresStateMigration
} from './postgresStateSchema';

describe('Postgres state schema', () => {
  it('maps every DemoState collection to a stable Postgres table', () => {
    expect(POSTGRES_STATE_TABLES.map((table) => table.collection)).toEqual(STATE_COLLECTION_KEYS);

    for (const table of POSTGRES_STATE_TABLES) {
      expect(table.tableName).toMatch(/^agentbridge_[a-z0-9_]+$/);
      expect(table.primaryJsonField).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
    }
  });

  it('generates a migration with JSONB state rows and query indexes', () => {
    const sql = generatePostgresStateMigration();

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS agentbridge_schema_migrations');
    expect(sql).toContain('data JSONB NOT NULL');
    expect(sql).toContain('position INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('jsonb_path_ops');
    expect(sql).toContain('agentbridge_messages_room_sent_at_idx');
    expect(sql).toContain('agentbridge_action_requests_status_idx');

    for (const table of POSTGRES_STATE_TABLES) {
      expect(sql).toContain(table.tableName);
    }
  });

  it('keeps the committed Supabase migration in sync with the schema generator', async () => {
    const migration = await readFile(
      resolve('supabase/migrations/202605140001_agentbridge_core_state.sql'),
      'utf8'
    );

    expect(normalizeSql(migration)).toBe(normalizeSql(generatePostgresStateMigration()));
  });
});

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
