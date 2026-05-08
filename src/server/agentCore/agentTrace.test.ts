import { describe, expect, it } from 'vitest';
import { createRunEventDraft } from './agentEvents';
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
    expect(trace.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });
});
