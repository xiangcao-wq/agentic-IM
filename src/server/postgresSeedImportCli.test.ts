// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  formatPostgresSeedImportReport,
  postgresSeedImportHelp,
  resolvePostgresSeedImportCliConfig
} from './postgresSeedImportCli';

describe('Postgres seed import CLI config', () => {
  it('defaults to a dry-run against the configured JSON state path', () => {
    const config = resolvePostgresSeedImportCliConfig(
      [],
      {
        AGENT_IM_DB_PATH: 'runtime/state.json',
        AGENTBRIDGE_TENANT_ID: 'review-demo'
      },
      'C:/repo'
    );

    expect(config).toEqual({
      inputPath: 'C:\\repo\\runtime\\state.json',
      tenantId: 'review-demo',
      apply: false,
      replace: false,
      json: false,
      help: false
    });
  });

  it('parses apply, input, tenant, and json flags', () => {
    const config = resolvePostgresSeedImportCliConfig(
      ['--apply', '--replace', '--input', 'data/demo.json', '--tenant', 'judge-demo', '--json'],
      {},
      'C:/repo'
    );

    expect(config.apply).toBe(true);
    expect(config.replace).toBe(true);
    expect(config.inputPath).toBe('C:\\repo\\data\\demo.json');
    expect(config.tenantId).toBe('judge-demo');
    expect(config.json).toBe(true);
  });

  it('formats dry-run and apply reports with explicit safety language', () => {
    expect(
      formatPostgresSeedImportReport({
        ok: true,
        apply: false,
        tenantId: 'review-demo',
        totalRows: 3,
        existingRows: 0,
        collections: [
          { collection: 'users', tableName: 'agentbridge_users', rows: 1 },
          { collection: 'messages', tableName: 'agentbridge_messages', rows: 2 }
        ]
      })
    ).toContain('No database changes were applied');

    expect(
      formatPostgresSeedImportReport({
        ok: true,
        apply: true,
        tenantId: 'review-demo',
        totalRows: 3,
        existingRows: 0,
        collections: []
      })
    ).toContain('Postgres state seed: PASS');
  });

  it('documents dry-run as the default mode', () => {
    expect(postgresSeedImportHelp()).toContain('Default mode is a dry-run');
    expect(postgresSeedImportHelp()).toContain('--replace');
  });
});
