// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  formatPostgresStateSmokeReport,
  resolvePostgresStateSmokeCliConfig
} from './postgresStateSmokeCli';
import type { PostgresStateSmokeReport } from './postgresStateSmoke';

describe('postgres state smoke CLI helpers', () => {
  it('uses safe defaults from environment and cwd', () => {
    const config = resolvePostgresStateSmokeCliConfig([], {
      AGENT_IM_DB_PATH: 'runtime/db.json',
      AGENTBRIDGE_TENANT_ID: 'review-demo'
    }, '/repo');

    expect(config).toEqual({
      dbPath: resolve('/repo', 'runtime/db.json'),
      tenantId: 'review-demo',
      json: false,
      help: false
    });
  });

  it('allows explicit db path, tenant and json output', () => {
    const config = resolvePostgresStateSmokeCliConfig([
      '--db',
      'tmp/agent-im-db.json',
      '--tenant',
      'production-pilot',
      '--json'
    ], {}, '/repo');

    expect(config).toEqual({
      dbPath: resolve('/repo', 'tmp/agent-im-db.json'),
      tenantId: 'production-pilot',
      json: true,
      help: false
    });
  });

  it('formats failing table checks without leaking database URLs', () => {
    const report: PostgresStateSmokeReport = {
      ok: false,
      tenantId: 'review-demo',
      checks: {
        migration: { ok: true, version: '202605140001' },
        tables: [
          {
            collection: 'messages',
            tableName: 'agentbridge_messages',
            ok: false,
            expectedRows: 12,
            actualRows: 10
          }
        ],
        parity: {
          ok: false,
          expectedCollections: 17,
          actualCollections: 17,
          firstMessageId: 'msg-02'
        }
      }
    };

    const formatted = formatPostgresStateSmokeReport(report);

    expect(formatted).toContain('Postgres state smoke: FAIL');
    expect(formatted).toContain('agentbridge_messages: 10/12');
    expect(formatted).not.toContain('postgres://');
  });
});
