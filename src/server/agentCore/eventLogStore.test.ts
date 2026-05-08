// @vitest-environment node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunEventDraft } from './agentEvents';
import { JsonlAgentEventStore, MemoryAgentEventStore } from './eventLogStore';

function draft(runId: string, label: string) {
  const base = createRunEventDraft({
    type: 'agent.run.started',
    tenantId: 'local',
    sessionId: `${runId}-session`,
    runId,
    agentId: 'agent-lin',
    roomId: 'room-team',
    entrypoint: 'event-log-store-test',
    visibility: 'user',
    payload: { label }
  });

  return {
    ...base,
    type: 'agent.progress' as const,
    label,
    payload: { label }
  };
}

describe('MemoryAgentEventStore', () => {
  it('appends events with increasing sequence and cursor replay', async () => {
    const store = new MemoryAgentEventStore();
    await store.init();

    const first = await store.append(draft('run-1', 'first'));
    const second = await store.append(draft('run-1', 'second'));
    await store.append(draft('run-2', 'third'));

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);

    const page = await store.list({ runId: 'run-1', after: first.cursor });
    expect(page.events.map((event) => event.label)).toEqual(['second']);
    expect(page.nextCursor).toBe(second.cursor);
  });
});

describe('JsonlAgentEventStore', () => {
  it('persists events to jsonl and reloads them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-events-'));
    const path = join(dir, 'events.jsonl');
    const store = new JsonlAgentEventStore(path);
    await store.init();

    const event = await store.append(draft('run-jsonl', 'persisted'));
    const reloaded = new JsonlAgentEventStore(path);
    await reloaded.init();

    const page = await reloaded.list({ runId: 'run-jsonl' });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      id: event.id,
      cursor: event.cursor,
      label: 'persisted'
    });
  });

  it('reports degraded health when the jsonl file has invalid lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-events-'));
    const path = join(dir, 'events.jsonl');
    await writeFile(path, '{"ok":true}\nnot-json\n', 'utf8');

    const store = new JsonlAgentEventStore(path);
    await store.init();

    const health = await store.health();
    expect(health.readable).toBe(true);
    expect(health.writable).toBe(true);
    expect(health.valid).toBe(false);

    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('not-json');
  });
});
