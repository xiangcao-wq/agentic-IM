import type {
  AgentActionKind,
  AgentActionRequest,
  DemoState,
  RiskAssessment
} from './types';

interface EnqueueAgentActionInput {
  id?: string;
  agentId: string;
  roomId: string;
  kind: AgentActionKind;
  input: Record<string, unknown>;
  createdAt?: string;
}

interface UpdateActionInput {
  updatedAt?: string;
}

interface CompleteActionInput extends UpdateActionInput {
  logId: string;
  risk?: RiskAssessment;
}

interface BlockActionInput extends UpdateActionInput {
  logId?: string;
  risk: RiskAssessment;
}

interface RejectActionInput extends UpdateActionInput {
  logId: string;
  risk?: RiskAssessment;
}

export function enqueueAgentAction(
  state: DemoState,
  input: EnqueueAgentActionInput
): { state: DemoState; request: AgentActionRequest } {
  const now = input.createdAt ?? new Date().toISOString();
  const request: AgentActionRequest = {
    id: input.id ?? `action-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    agentId: input.agentId,
    roomId: input.roomId,
    kind: input.kind,
    status: 'pending',
    input: input.input,
    createdAt: now,
    updatedAt: now,
    requiresHuman: false
  };

  return {
    state: {
      ...state,
      actionRequests: [request, ...state.actionRequests]
    },
    request
  };
}

export function requireActionConfirmation(
  state: DemoState,
  actionId: string,
  risk: RiskAssessment,
  input: UpdateActionInput = {}
): { state: DemoState; request: AgentActionRequest } {
  return updateActionRequest(state, actionId, (request) => ({
    ...request,
    status: 'needs_confirmation',
    risk,
    requiresHuman: true,
    updatedAt: input.updatedAt ?? new Date().toISOString()
  }));
}

export function completeAgentAction(
  state: DemoState,
  actionId: string,
  input: CompleteActionInput
): { state: DemoState; request: AgentActionRequest } {
  return updateActionRequest(state, actionId, (request) => ({
    ...request,
    status: 'executed',
    risk: input.risk ?? request.risk,
    requiresHuman: false,
    logId: input.logId,
    updatedAt: input.updatedAt ?? new Date().toISOString()
  }));
}

export function blockAgentAction(
  state: DemoState,
  actionId: string,
  input: BlockActionInput
): { state: DemoState; request: AgentActionRequest } {
  return updateActionRequest(state, actionId, (request) => ({
    ...request,
    status: 'blocked',
    risk: input.risk,
    requiresHuman: true,
    logId: input.logId,
    updatedAt: input.updatedAt ?? new Date().toISOString()
  }));
}

export function rejectAgentAction(
  state: DemoState,
  actionId: string,
  input: RejectActionInput
): { state: DemoState; request: AgentActionRequest } {
  return updateActionRequest(state, actionId, (request) => ({
    ...request,
    status: 'rejected',
    risk: input.risk ?? request.risk,
    requiresHuman: false,
    logId: input.logId,
    updatedAt: input.updatedAt ?? new Date().toISOString()
  }));
}

function updateActionRequest(
  state: DemoState,
  actionId: string,
  update: (request: AgentActionRequest) => AgentActionRequest
): { state: DemoState; request: AgentActionRequest } {
  let updatedRequest: AgentActionRequest | undefined;
  const actionRequests = state.actionRequests.map((request) => {
    if (request.id !== actionId) {
      return request;
    }
    updatedRequest = update(request);
    return updatedRequest;
  });

  if (!updatedRequest) {
    throw new Error(`unknown action request: ${actionId}`);
  }

  return {
    state: {
      ...state,
      actionRequests
    },
    request: updatedRequest
  };
}
