import { describe, expect, it } from 'vitest';
import type { RiskAssessment } from '../../domain/types';
import type { ToolPermissionDecision } from './permissionBroker';
import { createToolInvocationRecord, toolInvocationRecordToSnapshot } from './toolInvocationAudit';

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

  it('converts invocation records into transport-safe snapshots', () => {
    const record = createToolInvocationRecord({
      id: 'tool-invocation-snapshot',
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'completed',
      permission,
      inputSummary: {
        targetRoomId: 'room-team',
        nested: { values: ['initial'] }
      },
      outputSummary: { messageId: 'msg-1' },
      evidenceIds: ['room-team'],
      createdAt: '2026-05-09T00:00:00.000Z'
    });

    const snapshot = toolInvocationRecordToSnapshot(record);

    record.requiredPermissions.push('mutated:permission');
    record.reasons.push('mutated reason');
    (record.inputSummary.nested as { values: string[] }).values.push('mutated');

    expect(snapshot).toMatchObject({
      id: 'tool-invocation-snapshot',
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'completed',
      permissionOutcome: 'allow',
      requiredPermissions: ['message:send'],
      requiresHuman: false,
      reviewerIds: [],
      reasons: ['allowed'],
      evidenceIds: ['room-team'],
      inputSummary: {
        targetRoomId: 'room-team',
        nested: { values: ['initial'] }
      },
      outputSummary: { messageId: 'msg-1' },
      createdAt: '2026-05-09T00:00:00.000Z'
    });
  });

  it('sanitizes snapshot summaries into JSON-safe payloads', () => {
    const circular: Record<string, unknown> = { label: 'cycle' };
    circular.self = circular;

    const record = createToolInvocationRecord({
      id: 'tool-invocation-json-safe',
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'completed',
      permission,
      inputSummary: { targetRoomId: 'room-team' },
      outputSummary: { messageId: 'msg-1' },
      createdAt: '2026-05-09T00:00:00.000Z'
    });

    Object.assign(record.inputSummary, {
      keep: 'value',
      finiteNumber: 12,
      nonFiniteNumber: Number.POSITIVE_INFINITY,
      removeUndefined: undefined,
      removeFunction: () => 'unsupported',
      removeSymbol: Symbol('unsupported'),
      removeBigInt: BigInt(5),
      removeMap: new Map([['room', 'team']]),
      removeSet: new Set(['room-team']),
      nested: {
        keep: true,
        removeUndefined: undefined,
        removeBigInt: BigInt(6),
        removeMap: new Map([['nested', 'value']]),
        circular
      },
      list: [
        'ok',
        undefined,
        () => 'unsupported',
        Symbol('unsupported'),
        BigInt(7),
        new Map([['array', 'value']]),
        new Set(['array']),
        circular,
        Number.NaN,
        Number.NEGATIVE_INFINITY
      ]
    });
    record.outputSummary = {
      result: 'ok',
      removeBigInt: BigInt(8),
      removeMap: new Map([['output', 'value']])
    };

    const snapshot = toolInvocationRecordToSnapshot(record);

    expect(() => JSON.stringify(snapshot)).not.toThrow();
    expect(snapshot.inputSummary).toEqual({
      targetRoomId: 'room-team',
      keep: 'value',
      finiteNumber: 12,
      nonFiniteNumber: null,
      nested: {
        keep: true,
        circular: { label: 'cycle' }
      },
      list: ['ok', null, null, null, null, null, null, { label: 'cycle' }, null, null]
    });
    expect(snapshot.outputSummary).toEqual({ result: 'ok' });
    expect(Object.prototype.hasOwnProperty.call(snapshot.inputSummary, 'removeUndefined')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(snapshot.inputSummary, 'removeBigInt')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(snapshot.inputSummary, 'removeMap')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(snapshot.inputSummary, 'removeSet')).toBe(false);
  });

  it('omits absent optional fields from snapshots', () => {
    const record = createToolInvocationRecord({
      id: 'tool-invocation-validation-snapshot',
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'validation_failed',
      inputSummary: { targetRoomId: '' },
      createdAt: '2026-05-09T00:00:00.000Z'
    });

    const snapshot = toolInvocationRecordToSnapshot(record);

    expect(snapshot.status).toBe('validation_failed');
    expect(Object.prototype.hasOwnProperty.call(snapshot, 'permissionOutcome')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(snapshot, 'risk')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(snapshot, 'error')).toBe(false);
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
