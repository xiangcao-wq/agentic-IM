// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { PostgresQueryResult, PostgresStateDatabase, PostgresStateQueryRunner } from './postgresStateStore';
import {
  parsePostgresMigrationFileName,
  runPostgresMigrations,
  type PostgresMigrationFile
} from './postgresMigrationRunner';

describe('parsePostgresMigrationFileName', () => {
  it('extracts version and description from migration filenames', () => {
    expect(parsePostgresMigrationFileName('202605140001_agentbridge_core_state.sql')).toEqual({
      version: '202605140001',
      description: 'agentbridge core state'
    });
  });

  it('rejects filenames that do not sort by numeric migration version', () => {
    expect(() => parsePostgresMigrationFileName('agentbridge_core_state.sql')).toThrow('Invalid migration filename');
  });
});

describe('runPostgresMigrations', () => {
  const migration: PostgresMigrationFile = {
    path: 'supabase/migrations/202605140001_agentbridge_core_state.sql',
    fileName: '202605140001_agentbridge_core_state.sql',
    sql: '-- migration body\nCREATE TABLE IF NOT EXISTS agentbridge_schema_migrations (version TEXT PRIMARY KEY);'
  };

  it('dry-runs pending migrations without mutating the database', async () => {
    const db = new FakeMigrationDatabase({ appliedVersions: [] });

    const report = await runPostgresMigrations({
      db,
      migrations: [migration],
      apply: false
    });

    expect(report).toMatchObject({
      ok: true,
      apply: false,
      appliedCount: 0,
      pendingCount: 1
    });
    expect(report.migrations[0]).toMatchObject({
      version: '202605140001',
      status: 'pending'
    });
    expect(db.writeStatements).toEqual([]);
  });

  it('applies pending migrations in version order when explicitly requested', async () => {
    const db = new FakeMigrationDatabase({ appliedVersions: [] });
    const laterMigration: PostgresMigrationFile = {
      path: 'supabase/migrations/202605140002_later.sql',
      fileName: '202605140002_later.sql',
      sql: 'CREATE TABLE IF NOT EXISTS later_table (id TEXT);'
    };

    const report = await runPostgresMigrations({
      db,
      migrations: [laterMigration, migration],
      apply: true
    });

    expect(report.ok).toBe(true);
    expect(report.appliedCount).toBe(2);
    expect(report.migrations.map((item) => item.version)).toEqual(['202605140001', '202605140002']);
    expect(db.writeStatements).toEqual([
      migration.sql,
      "INSERT INTO agentbridge_schema_migrations (version, description) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
      laterMigration.sql,
      "INSERT INTO agentbridge_schema_migrations (version, description) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING"
    ]);
  });

  it('skips migrations already recorded in schema_migrations', async () => {
    const db = new FakeMigrationDatabase({ appliedVersions: ['202605140001'] });

    const report = await runPostgresMigrations({
      db,
      migrations: [migration],
      apply: true
    });

    expect(report).toMatchObject({
      ok: true,
      appliedCount: 0,
      pendingCount: 0
    });
    expect(report.migrations[0]).toMatchObject({
      version: '202605140001',
      status: 'applied'
    });
    expect(db.writeStatements).toEqual([]);
  });
});

class FakeMigrationDatabase implements PostgresStateDatabase {
  readonly writeStatements: string[] = [];
  private readonly appliedVersions: Set<string>;

  constructor(options: { appliedVersions: string[] }) {
    this.appliedVersions = new Set(options.appliedVersions);
  }

  async query<Row = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    if (text === "SELECT to_regclass('public.agentbridge_schema_migrations') AS table_name") {
      return {
        rows: [{ table_name: this.appliedVersions.size > 0 ? 'agentbridge_schema_migrations' : null } as Row]
      };
    }

    if (text === 'SELECT version FROM agentbridge_schema_migrations WHERE version = $1') {
      const version = String(params[0]);
      return {
        rows: this.appliedVersions.has(version) ? [{ version } as Row] : []
      };
    }

    if (text.startsWith('INSERT INTO agentbridge_schema_migrations')) {
      this.writeStatements.push(text);
      this.appliedVersions.add(String(params[0]));
      return { rows: [] };
    }

    this.writeStatements.push(text);
    return { rows: [] };
  }

  async transaction<T>(run: (client: PostgresStateQueryRunner) => Promise<T>): Promise<T> {
    return run(this);
  }
}
