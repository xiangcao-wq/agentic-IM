import { sortMessagesChronologically } from '../domain/messages';
import type {
  A2ASession,
  AgentActionLog,
  AgentAutopilotPolicy,
  AgentRunIntent,
  AgentRunResult,
  DemoState,
  Message,
  RiskAssessment
} from '../domain/types';
import type { AiProvider } from './aiProvider';
import { runAgentIntent } from './agentRunRuntime';
import type { WebSearchProvider } from './webSearch';

interface AgentAutopilotInput {
  state: DemoState;
  triggerMessage: Message;
  aiProvider?: AiProvider;
  webSearchProvider?: WebSearchProvider;
  sendMessage?: (state: DemoState, message: Message) => Promise<Message>;
}

export interface AgentAutopilotResult {
  state: DemoState;
  sessions: A2ASession[];
  messages: Message[];
  logs: AgentActionLog[];
  responses: AgentRunResult[];
}

export async function runAgentAutopilotForMessage(input: AgentAutopilotInput): Promise<AgentAutopilotResult> {
  if (input.triggerMessage.type === 'agent') {
    return emptyAutopilotResult(input.state);
  }

  const candidates = selectAutopilotCandidates(input.state, input.triggerMessage);
  if (candidates.length === 0) {
    return emptyAutopilotResult(input.state);
  }

  let state = input.state;
  const sessions: A2ASession[] = [];
  const messages: Message[] = [];
  const logs: AgentActionLog[] = [];
  const responses: AgentRunResult[] = [];

  for (const candidate of selectRunnableCandidates(candidates)) {
    const runtime = await runAgentIntent(
      state,
      {
        agentId: candidate.agentId,
        roomId: input.triggerMessage.roomId,
        intent: candidate.intent,
        userText: input.triggerMessage.body,
        targetUserId: input.triggerMessage.senderId
      },
      input.aiProvider,
      undefined,
      { webSearchProvider: input.webSearchProvider }
    );
    state = runtime.state;

    const deliveredMessage = runtime.response.message
      ? await deliverAutopilotMessage(state, runtime.response.message, input.sendMessage)
      : undefined;
    if (deliveredMessage) {
      messages.push(deliveredMessage);
      state = {
        ...state,
        messages: sortMessagesChronologically([
          ...state.messages.filter((message) => message.id !== deliveredMessage.id),
          deliveredMessage
        ])
      };
    }

    const session = createA2ASession({
      state,
      triggerMessage: input.triggerMessage,
      targetAgentId: candidate.agentId,
      response: runtime.response,
      deliveredMessage
    });
    const sessionLog = createA2ASessionLog(session, runtime.response.log);
    sessions.push(session);
    logs.push(sessionLog);
    responses.push(runtime.response);
    state = {
      ...state,
      a2aSessions: [session, ...(state.a2aSessions ?? [])],
      actionLogs: [sessionLog, ...state.actionLogs]
    };
  }

  return { state, sessions, messages, logs, responses };
}

function emptyAutopilotResult(state: DemoState): AgentAutopilotResult {
  return { state, sessions: [], messages: [], logs: [], responses: [] };
}

function selectAutopilotCandidates(
  state: DemoState,
  triggerMessage: Message
): Array<{ agentId: string; intent: AgentRunIntent; policy: AgentAutopilotPolicy; explicitlyMentioned: boolean }> {
  const intent = inferAutopilotIntent(triggerMessage.body);
  if (!intent) {
    return [];
  }

  return (state.agentAutopilotPolicies ?? [])
    .filter((policy) => policy.enabled)
    .filter((policy) => policy.allowedRoomIds.includes(triggerMessage.roomId))
    .filter((policy) => policyAllowsIntent(policy, intent))
    .filter((policy) => {
      const agent = state.agents.find((candidate) => candidate.id === policy.agentId);
      const owner = agent ? state.users.find((candidate) => candidate.id === agent.ownerId) : undefined;
      if (!agent || !owner || owner.id === triggerMessage.senderId) {
        return false;
      }
      return mentionsAgent(triggerMessage.body, agent.displayName, owner.name, owner.id) || intent === 'share_file';
    })
    .map((policy) => {
      const agent = state.agents.find((candidate) => candidate.id === policy.agentId);
      const owner = agent ? state.users.find((candidate) => candidate.id === agent.ownerId) : undefined;
      return {
        agentId: policy.agentId,
        intent,
        policy,
        explicitlyMentioned: Boolean(agent && owner && mentionsAgent(triggerMessage.body, agent.displayName, owner.name, owner.id))
      };
    });
}

function selectRunnableCandidates<T extends { explicitlyMentioned: boolean }>(candidates: T[]): T[] {
  const explicit = candidates.filter((candidate) => candidate.explicitlyMentioned);
  if (explicit.length > 0) {
    return explicit.slice(0, 3);
  }
  return candidates.slice(0, 1);
}

function inferAutopilotIntent(text: string): AgentRunIntent | undefined {
  const lowered = text.toLowerCase();
  if (includesAny(lowered, ['coordinate', 'reschedule', 'move the final review', 'move the meeting', 'negotiate'])) {
    return 'coordinate';
  }
  if (
    includesAny(lowered, ['send latest', 'send the latest', 'share latest', 'send file', 'share file', 'latest slides']) ||
    (includesAny(lowered, ['send', 'share']) && includesAny(lowered, ['file', 'slides', 'deck', 'plan']))
  ) {
    return 'share_file';
  }
  if (includesAny(lowered, ['deadline', 'due date', 'when is this due'])) {
    return 'deadline';
  }
  return undefined;
}

function policyAllowsIntent(policy: AgentAutopilotPolicy, intent: AgentRunIntent): boolean {
  if (intent === 'share_file') {
    return policy.allowedActions.includes('share_low_risk_files');
  }
  if (intent === 'coordinate') {
    return policy.allowedActions.includes('coordinate_schedule');
  }
  if (intent === 'deadline' || intent === 'find_file') {
    return policy.allowedActions.includes('search_files');
  }
  return policy.allowedActions.includes('reply');
}

function mentionsAgent(text: string, agentName: string, ownerName: string, ownerId: string): boolean {
  const lowered = text.toLowerCase();
  const ownerSlug = ownerId.replace(/^user-/, '').toLowerCase();
  return (
    lowered.includes(agentName.toLowerCase()) ||
    lowered.includes(ownerName.toLowerCase()) ||
    lowered.includes(ownerSlug) ||
    lowered.includes(`${ownerSlug} agent`)
  );
}

async function deliverAutopilotMessage(
  state: DemoState,
  message: Message,
  sendMessage: AgentAutopilotInput['sendMessage']
): Promise<Message> {
  return sendMessage ? sendMessage(state, message) : message;
}

function createA2ASession(input: {
  state: DemoState;
  triggerMessage: Message;
  targetAgentId: string;
  response: AgentRunResult;
  deliveredMessage?: Message;
}): A2ASession {
  const createdAt = new Date().toISOString();
  const initiatorAgentId = agentIdForSender(input.state, input.triggerMessage.senderId);
  const risk = input.response.log.risk;
  const status = input.response.requiresHuman
    ? 'needs_confirmation'
    : risk.level === 'high'
      ? 'blocked'
      : 'completed';

  return {
    id: `a2a-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    roomId: input.triggerMessage.roomId,
    initiatorAgentId,
    targetAgentIds: [input.targetAgentId],
    goal: input.triggerMessage.body,
    status,
    turns: [
      {
        id: `a2a-turn-${Date.now()}-0`,
        agentId: initiatorAgentId,
        kind: 'observation',
        message: input.triggerMessage.body,
        toolCalls: ['message.observe'],
        createdAt
      },
      {
        id: `a2a-turn-${Date.now()}-1`,
        agentId: input.targetAgentId,
        kind: input.response.requiresHuman ? 'proposal' : 'tool_result',
        message: summarizeAgentRunResponse(input.response, input.deliveredMessage),
        toolCalls: input.response.log.toolCalls,
        createdAt
      }
    ],
    proposedActionRequestIds: input.response.actionRequest ? [input.response.actionRequest.id] : [],
    contextIds: uniqueStrings([input.triggerMessage.id, ...input.response.log.contextIds]),
    risk,
    createdAt,
    updatedAt: createdAt
  };
}

function createA2ASessionLog(session: A2ASession, sourceLog: AgentActionLog): AgentActionLog {
  return {
    id: `log-${session.id}`,
    agentId: session.targetAgentIds[0] ?? sourceLog.agentId,
    roomId: session.roomId,
    action: `a2a_session:${session.status}:${session.goal}`,
    status: session.status === 'completed' ? 'executed' : session.status === 'blocked' ? 'blocked' : 'needs_confirmation',
    risk: session.risk,
    contextIds: session.contextIds,
    toolCalls: uniqueStrings(['a2a.session', ...sourceLog.toolCalls]),
    createdAt: session.createdAt
  };
}

function agentIdForSender(state: DemoState, senderId: string): string {
  return state.users.find((user) => user.id === senderId)?.agentId ?? `actor-${senderId}`;
}

function summarizeAgentRunResponse(response: AgentRunResult, deliveredMessage: Message | undefined): string {
  if (deliveredMessage) {
    return deliveredMessage.body;
  }
  if (response.actionRequest) {
    return `Needs confirmation: ${response.actionRequest.kind}`;
  }
  if (response.plan) {
    return response.plan;
  }
  return response.log.action;
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
