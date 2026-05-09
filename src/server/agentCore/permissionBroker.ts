import type { RiskAssessment } from '../../domain/types';
import type { PolicyDecision } from './policyEngine';
import type { AgentCoreToolDefinition, AgentCoreToolName } from './toolRegistry';

export type ToolPermissionOutcome = 'allow' | 'deny' | 'ask';

export interface ToolPermissionDecision {
  outcome: ToolPermissionOutcome;
  toolName: AgentCoreToolName;
  agentId: string;
  roomId: string;
  requiredPermissions: string[];
  reasons: string[];
  risk: RiskAssessment;
  requiresHuman: boolean;
  reviewerIds: string[];
}

export interface CreateToolPermissionDecisionInput {
  tool: AgentCoreToolDefinition<unknown>;
  policy: PolicyDecision;
  agentId: string;
  roomId: string;
}

export function createToolPermissionDecision(input: CreateToolPermissionDecisionInput): ToolPermissionDecision {
  const outcome = mapPolicyOutcome(input.policy.outcome);

  return {
    outcome,
    toolName: input.tool.name,
    agentId: input.agentId,
    roomId: input.roomId,
    requiredPermissions: [...input.tool.permission.requiredPermissions],
    reasons: [...input.policy.reasons],
    risk: input.policy.risk,
    requiresHuman: outcome === 'ask',
    reviewerIds: [...(input.policy.requiredReviewerIds ?? [])]
  };
}

function mapPolicyOutcome(outcome: PolicyDecision['outcome']): ToolPermissionOutcome {
  if (outcome === 'require_confirmation') {
    return 'ask';
  }

  return outcome;
}
