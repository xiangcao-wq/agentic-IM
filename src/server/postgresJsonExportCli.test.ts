// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  formatPostgresJsonExportReport,
  postgresJsonExportHelp,
  resolvePostgresJsonExportCliConfig
} from './postgresJsonExportCli';

describe('Postgres JSON export CLI helpers', () => {
  it('defaults to a rollback-safe tmp output path', () => {
    const config = resolvePostgresJsonExportCliConfig(
      [],
      {
        AGENTBRIDGE_TENANT_ID: 'review-demo'
      },
      'C:/repo'
    );

    expect(config).toEqual({
      outPath: 'C:\\repo\\tmp\\agentbridge-postgres-export.json',
      tenantId: 'review-demo',
      json: false,
      help: false
    });
  });

  it('parses tenant, output, and json flags', () => {
    const config = resolvePostgresJsonExportCliConfig(
      ['--tenant', 'judge-demo', '--out', 'backups/postgres.json', '--json'],
      {},
      'C:/repo'
    );

    expect(config.tenantId).toBe('judge-demo');
    expect(config.outPath).toBe('C:\\repo\\backups\\postgres.json');
    expect(config.json).toBe(true);
  });

  it('formats a report that names the rollback output file', () => {
    const text = formatPostgresJsonExportReport(
      {
        ok: true,
        tenantId: 'review-demo',
        generatedAt: '2026-05-14T00:00:00.000Z',
        totalRows: 2,
        collections: [{ collection: 'users', tableName: 'agentbridge_users', rows: 2 }]
      },
      'tmp/agentbridge-postgres-export.json'
    );

    expect(text).toContain('Postgres JSON export: PASS');
    expect(text).toContain('tmp/agentbridge-postgres-export.json');
  });

  it('documents that the command is read-only against Postgres', () => {
    expect(postgresJsonExportHelp()).toContain('read-only');
  });
});
