// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import { buildPostgresSeedSql } from '../../scripts/export-json-state-to-postgres-seed';

describe('Postgres seed exporter', () => {
  it('exports the current JSON DemoState into idempotent table inserts', () => {
    const state = createDemoState();
    const sql = buildPostgresSeedSql(state, {
      generatedAt: '2026-05-14T00:00:00.000Z',
      tenantId: 'demo'
    });

    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain('INSERT INTO agentbridge_users (tenant_id, id, data, position, created_at, updated_at)');
    expect(sql).toContain("INSERT INTO agentbridge_messages");
    expect(sql).toContain("'agent-lin'");
    expect(sql).toContain("'::jsonb, 0,");
    expect(sql).toContain("ON CONFLICT (tenant_id, id) DO UPDATE");
    expect(sql).toContain('position = EXCLUDED.position');
    expect(countInserts(sql, 'agentbridge_messages')).toBe(state.messages.length);
    expect(countInserts(sql, 'agentbridge_agent_autopilot_policies')).toBe(state.agentAutopilotPolicies.length);
  });

  it('escapes JSON safely for SQL string literals', () => {
    const state = createDemoState();
    state.messages = [
      {
        id: 'msg-quote-proof',
        roomId: 'room-team',
        senderId: 'user-lin',
        senderName: 'Lin',
        body: "it's safe to export",
        sentAt: '2026-05-04T12:00:00.000Z',
        type: 'text'
      }
    ];

    const sql = buildPostgresSeedSql(state, {
      generatedAt: '2026-05-14T00:00:00.000Z',
      tenantId: 'demo'
    });

    expect(sql).toContain("it''s safe to export");
    expect(sql).toContain("'msg-quote-proof'");
  });
});

function countInserts(sql: string, tableName: string): number {
  return (sql.match(new RegExp(`INSERT INTO ${tableName}`, 'g')) ?? []).length;
}
