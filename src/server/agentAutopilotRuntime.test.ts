// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { AgentAutopilotAction, DemoState, Message } from '../domain/types';
import { runAgentAutopilotForMessage, runPendingAgentAutopilot, runPendingTaskFollowUps } from './agentAutopilotRuntime';

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

  it('executes a Chinese delegated image handoff when the image is real and authorized', async () => {
    const state = withDownloadableImage(createDemoState());
    const trigger: Message = {
      id: 'msg-autopilot-image-cn',
      roomId: 'room-team',
      senderId: 'user-chen',
      senderName: 'Chen Chen',
      body: '林雯现在睡觉了，能让 Lin Agent 把昨晚生成的图片发给陈晨吗？',
      sentAt: '2026-05-05T08:10:00.000Z',
      type: 'text'
    };

    const result = await runAgentAutopilotForMessage({
      state: { ...state, messages: [...state.messages, trigger] },
      triggerMessage: trigger,
      sendMessage: async (_sendState, message) => ({
        ...message,
        id: `sent-${message.id}`,
        sentAt: '2026-05-05T08:10:02.000Z'
      })
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      targetAgentIds: ['agent-lin'],
      status: 'completed'
    });
    expect(result.responses[0]).toMatchObject({
      intent: 'share_file',
      requiresHuman: false
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: 'file',
      sourceAgentId: 'agent-lin',
      fileId: 'file-lin-night-image'
    });
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

  it('starts one Chinese A2A meeting negotiation even when multiple Agents are mentioned', async () => {
    const state = enableAutopilot(createDemoState(), ['agent-lin', 'agent-chen']);
    const trigger: Message = {
      id: 'msg-autopilot-meeting-cn',
      roomId: 'room-team',
      senderId: 'user-zhao',
      senderName: 'Zhao Yiming',
      body: 'Lin Agent 和 Chen Agent，协商一下明天下午开会时间。',
      sentAt: '2026-05-04T20:36:30.000Z',
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
    expect(result.responses[0]).toMatchObject({
      intent: 'coordinate',
      requiresHuman: true
    });
    expect(result.state.actionRequests.filter((request) => request.kind === 'coordinate')).toHaveLength(1);
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

  it('creates a pending task follow-up session and confirmation request without mutating tasks', async () => {
    const base = enableAutopilot(createDemoState(), ['agent-chen']);
    const owner = base.users.find((user) => user.id === 'user-chen')!;
    const trigger: Message = {
      id: 'msg-task-follow-up-source',
      roomId: 'room-team',
      senderId: 'user-zhao',
      senderName: 'Zhao Yiming',
      body: 'Chen owns the interview appendix and should start before tomorrow evening.',
      sentAt: '2026-05-05T09:00:00+08:00',
      type: 'text'
    };
    const state: DemoState = {
      ...base,
      messages: [...base.messages, trigger],
      tasks: [
        ...base.tasks.map((task) => ({ ...task, status: 'done' as const })),
        {
          id: 'task-follow-up-interview-appendix',
          title: 'Interview appendix screenshots',
          deadline: '5月6日 18:00',
          owners: [owner.name],
          status: 'pending',
          sourceMessageId: trigger.id
        }
      ],
      agentAutopilotPolicies: base.agentAutopilotPolicies.map((policy) =>
        policy.agentId === 'agent-chen'
          ? {
              ...policy,
              enabled: true,
              allowedRoomIds: ['room-team'],
              allowedActions: [...new Set([...policy.allowedActions, 'suggest_task_updates'])] as AgentAutopilotAction[]
            }
          : policy
      )
    };

    const first = runPendingTaskFollowUps({
      state,
      roomId: 'room-team',
      now: '2026-05-05T12:00:00+08:00'
    });

    expect(first.processedTaskIds).toContain('task-follow-up-interview-appendix');
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0]).toMatchObject({
      status: 'needs_confirmation',
      targetAgentIds: ['agent-chen'],
      contextIds: expect.arrayContaining(['task-follow-up-interview-appendix', trigger.id])
    });
    expect(first.actionRequests).toHaveLength(1);
    expect(first.actionRequests[0]).toMatchObject({
      kind: 'task_update_suggest',
      agentId: 'agent-chen',
      input: {
        taskId: 'task-follow-up-interview-appendix',
        taskPatch: {
          taskId: 'task-follow-up-interview-appendix',
          oldStatus: 'pending',
          newStatus: 'in_progress'
        }
      }
    });
    expect(first.state.tasks.find((task) => task.id === 'task-follow-up-interview-appendix')?.status).toBe('pending');

    const second = runPendingTaskFollowUps({
      state: first.state,
      roomId: 'room-team',
      now: '2026-05-05T12:05:00+08:00'
    });
    expect(second.processedTaskIds).not.toContain('task-follow-up-interview-appendix');
    expect(second.sessions).toHaveLength(0);
    expect(second.actionRequests).toHaveLength(0);
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

function withDownloadableImage(state: DemoState): DemoState {
  return {
    ...state,
    files: [
      ...state.files,
      {
        id: 'file-lin-night-image',
        name: 'agent-im-a2a-demo-poster.svg',
        uploaderId: 'user-lin',
        version: 1,
        roomId: 'room-team',
        updatedAt: '2026-05-04T22:18:00+08:00',
        visibility: 'room',
        agentCanShare: true,
        tags: ['image', 'poster', '昨晚生成', '演示物料'],
        summary: '林雯昨晚生成的 A2A 演示海报图片，已授权 Agent 在本组范围内代发。',
        contentType: 'image/svg+xml',
        size: 4096,
        mxcUri: 'mxc://localhost/lin-night-image'
      }
    ]
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
