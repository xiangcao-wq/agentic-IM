// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../../domain/demoState';
import type { DemoState } from '../../domain/types';
import { MemoryAgentEventStore } from './eventLogStore';
import { runProductAgentSession } from './productHarness';

describe('runProductAgentSession', () => {
  it('wraps a successful existing agent run with product events', async () => {
    const store = new MemoryAgentEventStore();
    await store.init();

    const runtime = await runProductAgentSession({
      state: createDemoState(),
      input: {
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'chat',
        userText: 'Who owns the interview materials?'
      },
      eventStore: store,
      runId: 'agent-run-test',
      sessionId: 'agent-session-test',
      aiProvider: undefined,
      tools: {}
    });

    expect(runtime.runId).toBe('agent-run-test');
    expect(runtime.sessionId).toBe('agent-session-test');
    expect(runtime.response.intent).toBe('chat');

    const page = await store.list({ runId: 'agent-run-test' });
    expect(page.events.map((event) => event.type)).toContain('agent.run.created');
    expect(page.events.map((event) => event.type)).toContain('agent.progress');
    expect(page.events.at(-1)).toMatchObject({ type: 'agent.run.completed' });
  });

  it('records failed product events before rethrowing runtime errors', async () => {
    const store = new MemoryAgentEventStore();
    await store.init();
    const state: DemoState = createDemoState();

    await expect(
      runProductAgentSession({
        state,
        input: {
          agentId: 'missing-agent',
          roomId: 'room-team',
          intent: 'chat',
          userText: 'hello'
        },
        eventStore: store,
        runId: 'agent-run-failed',
        sessionId: 'agent-session-failed',
        aiProvider: undefined,
        tools: {}
      })
    ).rejects.toThrow('unknown agent');

    const page = await store.list({ runId: 'agent-run-failed' });
    expect(page.events.map((event) => event.type)).toEqual(['agent.run.created', 'agent.run.failed']);
    expect(page.events.at(-1)?.payload).toMatchObject({ error: 'unknown agent: missing-agent' });
  });
});
