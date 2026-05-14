// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { DemoState } from '../domain/types';
import {
  formatExportedDemoStateJson,
  runPostgresJsonExport,
  type PostgresJsonExportReport
} from './postgresJsonExport';
import type { StateStore } from './stateStore';

describe('Postgres JSON export', () => {
  it('exports a validated tenant state with collection counts for rollback', async () => {
    const state = createDemoState();
    state.messages = [
      {
        id: 'msg-export-first',
        type: 'text',
        roomId: 'room-team',
        senderId: 'user-lin',
        senderName: 'Lin Wen',
        body: 'keep this first for rollback',
        sentAt: '2026-05-04T00:00:00.000Z'
      }
    ];

    const report = await runPostgresJsonExport({
      store: new MemoryStateStore(state),
      tenantId: 'review-demo',
      generatedAt: '2026-05-14T00:00:00.000Z'
    });

    expect(report.ok).toBe(true);
    expect(report.tenantId).toBe('review-demo');
    expect(report.generatedAt).toBe('2026-05-14T00:00:00.000Z');
    expect(report.totalRows).toBeGreaterThan(state.messages.length);
    expect(report.collections.find((collection) => collection.collection === 'messages')?.rows).toBe(1);
    expect(report.state?.messages.map((message) => message.id)).toEqual(['msg-export-first']);
  });

  it('returns a failed report when the exported state is invalid', async () => {
    const report = await runPostgresJsonExport({
      store: new MemoryStateStore({ users: [] } as unknown as DemoState),
      tenantId: 'review-demo',
      generatedAt: '2026-05-14T00:00:00.000Z'
    });

    expect(report).toMatchObject<Partial<PostgresJsonExportReport>>({
      ok: false,
      tenantId: 'review-demo',
      totalRows: 0,
      error: 'Invalid DemoState.agents: expected array'
    });
    expect(report.state).toBeUndefined();
  });

  it('formats exported JSON with a trailing newline for JsonStateStore rollback', async () => {
    const state = createDemoState();
    const json = formatExportedDemoStateJson(state);

    expect(json.endsWith('\n')).toBe(true);
    expect(JSON.parse(json).users[0].id).toBe(state.users[0].id);
  });
});

class MemoryStateStore implements StateStore {
  constructor(private readonly state: DemoState) {}

  async init(): Promise<void> {}

  async read(): Promise<DemoState> {
    return this.state;
  }

  async write(): Promise<void> {
    throw new Error('not needed in export tests');
  }
}
