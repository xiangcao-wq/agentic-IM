import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentTrace } from '../domain/types';
import { buildAgentTimelineItems, buildPermissionCenterItems } from './agentTimeline';

describe('agent timeline view models', () => {
  it('builds timeline rows without exposing raw progress events', () => {
    const trace = traceWith([
      event(1, { type: 'agent.run.created', label: 'created' }),
      event(2, { type: 'agent.progress', label: 'raw planning detail', phase: 'planning' }),
      event(3, {
        type: 'agent.tool.requested',
        label: 'Tool requested: message.send',
        detail: 'tool-invocation-1',
        toolCalls: ['message.send'],
        payload: {
          toolName: 'message.send',
          invocationId: 'tool-invocation-1'
        }
      }),
      event(4, {
        type: 'agent.permission.allowed',
        label: 'Permission allowed: message.send',
        detail: 'policy allow',
        toolCalls: ['message.send'],
        riskLevel: 'low',
        payload: {
          invocationId: 'tool-invocation-1',
          toolName: 'message.send',
          permissionOutcome: 'allow',
          requiredPermissions: ['message:send'],
          requiresHuman: false,
          reasons: ['policy allow']
        }
      }),
      event(5, {
        type: 'agent.tool.completed',
        label: 'Tool completed: message.send',
        toolCalls: ['message.send'],
        payload: {
          invocationId: 'tool-invocation-1',
          toolName: 'message.send',
          status: 'completed'
        }
      }),
      event(6, { type: 'agent.run.completed', label: 'done' })
    ]);

    const rows = buildAgentTimelineItems(trace);

    expect(rows.map((row) => row.title)).toEqual([
      'Run queued',
      'Tool requested',
      'Permission allowed',
      'Tool completed',
      'Run completed'
    ]);
    expect(rows.map((row) => row.detail).join(' ')).not.toContain('raw planning detail');
    expect(rows[2]).toMatchObject({
      toolName: 'message.send',
      riskLevel: 'low',
      tone: 'success'
    });
  });

  it('builds permission rows for allow, deny, and ask decisions', () => {
    const trace = traceWith([
      permissionEvent(1, 'agent.permission.allowed', 'allow', 'message.send', 'policy allow', ['message:send'], false),
      permissionEvent(2, 'agent.permission.denied', 'deny', 'file.share', 'target room blocked', ['file:share'], false),
      permissionEvent(3, 'agent.permission.requested', 'ask', 'file.share', 'needs owner review', ['file:share'], true)
    ]);

    const permissions = buildPermissionCenterItems(trace);

    expect(permissions).toEqual([
      expect.objectContaining({
        invocationId: 'invocation-1',
        toolName: 'message.send',
        outcome: 'allow',
        label: 'Allowed',
        requiredPermissions: ['message:send'],
        requiresHuman: false,
        reason: 'policy allow'
      }),
      expect.objectContaining({
        invocationId: 'invocation-2',
        toolName: 'file.share',
        outcome: 'deny',
        label: 'Denied',
        reason: 'target room blocked'
      }),
      expect.objectContaining({
        invocationId: 'invocation-3',
        toolName: 'file.share',
        outcome: 'ask',
        label: 'Needs review',
        requiresHuman: true,
        reason: 'needs owner review'
      })
    ]);
  });

  it('returns empty arrays without a trace', () => {
    expect(buildAgentTimelineItems(null)).toEqual([]);
    expect(buildPermissionCenterItems(undefined)).toEqual([]);
  });
});

function permissionEvent(
  sequence: number,
  type: AgentEvent['type'],
  outcome: 'allow' | 'deny' | 'ask',
  toolName: string,
  reason: string,
  requiredPermissions: string[],
  requiresHuman: boolean
): AgentEvent {
  return event(sequence, {
    type,
    label: `${type}: ${toolName}`,
    detail: reason,
    toolCalls: [toolName],
    riskLevel: outcome === 'deny' ? 'high' : outcome === 'ask' ? 'medium' : 'low',
    payload: {
      invocationId: `invocation-${sequence}`,
      toolName,
      permissionOutcome: outcome,
      requiredPermissions,
      requiresHuman,
      reviewerIds: requiresHuman ? ['user-lin'] : [],
      reasons: [reason]
    }
  });
}

function traceWith(events: AgentEvent[]): AgentTrace {
  return {
    runId: 'agent-run-ui',
    sessionId: 'agent-session-ui',
    tenantId: 'local',
    agentId: 'agent-lin',
    roomId: 'room-team',
    status: 'completed',
    startedAt: events[0]?.createdAt,
    finishedAt: events.at(-1)?.createdAt,
    phases: [],
    toolCalls: [...new Set(events.flatMap((item) => item.toolCalls))],
    eventCount: events.length,
    events
  };
}

function event(sequence: number, overrides: Partial<AgentEvent>): AgentEvent {
  return {
    id: `agent-run-ui-event-${String(sequence).padStart(8, '0')}`,
    sequence,
    cursor: `seq:${sequence}`,
    type: 'agent.run.created',
    tenantId: 'local',
    sessionId: 'agent-session-ui',
    runId: 'agent-run-ui',
    agentId: 'agent-lin',
    roomId: 'room-team',
    visibility: 'audit',
    toolCalls: [],
    payload: {},
    createdAt: `2026-05-09T00:00:0${sequence}.000Z`,
    ...overrides
  };
}
