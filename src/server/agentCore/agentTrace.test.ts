import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventType } from './agentEvents';
import { createAgentEventId, createRunEventDraft, encodeEventCursor } from './agentEvents';
import { MemoryAgentEventStore } from './eventLogStore';
import { buildAgentTrace } from './agentTrace';

describe('buildAgentTrace', () => {
  it('summarizes ordered events into a replayable trace', async () => {
    const store = new MemoryAgentEventStore();
    await store.init();
    await store.appendMany([
      createRunEventDraft({
        type: 'agent.run.created',
        tenantId: 'local',
        sessionId: 'session-1',
        runId: 'run-1',
        agentId: 'agent-lin',
        roomId: 'room-team',
        entrypoint: 'agent-trace-test',
        visibility: 'internal',
        payload: { userText: 'hello' }
      }),
      {
        ...createRunEventDraft({
          type: 'agent.run.started',
          tenantId: 'local',
          sessionId: 'session-1',
          runId: 'run-1',
          agentId: 'agent-lin',
          roomId: 'room-team',
          entrypoint: 'agent-trace-test',
          visibility: 'user',
          payload: { phase: 'executing' }
        }),
        type: 'agent.progress',
        phase: 'executing',
        label: 'Execute tool',
        toolCalls: ['file.search']
      },
      createRunEventDraft({
        type: 'agent.run.completed',
        tenantId: 'local',
        sessionId: 'session-1',
        runId: 'run-1',
        agentId: 'agent-lin',
        roomId: 'room-team',
        entrypoint: 'agent-trace-test',
        visibility: 'internal',
        toolCalls: ['file.search'],
        payload: { intent: 'find_file' }
      })
    ]);

    const page = await store.list({ runId: 'run-1' });
    const trace = buildAgentTrace(page.events);

    expect(trace).toMatchObject({
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'completed',
      agentId: 'agent-lin',
      roomId: 'room-team'
    });
    expect(trace.phases).toEqual(['executing']);
    expect(trace.toolCalls).toEqual(['file.search']);
    expect(trace.eventCount).toBe(3);
    expect(trace.truncated).toBeUndefined();
    expect(trace.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it('marks traces without terminal events as running', () => {
    const trace = buildAgentTrace([
      event(1, { type: 'agent.run.created' }),
      event(2, { type: 'agent.progress', phase: 'planning' })
    ]);

    expect(trace.status).toBe('running');
    expect(trace.finishedAt).toBeUndefined();
    expect(trace.eventCount).toBe(2);
  });

  it.each([
    ['agent.run.failed', 'failed'],
    ['agent.run.cancelled', 'cancelled']
  ] as const)('maps %s terminal events to %s status', (type, status) => {
    const terminal = event(2, { type });
    const trace = buildAgentTrace([event(1, { type: 'agent.run.created' }), terminal]);

    expect(trace.status).toBe(status);
    expect(trace.finishedAt).toBe(terminal.createdAt);
  });

  it('sorts unsorted input by sequence before summarizing', () => {
    const first = event(1, { type: 'agent.run.created' });
    const second = event(2, { type: 'agent.progress', phase: 'planning' });
    const third = event(3, { type: 'agent.run.completed' });

    const trace = buildAgentTrace([third, first, second]);

    expect(trace.startedAt).toBe(first.createdAt);
    expect(trace.finishedAt).toBe(third.createdAt);
    expect(trace.events.map((traceEvent) => traceEvent.sequence)).toEqual([1, 2, 3]);
  });

  it('deduplicates phases and tool calls in first-seen order', () => {
    const trace = buildAgentTrace([
      event(1, { type: 'agent.run.created' }),
      event(2, {
        type: 'agent.progress',
        phase: 'planning',
        toolCalls: ['file.search', 'message.send']
      }),
      event(3, {
        type: 'agent.progress',
        phase: 'executing',
        toolCalls: ['message.send', 'calendar.lookup']
      }),
      event(4, {
        type: 'agent.progress',
        phase: 'planning',
        toolCalls: ['file.search', 'note.create']
      })
    ]);

    expect(trace.phases).toEqual(['planning', 'executing']);
    expect(trace.toolCalls).toEqual(['file.search', 'message.send', 'calendar.lookup', 'note.create']);
  });

  it('rejects events from multiple runs', () => {
    expect(() =>
      buildAgentTrace([
        event(1, { runId: 'run-1' }),
        event(2, { runId: 'run-2' })
      ])
    ).toThrow('agent trace events must belong to one run');
  });

  it.each([
    ['sessionId', 'session-2', 'agent trace events must belong to one session'],
    ['tenantId', 'remote', 'agent trace events must belong to one tenant']
  ] as const)('rejects events with mismatched %s', (field, value, message) => {
    expect(() =>
      buildAgentTrace([
        event(1),
        event(2, { [field]: value })
      ])
    ).toThrow(message);
  });

  it('rejects empty event input with a clear error', () => {
    expect(() => buildAgentTrace([])).toThrow('agent trace requires at least one event');
  });

  it('treats the last terminal event as authoritative', () => {
    const failed = event(2, { type: 'agent.run.failed' });
    const completed = event(3, { type: 'agent.run.completed' });
    const trace = buildAgentTrace([event(1, { type: 'agent.run.created' }), failed, completed]);

    expect(trace.status).toBe('completed');
    expect(trace.finishedAt).toBe(completed.createdAt);
  });

  it('uses the last terminal event finishedAt even when later non-terminal events exist', () => {
    const completed = event(2, { type: 'agent.run.completed' });
    const laterProgress = event(3, { type: 'agent.progress', phase: 'cleanup' });
    const trace = buildAgentTrace([event(1, { type: 'agent.run.created' }), completed, laterProgress]);

    expect(trace.status).toBe('completed');
    expect(trace.finishedAt).toBe(completed.createdAt);
    expect(trace.events.map((traceEvent) => traceEvent.sequence)).toEqual([1, 2, 3]);
  });

  it('marks traces as truncated only when requested', () => {
    const completeTrace = buildAgentTrace([event(1)]);
    const truncatedTrace = buildAgentTrace([event(1)], { truncated: true });

    expect(completeTrace.eventCount).toBe(1);
    expect(completeTrace.truncated).toBeUndefined();
    expect(truncatedTrace.eventCount).toBe(1);
    expect(truncatedTrace.truncated).toBe(true);
  });
});

type EventOverrides = Partial<Omit<AgentEvent, 'id' | 'sequence' | 'cursor' | 'createdAt'>> &
  Partial<Pick<AgentEvent, 'id' | 'cursor' | 'createdAt'>>;

function event(sequence: number, overrides: EventOverrides = {}): AgentEvent {
  const runId = overrides.runId ?? 'run-1';
  const type: AgentEventType = overrides.type ?? 'agent.progress';

  return {
    type,
    tenantId: overrides.tenantId ?? 'local',
    sessionId: overrides.sessionId ?? 'session-1',
    runId,
    agentId: overrides.agentId ?? 'agent-lin',
    roomId: overrides.roomId ?? 'room-team',
    visibility: overrides.visibility ?? 'internal',
    phase: overrides.phase,
    label: overrides.label,
    detail: overrides.detail,
    toolCalls: overrides.toolCalls ? [...overrides.toolCalls] : [],
    riskLevel: overrides.riskLevel,
    payload: overrides.payload ?? {},
    id: overrides.id ?? createAgentEventId(runId, sequence),
    sequence,
    cursor: overrides.cursor ?? encodeEventCursor(sequence),
    createdAt: overrides.createdAt ?? timestamp(sequence)
  };
}

function timestamp(sequence: number): string {
  return `2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`;
}
