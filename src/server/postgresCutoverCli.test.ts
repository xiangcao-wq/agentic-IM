// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  formatPostgresCutoverReport,
  postgresCutoverHelp,
  resolvePostgresCutoverCliConfig
} from './postgresCutoverCli';

describe('Postgres cutover CLI helpers', () => {
  it('defaults to a dry-run with repo-local migration and state paths', () => {
    const config = resolvePostgresCutoverCliConfig(
      [],
      {
        AGENT_IM_DB_PATH: 'runtime/state.json',
        AGENTBRIDGE_TENANT_ID: 'review-demo'
      },
      'C:/repo'
    );

    expect(config).toEqual({
      apply: false,
      json: false,
      help: false,
      inputPath: 'C:\\repo\\runtime\\state.json',
      migrationsDir: 'C:\\repo\\supabase\\migrations',
      replace: false,
      tenantId: 'review-demo'
    });
  });

  it('parses apply, input, migrations, tenant and json flags', () => {
    const config = resolvePostgresCutoverCliConfig(
      [
        '--apply',
        '--replace',
        '--input',
        'data/demo.json',
        '--migrations',
        'db/migrations',
        '--tenant',
        'judge-demo',
        '--json'
      ],
      {},
      'C:/repo'
    );

    expect(config.apply).toBe(true);
    expect(config.replace).toBe(true);
    expect(config.inputPath).toBe('C:\\repo\\data\\demo.json');
    expect(config.migrationsDir).toBe('C:\\repo\\db\\migrations');
    expect(config.tenantId).toBe('judge-demo');
    expect(config.json).toBe(true);
  });

  it('formats dry-run reports without implying runtime has switched', () => {
    const output = formatPostgresCutoverReport({
      ok: true,
      apply: false,
      tenantId: 'review-demo',
      runtimeSwitch: 'unchanged',
      steps: [
        { name: 'migration', status: 'passed', summary: '1 pending migration' },
        { name: 'seed', status: 'passed', summary: '66 rows validated' },
        { name: 'smoke', status: 'skipped', summary: 'dry-run mode' }
      ]
    });

    expect(output).toContain('Postgres cutover: DRY-RUN');
    expect(output).toContain('Runtime switch: unchanged');
    expect(output).toContain('No runtime environment was changed');
  });

  it('documents the safe sequence and default dry-run behavior', () => {
    const help = postgresCutoverHelp();

    expect(help).toContain('Default mode is a dry-run');
    expect(help).toContain('migrate -> seed -> smoke');
    expect(help).toContain('--replace');
  });
});
