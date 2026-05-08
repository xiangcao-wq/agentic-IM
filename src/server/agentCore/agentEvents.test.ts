import { describe, expect, it } from 'vitest';
import {
  agentProgressToEventDraft,
  createAgentEventId,
  createRunEventDraft,
  encodeEventCursor,
  parseEventCursor
} from './agentEvents';

describe('agent event helpers', () => {
  it('encodes and parses sequence cursors', () => {
    expect(encodeEventCursor(42)).toBe('seq:42');
    expect(parseEventCursor('seq:42')).toBe(42);
    expect(parseEventCursor(undefined)).toBe(0);
    expect(parseEventCursor('bad-cursor')).toBe(0);
  });

  it('creates event ids for non-negative integer sequences', () => {
    expect(createAgentEventId('run-1', 0)).toBe('run-1-event-00000000');
    expect(createAgentEventId('run-1', 42)).toBe('run-1-event-00000042');
  });

  it('rejects invalid event id sequences', () => {
    for (const sequence of [-1, 3.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => createAgentEventId('run-1', sequence)).toThrow(RangeError);
      expect(() => createAgentEventId('run-1', sequence)).toThrow(
        'event sequence must be a non-negative integer'
      );
    }
  });

  it('creates a run event draft with product identity context', () => {
    const draft = createRunEventDraft({
      type: 'agent.run.created',
      tenantId: 'local',
      sessionId: 'session-1',
      runId: 'run-1',
      agentId: 'agent-lin',
      roomId: 'room-team',
      entrypoint: 'chat',
      visibility: 'internal',
      payload: { userText: 'summarize this room' }
    });

    expect(draft).toMatchObject({
      type: 'agent.run.created',
      tenantId: 'local',
      sessionId: 'session-1',
      runId: 'run-1',
      agentId: 'agent-lin',
      roomId: 'room-team',
      visibility: 'internal'
    });
    expect(draft.payload).toMatchObject({ entrypoint: 'chat', userText: 'summarize this room' });
  });

  it('maps legacy progress events into canonical agent progress drafts', () => {
    const draft = agentProgressToEventDraft(
      {
        tenantId: 'local',
        sessionId: 'session-1',
        runId: 'run-1'
      },
      {
        runId: 'run-1',
        agentId: 'agent-lin',
        roomId: 'room-team',
        phase: 'executing',
        label: 'Execute file search',
        detail: 'looking for slides',
        toolCalls: ['file.search'],
        riskLevel: 'low'
      }
    );

    expect(draft).toMatchObject({
      type: 'agent.progress',
      tenantId: 'local',
      sessionId: 'session-1',
      runId: 'run-1',
      agentId: 'agent-lin',
      roomId: 'room-team',
      phase: 'executing',
      label: 'Execute file search',
      visibility: 'user'
    });
    expect(draft.toolCalls).toEqual(['file.search']);
    expect(draft.riskLevel).toBe('low');
    expect(draft.payload).toMatchObject({
      phase: 'executing',
      label: 'Execute file search',
      detail: 'looking for slides',
      toolCalls: ['file.search'],
      riskLevel: 'low'
    });
    expect(draft.payload.riskLevel).toBe('low');
  });

  it('rejects legacy progress events for a different run', () => {
    expect(() =>
      agentProgressToEventDraft(
        {
          tenantId: 'local',
          sessionId: 'session-1',
          runId: 'run-1'
        },
        {
          runId: 'run-2',
          agentId: 'agent-lin',
          roomId: 'room-team',
          phase: 'executing',
          label: 'Execute file search'
        }
      )
    ).toThrow('progress runId must match event context runId');
  });
});
