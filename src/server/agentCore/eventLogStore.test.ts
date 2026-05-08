// @vitest-environment node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventDraft } from './agentEvents';
import { createAgentEventId, createRunEventDraft, encodeEventCursor } from './agentEvents';
import { JsonlAgentEventStore, MemoryAgentEventStore } from './eventLogStore';

function draft(
  runId: string,
  label: string,
  overrides: Partial<Pick<AgentEventDraft, 'sessionId' | 'riskLevel'>> = {}
): AgentEventDraft {
  const base = createRunEventDraft({
    type: 'agent.run.started',
    tenantId: 'local',
    sessionId: overrides.sessionId ?? `${runId}-session`,
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
    riskLevel: overrides.riskLevel,
    payload: { label }
  };
}

async function tempEventPath() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-events-'));
  return join(dir, 'events.jsonl');
}

async function writeJsonl(path: string, records: unknown[]) {
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function relabel(event: AgentEvent, label: string, sequence = event.sequence): AgentEvent {
  return {
    ...event,
    id: createAgentEventId(event.runId, sequence),
    sequence,
    cursor: encodeEventCursor(sequence),
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

  it('allocates unique increasing sequences for concurrent appends', async () => {
    const store = new MemoryAgentEventStore();
    await store.init();

    const events = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.append(draft('run-memory-race', `e-${index}`)))
    );

    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1)
    );
    expect(new Set(events.map((event) => event.cursor)).size).toBe(20);
  });
});

describe('JsonlAgentEventStore', () => {
  it('persists events to jsonl and reloads them', async () => {
    const path = await tempEventPath();
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

  it('appends many events in one jsonl write', async () => {
    const path = await tempEventPath();
    const store = new JsonlAgentEventStore(path);
    await store.init();

    const events = await store.appendMany([
      draft('run-jsonl-many', 'first'),
      draft('run-jsonl-many', 'second')
    ]);
    const reloaded = new JsonlAgentEventStore(path);
    await reloaded.init();

    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    const page = await reloaded.list({ runId: 'run-jsonl-many' });
    expect(page.events.map((event) => event.label)).toEqual(['first', 'second']);
  });

  it('allocates unique increasing sequences for concurrent appends', async () => {
    const path = await tempEventPath();
    const store = new JsonlAgentEventStore(path);
    await store.init();

    const events = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.append(draft('run-jsonl-race', `e-${index}`)))
    );

    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1)
    );
    expect(new Set(events.map((event) => event.cursor)).size).toBe(20);
  });

  it('clamps limit and paginates across multiple pages', async () => {
    const path = await tempEventPath();
    const store = new JsonlAgentEventStore(path);
    await store.init();
    await store.appendMany([
      draft('run-paged', 'first'),
      draft('run-paged', 'second'),
      draft('run-paged', 'third')
    ]);

    const firstPage = await store.list({ runId: 'run-paged', limit: 2 });
    const secondPage = await store.list({ runId: 'run-paged', after: firstPage.nextCursor, limit: 2 });
    const clampedSmall = await store.list({ runId: 'run-paged', limit: 0 });
    const clampedLarge = await store.list({ runId: 'run-paged', limit: 999 });

    expect(firstPage.events.map((event) => event.label)).toEqual(['first', 'second']);
    expect(secondPage.events.map((event) => event.label)).toEqual(['third']);
    expect(clampedSmall.events.map((event) => event.label)).toEqual(['first']);
    expect(clampedLarge.events.map((event) => event.label)).toEqual(['first', 'second', 'third']);
  });

  it('treats invalid cursors as replay from the start', async () => {
    const path = await tempEventPath();
    const store = new JsonlAgentEventStore(path);
    await store.init();
    await store.appendMany([draft('run-invalid-cursor', 'first'), draft('run-invalid-cursor', 'second')]);

    const page = await store.list({ runId: 'run-invalid-cursor', after: 'not-a-cursor' });

    expect(page.events.map((event) => event.label)).toEqual(['first', 'second']);
  });

  it('combines sessionId and runId filters', async () => {
    const path = await tempEventPath();
    const store = new JsonlAgentEventStore(path);
    await store.init();
    await store.appendMany([
      draft('run-filtered', 'matching', { sessionId: 'session-a' }),
      draft('run-filtered', 'wrong-session', { sessionId: 'session-b' }),
      draft('run-other', 'wrong-run', { sessionId: 'session-a' })
    ]);

    const page = await store.list({ runId: 'run-filtered', sessionId: 'session-a' });

    expect(page.events.map((event) => event.label)).toEqual(['matching']);
  });

  it('reports degraded health when the jsonl file has invalid lines', async () => {
    const path = await tempEventPath();
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

  it('skips invalid json and invalid event shapes during list replay', async () => {
    const path = await tempEventPath();
    const seed = new JsonlAgentEventStore(path);
    await seed.init();
    const valid = await seed.append(draft('run-invalid-lines', 'valid'));
    await writeFile(path, `${JSON.stringify(valid)}\nnot-json\n{"ok":true}\n`, 'utf8');

    const store = new JsonlAgentEventStore(path);
    await store.init();

    const page = await store.list({ runId: 'run-invalid-lines' });
    const health = await store.health();
    expect(page.events.map((event) => event.label)).toEqual(['valid']);
    expect(health.valid).toBe(false);
  });

  it('rejects malformed cursor and id records during list replay', async () => {
    const path = await tempEventPath();
    const seed = new JsonlAgentEventStore(path);
    await seed.init();
    const [valid, malformedCursor, malformedId] = await seed.appendMany([
      draft('run-malformed', 'valid'),
      draft('run-malformed', 'malformed-cursor'),
      draft('run-malformed', 'malformed-id')
    ]);
    await writeJsonl(path, [
      valid,
      { ...malformedCursor, cursor: 'seq:999' },
      { ...malformedId, id: 'wrong-id' }
    ]);

    const store = new JsonlAgentEventStore(path);
    await store.init();

    const page = await store.list({ runId: 'run-malformed' });
    const health = await store.health();
    expect(page.events.map((event) => event.label)).toEqual(['valid']);
    expect(health.valid).toBe(false);
  });

  it('rejects invalid event fields during list replay', async () => {
    const path = await tempEventPath();
    const seed = new JsonlAgentEventStore(path);
    await seed.init();
    const [first, invalidCreatedAt, invalidType, invalidVisibility, invalidRiskLevel, sixth] =
      await seed.appendMany([
        draft('run-invalid-fields', 'first'),
        draft('run-invalid-fields', 'invalid-created-at'),
        draft('run-invalid-fields', 'invalid-type'),
        draft('run-invalid-fields', 'invalid-visibility'),
        draft('run-invalid-fields', 'invalid-risk'),
        draft('run-invalid-fields', 'after-invalid-fields')
      ]);
    await writeJsonl(path, [
      relabel(first, 'zero-sequence', 0),
      first,
      { ...invalidCreatedAt, createdAt: 'not-a-date' },
      { ...invalidType, type: 'agent.unknown' },
      { ...invalidVisibility, visibility: 'private' },
      { ...invalidRiskLevel, riskLevel: 'critical' },
      sixth
    ]);

    const store = new JsonlAgentEventStore(path);
    await store.init();

    const page = await store.list({ runId: 'run-invalid-fields' });
    const health = await store.health();
    expect(page.events.map((event) => event.label)).toEqual(['first', 'after-invalid-fields']);
    expect(health.valid).toBe(false);
  });

  it('rejects duplicate and non-monotonic sequence records during list replay', async () => {
    const path = await tempEventPath();
    const seed = new JsonlAgentEventStore(path);
    await seed.init();
    const [first, second, third, fourth] = await seed.appendMany([
      draft('run-monotonic', 'first'),
      draft('run-monotonic', 'second'),
      draft('run-monotonic', 'third'),
      draft('run-monotonic', 'fourth')
    ]);
    await writeJsonl(path, [
      first,
      second,
      relabel(second, 'duplicate-second'),
      fourth,
      relabel(third, 'late-third')
    ]);

    const store = new JsonlAgentEventStore(path);
    await store.init();

    const page = await store.list({ runId: 'run-monotonic' });
    const health = await store.health();
    expect(page.events.map((event) => event.label)).toEqual(['first', 'second', 'fourth']);
    expect(health.valid).toBe(false);
  });
});
