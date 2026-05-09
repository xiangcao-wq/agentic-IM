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
      requiredPermissions: ['message:send'],
      requiresHuman: false,
      risk,
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
    expect(record.requiredPermissions).toEqual(['message:send']);
    expect(record.requiresHuman).toBe(true);
    expect(record.risk).toEqual(risk);
    expect(record.reviewerIds).toEqual(['user-lin']);
  });

  it('deep clones JSON-safe summary payloads', () => {
    const inputSummary = {
      request: {
        targetRoomId: 'room-team',
        labels: ['initial']
      }
    };
    const outputSummary = {
      response: {
        message: {
          id: 'msg-1'
        }
      }
    };

    const record = createToolInvocationRecord({
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'completed',
      inputSummary,
      outputSummary
    });

    inputSummary.request.labels.push('mutated');
    outputSummary.response.message.id = 'msg-mutated';

    expect(record.inputSummary).toEqual({
      request: {
        targetRoomId: 'room-team',
        labels: ['initial']
      }
    });
    expect(record.outputSummary).toEqual({
      response: {
        message: {
          id: 'msg-1'
        }
      }
    });
  });

  it('creates a denied record with permission audit details and error', () => {
    const deniedRisk: RiskAssessment = {
      level: 'high',
      score: 0.9,
      reason: 'external share blocked',
      model: 'test-policy'
    };
    const deniedPermission: ToolPermissionDecision = {
      ...permission,
      outcome: 'deny',
      toolName: 'file.share',
      requiredPermissions: ['file:share'],
      reasons: ['external share blocked'],
      risk: deniedRisk,
      reviewerIds: ['security-reviewer']
    };

    const record = createToolInvocationRecord({
      toolName: 'file.share',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'denied',
      permission: deniedPermission,
      evidenceIds: ['file-slides-v3'],
      error: 'permission denied'
    });

    deniedPermission.requiredPermissions.push('mutated:permission');
    deniedRisk.reason = 'mutated risk';

    expect(record).toMatchObject({
      toolName: 'file.share',
      status: 'denied',
      permissionOutcome: 'deny',
      requiredPermissions: ['file:share'],
      requiresHuman: false,
      risk: {
        level: 'high',
        score: 0.9,
        reason: 'external share blocked',
        model: 'test-policy'
      },
      reasons: ['external share blocked'],
      reviewerIds: ['security-reviewer'],
      evidenceIds: ['file-slides-v3'],
      error: 'permission denied'
    });
  });

  it('creates a validation failed record with default permission details and error', () => {
    const record = createToolInvocationRecord({
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'validation_failed',
      inputSummary: { targetRoomId: '' },
      error: 'targetRoomId must be a non-empty string'
    });

    expect(record).toMatchObject({
      toolName: 'message.send',
      status: 'validation_failed',
      requiredPermissions: [],
      requiresHuman: false,
      reviewerIds: [],
      reasons: [],
      evidenceIds: [],
      inputSummary: { targetRoomId: '' },
      outputSummary: {},
      error: 'targetRoomId must be a non-empty string'
    });
    expect(record.permissionOutcome).toBeUndefined();
    expect(record.risk).toBeUndefined();
  });

  it('creates a failed record with permission audit details and error', () => {
    const record = createToolInvocationRecord({
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'failed',
      permission,
      inputSummary: { targetRoomId: 'room-team' },
      outputSummary: { attemptId: 'attempt-1' },
      error: 'transport unavailable'
    });

    expect(record).toMatchObject({
      toolName: 'message.send',
      status: 'failed',
      permissionOutcome: 'allow',
      requiredPermissions: ['message:send'],
      requiresHuman: false,
      risk,
      inputSummary: { targetRoomId: 'room-team' },
      outputSummary: { attemptId: 'attempt-1' },
      error: 'transport unavailable'
    });
  });
});
