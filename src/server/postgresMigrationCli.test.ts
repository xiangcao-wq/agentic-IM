// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  formatPostgresMigrationRunReport,
  resolvePostgresMigrationCliConfig
} from './postgresMigrationCli';
import type { PostgresMigrationRunReport } from './postgresMigrationRunner';

describe('postgres migration CLI helpers', () => {
  it('defaults to dry-run mode and the repository migration directory', () => {
    const config = resolvePostgresMigrationCliConfig([], '/repo');

    expect(config).toEqual({
      apply: false,
      json: false,
      help: false,
      migrationsDir: resolve('/repo', 'supabase/migrations')
    });
  });

  it('accepts explicit apply, json and migrations directory flags', () => {
    const config = resolvePostgresMigrationCliConfig([
      '--apply',
      '--json',
      '--migrations',
      'db/migrations'
    ], '/repo');

    expect(config).toEqual({
      apply: true,
      json: true,
      help: false,
      migrationsDir: resolve('/repo', 'db/migrations')
    });
  });

  it('formats dry-run reports with an explicit no-write label', () => {
    const report: PostgresMigrationRunReport = {
      ok: true,
      apply: false,
      appliedCount: 0,
      pendingCount: 1,
      migrations: [
        {
          version: '202605140001',
          description: 'agentbridge core state',
          path: 'supabase/migrations/202605140001_agentbridge_core_state.sql',
          status: 'pending'
        }
      ]
    };

    const formatted = formatPostgresMigrationRunReport(report);

    expect(formatted).toContain('Postgres migrations: DRY-RUN');
    expect(formatted).toContain('202605140001 pending');
    expect(formatted).toContain('No database changes were applied');
  });

  it('formats failed migration reports with the failed version', () => {
    const report: PostgresMigrationRunReport = {
      ok: false,
      apply: true,
      appliedCount: 0,
      pendingCount: 0,
      migrations: [
        {
          version: '202605140001',
          description: 'agentbridge core state',
          path: 'supabase/migrations/202605140001_agentbridge_core_state.sql',
          status: 'failed',
          error: 'permission denied'
        }
      ]
    };

    const formatted = formatPostgresMigrationRunReport(report);

    expect(formatted).toContain('Postgres migrations: FAIL');
    expect(formatted).toContain('202605140001 failed');
    expect(formatted).toContain('permission denied');
  });
});
