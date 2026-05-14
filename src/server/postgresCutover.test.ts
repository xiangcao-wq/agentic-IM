// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import { runPostgresCutover } from './postgresCutover';
import type { PostgresMigrationRunOptions, PostgresMigrationRunReport } from './postgresMigrationRunner';
import type { PostgresSeedImportOptions, PostgresSeedImportReport } from './postgresSeedImport';
import type { PostgresStateSmokeOptions, PostgresStateSmokeReport } from './postgresStateSmoke';
import type { PostgresStateDatabase } from './postgresStateStore';

describe('Postgres cutover gate', () => {
  it('dry-runs migration and seed steps without running the smoke check', async () => {
    const calls: string[] = [];

    const report = await runPostgresCutover({
      db: fakeDb,
      state: createDemoState(),
      tenantId: 'review-demo',
      apply: false,
      migrations: [migrationFile()],
      runMigrations: async (options) => {
        calls.push(`migration:${options.apply}`);
        return migrationReport({ apply: options.apply, pendingCount: 1 });
      },
      runSeed: async (options) => {
        calls.push(`seed:${options.apply}`);
        return seedReport({ apply: options.apply });
      },
      runSmoke: async () => {
        calls.push('smoke');
        return smokeReport({ ok: true });
      }
    });

    expect(report.ok).toBe(true);
    expect(report.apply).toBe(false);
    expect(report.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      'migration:passed',
      'seed:passed',
      'smoke:skipped'
    ]);
    expect(calls).toEqual(['migration:false', 'seed:false']);
  });

  it('applies migration, seeds state, then runs the smoke check in order', async () => {
    const calls: string[] = [];

    const report = await runPostgresCutover({
      db: fakeDb,
      state: createDemoState(),
      tenantId: 'review-demo',
      apply: true,
      replace: true,
      migrations: [migrationFile()],
      runMigrations: async (options) => {
        calls.push(`migration:${options.apply}`);
        return migrationReport({ apply: options.apply, appliedCount: 1 });
      },
      runSeed: async (options) => {
        calls.push(`seed:${options.apply}:${options.replace}`);
        return seedReport({ apply: options.apply });
      },
      runSmoke: async (options) => {
        calls.push(`smoke:${options.tenantId}`);
        return smokeReport({ ok: true });
      }
    });

    expect(report.ok).toBe(true);
    expect(report.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      'migration:passed',
      'seed:passed',
      'smoke:passed'
    ]);
    expect(calls).toEqual(['migration:true', 'seed:true:true', 'smoke:review-demo']);
  });

  it('stops before seed and smoke when migration apply fails', async () => {
    const calls: string[] = [];

    const report = await runPostgresCutover({
      db: fakeDb,
      state: createDemoState(),
      tenantId: 'review-demo',
      apply: true,
      migrations: [migrationFile()],
      runMigrations: async (options) => {
        calls.push(`migration:${options.apply}`);
        return migrationReport({ apply: options.apply, ok: false });
      },
      runSeed: async () => {
        calls.push('seed');
        return seedReport({ apply: true });
      },
      runSmoke: async () => {
        calls.push('smoke');
        return smokeReport({ ok: true });
      }
    });

    expect(report.ok).toBe(false);
    expect(report.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      'migration:failed',
      'seed:skipped',
      'smoke:skipped'
    ]);
    expect(calls).toEqual(['migration:true']);
  });
});

const fakeDb = {} as PostgresStateDatabase;

function migrationFile() {
  return {
    path: 'supabase/migrations/202605140001_agentbridge_core_state.sql',
    fileName: '202605140001_agentbridge_core_state.sql',
    sql: 'SELECT 1;'
  };
}

function migrationReport(overrides: Partial<PostgresMigrationRunReport>): PostgresMigrationRunReport {
  return {
    ok: true,
    apply: false,
    appliedCount: 0,
    pendingCount: 0,
    migrations: [],
    ...overrides
  };
}

function seedReport(overrides: Partial<PostgresSeedImportReport>): PostgresSeedImportReport {
  return {
    ok: true,
    apply: false,
    tenantId: 'review-demo',
    totalRows: 66,
    collections: [],
    ...overrides,
    existingRows: overrides.existingRows ?? 0
  };
}

function smokeReport(overrides: Partial<PostgresStateSmokeReport>): PostgresStateSmokeReport {
  return {
    ok: true,
    tenantId: 'review-demo',
    checks: {
      migration: { ok: true, version: '202605140001' },
      tables: [],
      parity: { ok: true, expectedCollections: 17, actualCollections: 17 }
    },
    ...overrides
  };
}
