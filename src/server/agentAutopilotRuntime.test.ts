// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { DemoState, Message } from '../domain/types';
import { runAgentAutopilotForMessage } from './agentAutopilotRuntime';

describe('agent autopilot runtime', () => {
  it('executes a low-risk delegated file handoff and records an A2A session', async () => {
    const state = withDownloadableSlides(createDemoState());
    const trigger: Message = {
      id: 'msg-autopilot-trigger',
      roomId: 'room-team',
      senderId: 'user-chen',
      senderName: 'Chen Chen',
      body: 'Lin is offline. Can her Agent send the latest slides to Chen?',
      sentAt: '2026-05-04T20:30:00.000Z',
      type: 'text'
    };

    const result = await runAgentAutopilotForMessage({
      state: { ...state, messages: [...state.messages, trigger] },
      triggerMessage: trigger,
      sendMessage: async (_sendState, message) => ({
        ...message,
        id: `sent-${message.id}`,
        sentAt: '2026-05-04T20:30:02.000Z'
      })
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      roomId: 'room-team',
      initiatorAgentId: 'agent-chen',
      targetAgentIds: ['agent-lin'],
      status: 'completed'
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: 'file',
      sourceAgentId: 'agent-lin',
      fileId: 'file-slides-v3'
    });
    expect(result.state.messages.some((message) => message.id === result.messages[0].id)).toBe(true);
    expect(result.state.a2aSessions.some((session) => session.id === result.sessions[0].id)).toBe(true);
    expect(result.state.actionLogs[0].toolCalls).toContain('a2a.session');
  });

  it('queues high-risk schedule coordination instead of mutating calendar during autopilot', async () => {
    const state = createDemoState();
    const originalCalendar = state.calendar.map((item) => ({ id: item.id, startsAt: item.startsAt }));
    const trigger: Message = {
      id: 'msg-autopilot-coordinate',
      roomId: 'room-team',
      senderId: 'user-zhao',
      senderName: 'Zhao Yiming',
      body: 'Lin Agent, coordinate with Chen and move the final review to Wednesday 23:00.',
      sentAt: '2026-05-04T20:35:00.000Z',
      type: 'text'
    };

    const result = await runAgentAutopilotForMessage({
      state: { ...state, messages: [...state.messages, trigger] },
      triggerMessage: trigger
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      status: 'needs_confirmation',
      targetAgentIds: ['agent-lin']
    });
    expect(result.state.actionRequests.some((request) => request.kind === 'coordinate')).toBe(true);
    expect(result.state.calendar.map((item) => ({ id: item.id, startsAt: item.startsAt }))).toEqual(originalCalendar);
  });

  it('runs multiple explicitly mentioned authorized agents in one A2A turn', async () => {
    const state = enableAutopilot(createDemoState(), ['agent-lin', 'agent-chen']);
    const trigger: Message = {
      id: 'msg-autopilot-multi-agent',
      roomId: 'room-team',
      senderId: 'user-zhao',
      senderName: 'Zhao Yiming',
      body: 'Lin Agent and Chen Agent, what is the deadline?',
      sentAt: '2026-05-04T20:40:00.000Z',
      type: 'text'
    };

    const result = await runAgentAutopilotForMessage({
      state: { ...state, messages: [...state.messages, trigger] },
      triggerMessage: trigger
    });

    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map((session) => session.targetAgentIds[0])).toEqual(['agent-lin', 'agent-chen']);
    expect(result.sessions.every((session) => session.status === 'completed')).toBe(true);
    expect(result.state.a2aSessions.slice(0, 2).map((session) => session.targetAgentIds[0])).toEqual([
      'agent-chen',
      'agent-lin'
    ]);
    expect(result.state.actionLogs.filter((log) => log.toolCalls.includes('a2a.session'))).toHaveLength(2);
  });
});

function withDownloadableSlides(state: DemoState): DemoState {
  return {
    ...state,
    files: state.files.map((file) =>
      file.id === 'file-slides-v3'
        ? {
            ...file,
            mxcUri: 'mxc://localhost/slides-v3',
            contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            size: 2048
          }
        : file
    )
  };
}

function enableAutopilot(state: DemoState, agentIds: string[]): DemoState {
  return {
    ...state,
    agentAutopilotPolicies: state.agentAutopilotPolicies.map((policy) => ({
      ...policy,
      enabled: agentIds.includes(policy.agentId)
    }))
  };
}
