import { describe, expect, it } from 'vitest';
import type { RiskAssessment } from '../../domain/types';
import type { ToolPermissionDecision } from './permissionBroker';
import { createToolInvocationRecord } from './toolInvocationAudit';

const risk: RiskAssessment = {
  level: 'low',
  score: 0.1,
  reason: 'allowed',
  model: 'test-policy'
};

const permission: ToolPermissionDecision = {
  outcome: 'allow',
  toolName: 'message.send',
  agentId: 'agent-lin',
  roomId: 'room-team',
  requiredPermissions: ['message:send'],
  reasons: ['allowed'],
  risk,
  requiresHuman: false,
  reviewerIds: []
};

describe('tool invocation audit', () => {
  it('creates a completed invocation record', () => {
    const record = createToolInvocationRecord({
      id: 'tool-invocation-1',
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'completed',
      permission,
      inputSummary: { targetRoomId: 'room-team' },
      outputSummary: { messageId: 'msg-1' },
      evidenceIds: ['room-team', 'msg-1'],
      createdAt: '2026-05-09T00:00:00.000Z'
    });

    expect(record).toMatchObject({
      id: 'tool-invocation-1',
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'completed',
      permissionOutcome: 'allow',
      evidenceIds: ['room-team', 'msg-1'],
      inputSummary: { targetRoomId: 'room-team' },
      outputSummary: { messageId: 'msg-1' },
      createdAt: '2026-05-09T00:00:00.000Z'
    });
  });

  it('creates an awaiting permission record for ask decisions', () => {
    const record = createToolInvocationRecord({
      toolName: 'file.share',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'awaiting_permission',
      permission: {
        ...permission,
        outcome: 'ask',
        toolName: 'file.share',
        requiresHuman: true,
        reviewerIds: ['user-lin']
      },
      evidenceIds: ['file-slides-v3']
    });

    expect(record.id).toMatch(/^tool-invocation-/);
    expect(record.permissionOutcome).toBe('ask');
    expect(record.reviewerIds).toEqual(['user-lin']);
  });
});
