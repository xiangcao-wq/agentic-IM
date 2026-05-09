import { describe, expect, it } from 'vitest';
import type { AgentToolInvocationSnapshot } from '../../domain/types';
import { toolInvocationToEventDrafts } from './toolEventAdapter';

const context = {
  tenantId: 'local',
  sessionId: 'session-1',
  runId: 'run-1'
};

const baseInvocation: AgentToolInvocationSnapshot = {
  id: 'tool-invocation-1',
  toolName: 'message.send',
  agentId: 'agent-lin',
  roomId: 'room-team',
  status: 'completed',
  permissionOutcome: 'allow',
  requiredPermissions: ['message:send'],
  requiresHuman: false,
  risk: {
    level: 'low',
    score: 0.1,
    reason: 'allowed',
    model: 'test-policy'
  },
  reviewerIds: [],
  reasons: ['allowed'],
  evidenceIds: ['room-team'],
  inputSummary: { targetRoomId: 'room-team' },
  outputSummary: { messageId: 'msg-1' },
  createdAt: '2026-05-09T00:00:00.000Z'
};

describe('tool invocation event adapter', () => {
  it('maps allowed completed invocations to requested, permission, and completed events', () => {
    const drafts = toolInvocationToEventDrafts(context, baseInvocation);

    expect(drafts.map((draft) => draft.type)).toEqual([
      'agent.tool.requested',
      'agent.permission.allowed',
      'agent.tool.completed'
    ]);
    expect(drafts.every((draft) => draft.visibility === 'audit')).toBe(true);
    expect(drafts.every((draft) => draft.toolCalls.includes('message.send'))).toBe(true);
    expect(drafts[0]).toMatchObject({
      tenantId: 'local',
      sessionId: 'session-1',
      runId: 'run-1',
      agentId: 'agent-lin',
      roomId: 'room-team',
      riskLevel: 'low'
    });
    expect(drafts[1].payload).toMatchObject({
      invocationId: 'tool-invocation-1',
      permissionOutcome: 'allow',
      requiredPermissions: ['message:send'],
      requiresHuman: false
    });
    expect(drafts[2].payload).toMatchObject({
      invocationId: 'tool-invocation-1',
      status: 'completed',
      outputSummary: { messageId: 'msg-1' }
    });
  });

  it('maps allowed failed invocations to requested, permission, and failed events', () => {
    const drafts = toolInvocationToEventDrafts(context, {
      ...baseInvocation,
      id: 'tool-invocation-failed',
      status: 'failed',
      error: 'Matrix send failed'
    });

    expect(drafts.map((draft) => draft.type)).toEqual([
      'agent.tool.requested',
      'agent.permission.allowed',
      'agent.tool.failed'
    ]);
    expect(drafts[2].payload).toMatchObject({
      invocationId: 'tool-invocation-failed',
      status: 'failed',
      error: 'Matrix send failed',
      eventKind: 'agent.tool.failed'
    });
  });

  it('maps ask decisions to requested and permission requested without a terminal tool event', () => {
    const drafts = toolInvocationToEventDrafts(context, {
      ...baseInvocation,
      id: 'tool-invocation-ask',
      toolName: 'file.share',
      status: 'awaiting_permission',
      permissionOutcome: 'ask',
      requiredPermissions: ['file:share'],
      requiresHuman: true,
      reviewerIds: ['user-lin'],
      reasons: ['missing_downloadable_file_backing']
    });

    expect(drafts.map((draft) => draft.type)).toEqual([
      'agent.tool.requested',
      'agent.permission.requested'
    ]);
    expect(drafts[1].payload).toMatchObject({
      invocationId: 'tool-invocation-ask',
      permissionOutcome: 'ask',
      requiredPermissions: ['file:share'],
      requiresHuman: true,
      reviewerIds: ['user-lin']
    });
  });

  it('maps denied decisions to permission denied and failed tool events', () => {
    const drafts = toolInvocationToEventDrafts(context, {
      ...baseInvocation,
      id: 'tool-invocation-denied',
      status: 'denied',
      permissionOutcome: 'deny',
      risk: {
        level: 'high',
        score: 0.9,
        reason: 'blocked',
        model: 'test-policy'
      },
      reasons: ['target_room_not_authorized']
    });

    expect(drafts.map((draft) => draft.type)).toEqual([
      'agent.tool.requested',
      'agent.permission.denied',
      'agent.tool.failed'
    ]);
    expect(drafts[2].riskLevel).toBe('high');
    expect(drafts[2].payload).toMatchObject({
      invocationId: 'tool-invocation-denied',
      status: 'denied',
      reasons: ['target_room_not_authorized']
    });
  });

  it('maps validation failures without permission events', () => {
    const drafts = toolInvocationToEventDrafts(context, {
      ...baseInvocation,
      id: 'tool-invocation-validation',
      status: 'validation_failed',
      permissionOutcome: undefined,
      requiredPermissions: [],
      reasons: [],
      error: 'messageBody must be a non-empty string'
    });

    expect(drafts.map((draft) => draft.type)).toEqual([
      'agent.tool.requested',
      'agent.tool.failed'
    ]);
    expect(drafts[1].payload).toMatchObject({
      invocationId: 'tool-invocation-validation',
      status: 'validation_failed',
      error: 'messageBody must be a non-empty string'
    });
  });

  it('defensively clones invocation payloads', () => {
    const invocation: AgentToolInvocationSnapshot = {
      ...baseInvocation,
      inputSummary: { nested: { values: ['initial'] } }
    };

    const drafts = toolInvocationToEventDrafts(context, invocation);

    (invocation.inputSummary.nested as { values: string[] }).values.push('mutated');
    invocation.requiredPermissions.push('mutated:permission');

    expect(drafts[0].payload).toMatchObject({
      invocation: {
        requiredPermissions: ['message:send'],
        inputSummary: { nested: { values: ['initial'] } }
      }
    });
  });

  it('sanitizes payloads so circular values and bigint can be stringified', () => {
    const circular: Record<string, unknown> = { kept: 'value' };
    circular.self = circular;

    const drafts = toolInvocationToEventDrafts(context, {
      ...baseInvocation,
      inputSummary: {
        circular,
        count: BigInt(42)
      },
      outputSummary: {
        values: [BigInt(1), 'done']
      }
    });

    expect(() => JSON.stringify(drafts.map((draft) => draft.payload))).not.toThrow();
    expect(drafts[0].payload).toMatchObject({
      inputSummary: {
        circular: { kept: 'value' },
        count: '42'
      },
      outputSummary: {
        values: ['1', 'done']
      }
    });
  });
});
