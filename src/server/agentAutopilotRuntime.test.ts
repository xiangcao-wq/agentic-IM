// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { DemoState, Message } from '../domain/types';
import { runAgentAutopilotForMessage, runPendingAgentAutopilot } from './agentAutopilotRuntime';

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
      targetAgentIds: ['agent-lin', 'agent-chen']
    });
    expect(result.state.actionRequests.some((request) => request.kind === 'coordinate')).toBe(true);
    expect(result.state.calendar.map((item) => ({ id: item.id, startsAt: item.startsAt }))).toEqual(originalCalendar);
  });

  it('records autonomous A2A schedule negotiation turns before asking for human confirmation', async () => {
    const state = enableAutopilot(createDemoState(), ['agent-lin', 'agent-chen']);
    const originalCalendar = state.calendar.map((item) => ({ id: item.id, startsAt: item.startsAt }));
    const trigger: Message = {
      id: 'msg-autopilot-negotiation',
      roomId: 'room-team',
      senderId: 'user-zhao',
      senderName: 'Zhao Yiming',
      body: 'Lin Agent, please negotiate with Chen Agent and move the final review to Wednesday 23:00.',
      sentAt: '2026-05-04T20:36:00.000Z',
      type: 'text'
    };

    const result = await runAgentAutopilotForMessage({
      state: { ...state, messages: [...state.messages, trigger] },
      triggerMessage: trigger
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].status).toBe('needs_confirmation');
    expect(result.sessions[0].targetAgentIds).toEqual(['agent-lin', 'agent-chen']);
    expect(result.sessions[0].turns.map((turn) => turn.kind)).toEqual([
      'observation',
      'proposal',
      'response',
      'response',
      'proposal'
    ]);
    expect(result.sessions[0].turns.map((turn) => turn.agentId)).toContain('agent-chen');
    expect(result.sessions[0].turns.at(-1)?.message).toContain('human confirmation');
    expect(result.sessions[0].proposedActionRequestIds).toHaveLength(1);

    const request = result.state.actionRequests.find((candidate) =>
      result.sessions[0].proposedActionRequestIds.includes(candidate.id)
    );
    expect(request?.kind).toBe('coordinate');
    expect(request?.input.calendarPatch).toMatchObject({
      itemId: 'cal-review',
      newStartsAt: expect.stringContaining('23:00')
    });
    expect(result.state.calendar.map((item) => ({ id: item.id, startsAt: item.startsAt }))).toEqual(originalCalendar);
  });

  it('counter-proposes a later time when a target Agent owner has a calendar conflict', async () => {
    const baseState = enableAutopilot(createDemoState(), ['agent-lin', 'agent-chen']);
    const state: DemoState = {
      ...baseState,
      calendar: [
        ...baseState.calendar,
        {
          id: 'cal-chen-conflict',
          title: 'Chen interview material sync',
          startsAt: '2026-05-06T21:00:00+08:00',
          roomId: 'room-team',
          attendees: ['user-chen'],
          sourceTaskId: 'task-interview-materials'
        }
      ]
    };
    const trigger: Message = {
      id: 'msg-autopilot-counter-proposal',
      roomId: 'room-team',
      senderId: 'user-zhao',
      senderName: 'Zhao Yiming',
      body: 'Lin Agent, please negotiate with Chen Agent and move the final review to Wednesday 21:00.',
      sentAt: '2026-05-04T20:37:00.000Z',
      type: 'text'
    };

    const result = await runAgentAutopilotForMessage({
      state: { ...state, messages: [...state.messages, trigger] },
      triggerMessage: trigger
    });

    const chenTurn = result.sessions[0].turns.find((turn) => turn.agentId === 'agent-chen');
    expect(chenTurn).toMatchObject({
      kind: 'counter_proposal'
    });
    expect(chenTurn?.message).toContain('Chen interview material sync');
    expect(chenTurn?.message).toContain('23:00');

    const actionId = result.sessions[0].proposedActionRequestIds[0];
    const request = result.state.actionRequests.find((candidate) => candidate.id === actionId);
    expect(request?.input.calendarPatch).toMatchObject({
      oldStartsAt: '2026-05-05T20:30:00+08:00',
      newStartsAt: '2026-05-06T23:00:00+08:00'
    });
    expect(result.state.calendar.find((item) => item.id === 'cal-review')?.startsAt).toBe('2026-05-05T20:30:00+08:00');
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

  it('answers explicit Agent mentions as delegated chat without requiring a shortcut intent', async () => {
    const state = createDemoState();
    const trigger: Message = {
      id: 'msg-autopilot-chat-mention',
      roomId: 'room-team',
      senderId: 'user-chen',
      senderName: 'Chen Chen',
      body: 'Lin Agent, who is responsible for interview materials?',
      sentAt: '2026-05-04T20:42:00.000Z',
      type: 'text'
    };

    const result = await runAgentAutopilotForMessage({
      state: { ...state, messages: [...state.messages, trigger] },
      triggerMessage: trigger,
      sendMessage: async (_sendState, message) => ({
        ...message,
        id: `sent-${message.id}`,
        sentAt: '2026-05-04T20:42:02.000Z'
      })
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.responses[0].intent).toBe('chat');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: 'agent',
      roomId: 'room-team',
      senderId: 'user-lin',
      sourceAgentId: 'agent-lin'
    });
    expect(result.messages[0].body).toContain('访谈');
    expect(result.sessions[0]).toMatchObject({
      status: 'completed',
      targetAgentIds: ['agent-lin']
    });
    expect(result.state.messages.some((message) => message.id === result.messages[0].id)).toBe(true);
  });

  it('sweeps pending room messages without duplicating completed A2A sessions', async () => {
    const state = withDownloadableSlides(createDemoState());
    const trigger: Message = {
      id: 'msg-autopilot-backlog',
      roomId: 'room-team',
      senderId: 'user-chen',
      senderName: 'Chen Chen',
      body: 'Lin is offline. Can her Agent send the latest slides to Chen?',
      sentAt: '2026-05-04T20:45:00.000Z',
      type: 'text'
    };

    const first = await runPendingAgentAutopilot({
      state: { ...state, messages: [...state.messages, trigger] },
      roomId: 'room-team',
      limit: 5,
      sendMessage: async (_sendState, message) => ({
        ...message,
        id: `sent-${message.id}`,
        sentAt: '2026-05-04T20:45:02.000Z'
      })
    });

    expect(first.processedMessageIds).toContain('msg-autopilot-backlog');
    expect(first.sessions).toHaveLength(1);
    expect(first.messages).toHaveLength(1);
    expect(first.state.a2aSessions[0].contextIds).toContain('msg-autopilot-backlog');

    const second = await runPendingAgentAutopilot({
      state: first.state,
      roomId: 'room-team',
      limit: 5
    });

    expect(second.processedMessageIds).not.toContain('msg-autopilot-backlog');
    expect(second.sessions).toHaveLength(0);
    expect(second.messages).toHaveLength(0);
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
