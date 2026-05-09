import { describe, expect, it } from 'vitest';
import type { RiskAssessment } from '../../domain/types';
import type { PolicyDecision } from './policyEngine';
import { createToolPermissionDecision } from './permissionBroker';
import { getCoreTool } from './toolRegistry';

const lowRisk: RiskAssessment = {
  level: 'low',
  score: 0.1,
  reason: 'allowed',
  model: 'test-policy'
};

function policy(overrides: Partial<PolicyDecision>): PolicyDecision {
  return {
    outcome: 'allow',
    risk: lowRisk,
    reasons: ['allowed'],
    ...overrides
  };
}

describe('permission broker', () => {
  it('maps allow policies to allow permission decisions', () => {
    const decision = createToolPermissionDecision({
      tool: getCoreTool('message.send'),
      policy: policy({ outcome: 'allow' }),
      agentId: 'agent-lin',
      roomId: 'room-team'
    });

    expect(decision).toMatchObject({
      outcome: 'allow',
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      requiredPermissions: ['message:send'],
      reasons: ['allowed'],
      risk: lowRisk
    });
    expect(decision.requiresHuman).toBe(false);
  });

  it('maps deny policies to deny permission decisions', () => {
    const decision = createToolPermissionDecision({
      tool: getCoreTool('message.send'),
      policy: policy({ outcome: 'deny', reasons: ['target_room_not_authorized'] }),
      agentId: 'agent-lin',
      roomId: 'room-team'
    });

    expect(decision.outcome).toBe('deny');
    expect(decision.requiresHuman).toBe(false);
    expect(decision.reasons).toEqual(['target_room_not_authorized']);
  });

  it('maps require_confirmation policies to ask permission decisions', () => {
    const decision = createToolPermissionDecision({
      tool: getCoreTool('file.share'),
      policy: policy({
        outcome: 'require_confirmation',
        reasons: ['cross_room_file_share'],
        requiredReviewerIds: ['user-lin']
      }),
      agentId: 'agent-lin',
      roomId: 'room-team'
    });

    expect(decision).toMatchObject({
      outcome: 'ask',
      requiresHuman: true,
      reviewerIds: ['user-lin'],
      requiredPermissions: ['file:share']
    });
  });
});
