// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../../domain/demoState';
import type { DemoState } from '../../domain/types';
import type { AgentEventDraft } from './agentEvents';
import type { AgentEventStore } from './eventLogStore';
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
    expect(page.events.filter((event) => event.type === 'agent.progress').map((event) => event.phase)).toContain(
      'started'
    );
    expect(page.events.at(-1)).toMatchObject({ type: 'agent.run.completed' });
  });

  it('treats onProgress as observational when callbacks throw', async () => {
    const store = new MemoryAgentEventStore();
    await store.init();
    const observedPhases: string[] = [];

    const runtime = await runProductAgentSession({
      state: createDemoState(),
      input: {
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'chat',
        userText: 'Who owns the interview materials?'
      },
      eventStore: store,
      runId: 'agent-run-observer-throws',
      sessionId: 'agent-session-observer-throws',
      aiProvider: undefined,
      tools: {},
      onProgress: (event) => {
        observedPhases.push(event.phase);
        if (event.phase === 'started') {
          throw new Error('observer failed');
        }
      }
    });

    expect(runtime.response.intent).toBe('chat');
    expect(observedPhases).toContain('started');

    const page = await store.list({ runId: 'agent-run-observer-throws' });
    expect(page.events.filter((event) => event.type === 'agent.progress').map((event) => event.phase)).toContain(
      'started'
    );
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
    expect(page.events.map((event) => event.type)).toEqual([
      'agent.run.created',
      'agent.progress',
      'agent.run.failed'
    ]);
    expect(page.events[1]).toMatchObject({ type: 'agent.progress', phase: 'started' });
    expect(page.events.at(-1)?.payload).toMatchObject({ error: 'unknown agent: missing-agent' });
  });

  it('records accumulated progress before failed events when permission checks fail', async () => {
    const store = new MemoryAgentEventStore();
    await store.init();

    await expect(
      runProductAgentSession({
        state: createDemoState(),
        input: {
          agentId: 'agent-chen',
          roomId: 'room-class',
          intent: 'chat',
          userText: 'hello'
        },
        eventStore: store,
        runId: 'agent-run-denied',
        sessionId: 'agent-session-denied',
        aiProvider: undefined,
        tools: {}
      })
    ).rejects.toThrow('cannot read room-class');

    const page = await store.list({ runId: 'agent-run-denied' });
    expect(page.events.map((event) => event.type)).toEqual([
      'agent.run.created',
      'agent.progress',
      'agent.run.failed'
    ]);
    expect(page.events[1]).toMatchObject({ type: 'agent.progress', phase: 'started' });
    expect(page.events.at(-1)).toMatchObject({ type: 'agent.run.failed' });
  });

  it('preserves ordered progress before later runtime failures', async () => {
    const store = new MemoryAgentEventStore();
    await store.init();

    await expect(
      runProductAgentSession({
        state: createDemoState(),
        input: {
          agentId: 'agent-lin',
          roomId: 'room-team',
          intent: 'coordinate',
          targetUserId: 'missing-user',
          userText: 'Coordinate this with an unknown teammate'
        },
        eventStore: store,
        runId: 'agent-run-late-failed',
        sessionId: 'agent-session-late-failed',
        aiProvider: undefined,
        tools: {}
      })
    ).rejects.toThrow('unknown target user: missing-user');

    const page = await store.list({ runId: 'agent-run-late-failed' });
    const progressPhases = page.events
      .filter((event) => event.type === 'agent.progress')
      .map((event) => event.phase);

    expect(page.events.map((event) => event.type)).toEqual([
      'agent.run.created',
      'agent.progress',
      'agent.progress',
      'agent.progress',
      'agent.progress',
      'agent.run.failed'
    ]);
    expect(progressPhases).toEqual(['started', 'planning', 'planning', 'executing']);
    expect(page.events.at(-1)).toMatchObject({ type: 'agent.run.failed' });
  });

  it('rethrows the original runtime error when failed event persistence fails', async () => {
    const store = createFailingAppendStore();

    await expect(
      runProductAgentSession({
        state: createDemoState(),
        input: {
          agentId: 'missing-agent',
          roomId: 'room-team',
          intent: 'chat',
          userText: 'hello'
        },
        eventStore: store,
        runId: 'agent-run-store-fails',
        sessionId: 'agent-session-store-fails',
        aiProvider: undefined,
        tools: {}
      })
    ).rejects.toThrow('unknown agent: missing-agent');
  });
});

function createFailingAppendStore(): AgentEventStore {
  return {
    async init() {
      return undefined;
    },
    async append(_draft: AgentEventDraft) {
      throw new Error('event store append failed');
    },
    async appendMany(_drafts: AgentEventDraft[]) {
      throw new Error('event store append failed');
    },
    async list() {
      return { events: [] };
    },
    async health() {
      return {
        readable: true,
        writable: false,
        valid: false
      };
    }
  };
}
