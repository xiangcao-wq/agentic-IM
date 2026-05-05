import { sortMessagesChronologically } from '../domain/messages';
import type {
  A2ASession,
  A2ATurnKind,
  AgentActionLog,
  AgentActionRequest,
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

interface CalendarPatch {
  itemId: string;
  oldStartsAt: string;
  newStartsAt: string;
  title: string;
}

interface NegotiationConstraint {
  agentId: string;
  ownerId: string;
  status: 'accepted' | 'counter_proposal';
  message: string;
  conflictCalendarId?: string;
  conflictTitle?: string;
  counterProposalStartsAt?: string;
}

interface ScheduleNegotiation {
  finalStartsAt: string;
  constraints: NegotiationConstraint[];
}

export interface AgentAutopilotResult {
  state: DemoState;
  sessions: A2ASession[];
  messages: Message[];
  logs: AgentActionLog[];
  responses: AgentRunResult[];
}

export interface PendingAgentAutopilotInput extends Omit<AgentAutopilotInput, 'triggerMessage'> {
  roomId?: string;
  limit?: number;
}

export interface PendingAgentAutopilotResult extends AgentAutopilotResult {
  processedMessageIds: string[];
  skippedMessageIds: string[];
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
    const targetUserId =
      candidate.intent === 'coordinate'
        ? inferMentionedTargetUserId(state, input.triggerMessage.body, candidate.agentId) ?? input.triggerMessage.senderId
        : input.triggerMessage.senderId;
    const runtime = await runAgentIntent(
      state,
      {
        agentId: candidate.agentId,
        roomId: input.triggerMessage.roomId,
        intent: candidate.intent,
        userText: input.triggerMessage.body,
        targetUserId
      },
      input.aiProvider,
      undefined,
      { webSearchProvider: input.webSearchProvider }
    );
    state = runtime.state;
    const negotiated = applyScheduleNegotiation(state, input.triggerMessage, candidate.agentId, runtime.response);
    state = negotiated.state;
    const response = negotiated.response;

    const outboundMessage =
      response.message ?? createAutopilotTextMessage(state, candidate.agentId, input.triggerMessage, response);
    const deliveredMessage = outboundMessage
      ? await deliverAutopilotMessage(state, outboundMessage, input.sendMessage)
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
      response,
      deliveredMessage
    });
    const sessionLog = createA2ASessionLog(session, response.log);
    sessions.push(session);
    logs.push(sessionLog);
    responses.push(response);
    state = {
      ...state,
      a2aSessions: [session, ...(state.a2aSessions ?? [])],
      actionLogs: [sessionLog, ...state.actionLogs]
    };
  }

  return { state, sessions, messages, logs, responses };
}

export async function runPendingAgentAutopilot(input: PendingAgentAutopilotInput): Promise<PendingAgentAutopilotResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
  const alreadyProcessed = processedAutopilotMessageIds(input.state);
  const candidates = sortMessagesChronologically(input.state.messages)
    .filter((message) => message.type !== 'agent')
    .filter((message) => !input.roomId || message.roomId === input.roomId)
    .filter((message) => !alreadyProcessed.has(message.id))
    .slice(-limit);

  let state = input.state;
  const sessions: A2ASession[] = [];
  const messages: Message[] = [];
  const logs: AgentActionLog[] = [];
  const responses: AgentRunResult[] = [];
  const processedMessageIds: string[] = [];
  const skippedMessageIds: string[] = [];

  for (const triggerMessage of candidates) {
    const result = await runAgentAutopilotForMessage({
      state,
      triggerMessage,
      aiProvider: input.aiProvider,
      webSearchProvider: input.webSearchProvider,
      sendMessage: input.sendMessage
    });
    state = result.state;
    if (result.sessions.length > 0) {
      processedMessageIds.push(triggerMessage.id);
      sessions.push(...result.sessions);
      messages.push(...result.messages);
      logs.push(...result.logs);
      responses.push(...result.responses);
    } else {
      skippedMessageIds.push(triggerMessage.id);
    }
  }

  return { state, sessions, messages, logs, responses, processedMessageIds, skippedMessageIds };
}

function processedAutopilotMessageIds(state: DemoState): Set<string> {
  return new Set(
    (state.a2aSessions ?? [])
      .flatMap((session) => session.contextIds)
      .filter((contextId) => state.messages.some((message) => message.id === contextId))
  );
}

function emptyAutopilotResult(state: DemoState): AgentAutopilotResult {
  return { state, sessions: [], messages: [], logs: [], responses: [] };
}

function selectAutopilotCandidates(
  state: DemoState,
  triggerMessage: Message
): Array<{ agentId: string; intent: AgentRunIntent; policy: AgentAutopilotPolicy; explicitlyMentioned: boolean }> {
  const inferredIntent = inferAutopilotIntent(triggerMessage.body);
  return (state.agentAutopilotPolicies ?? [])
    .filter((policy) => policy.enabled)
    .filter((policy) => policy.allowedRoomIds.includes(triggerMessage.roomId))
    .flatMap((policy) => {
      const agent = state.agents.find((candidate) => candidate.id === policy.agentId);
      const owner = agent ? state.users.find((candidate) => candidate.id === agent.ownerId) : undefined;
      if (!agent || !owner || owner.id === triggerMessage.senderId) {
        return [];
      }
      const explicitlyMentioned = mentionsAgent(triggerMessage.body, agent.displayName, owner.name, owner.id);
      const explicitAgentMention = mentionsAgentDirectly(triggerMessage.body, agent.displayName, owner.name, owner.id);
      const intent = inferredIntent ?? (explicitAgentMention ? 'chat' : undefined);
      if (!intent || !policyAllowsIntent(policy, intent)) {
        return [];
      }
      if (!explicitlyMentioned && intent !== 'share_file') {
        return [];
      }
      return {
        agentId: policy.agentId,
        intent,
        policy,
        explicitlyMentioned
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

function mentionsAgentDirectly(text: string, agentName: string, ownerName: string, ownerId: string): boolean {
  const lowered = text.toLowerCase();
  const ownerSlug = ownerId.replace(/^user-/, '').toLowerCase();
  const normalizedOwnerName = ownerName.toLowerCase();
  return (
    lowered.includes(agentName.toLowerCase()) ||
    lowered.includes(`${normalizedOwnerName} agent`) ||
    lowered.includes(`${normalizedOwnerName}的 agent`) ||
    lowered.includes(`${ownerSlug} agent`) ||
    lowered.includes(`${ownerSlug}'s agent`)
  );
}

function inferMentionedTargetUserId(state: DemoState, text: string, actingAgentId: string): string | undefined {
  const actingAgent = state.agents.find((agent) => agent.id === actingAgentId);
  const lowered = text.toLowerCase();
  return state.users.find((user) => {
    if (user.id === actingAgent?.ownerId) {
      return false;
    }
    const userAgent = state.agents.find((agent) => agent.id === user.agentId);
    const ownerSlug = user.id.replace(/^user-/, '').toLowerCase();
    return (
      lowered.includes(user.name.toLowerCase()) ||
      lowered.includes(ownerSlug) ||
      Boolean(userAgent && lowered.includes(userAgent.displayName.toLowerCase())) ||
      lowered.includes(`${ownerSlug} agent`)
    );
  })?.id;
}

async function deliverAutopilotMessage(
  state: DemoState,
  message: Message,
  sendMessage: AgentAutopilotInput['sendMessage']
): Promise<Message> {
  return sendMessage ? sendMessage(state, message) : message;
}

function createAutopilotTextMessage(
  state: DemoState,
  agentId: string,
  triggerMessage: Message,
  response: AgentRunResult
): Message | undefined {
  if (response.intent !== 'chat' || response.requiresHuman) {
    return undefined;
  }
  const reply = typeof (response.result as { reply?: unknown } | undefined)?.reply === 'string'
    ? (response.result as { reply: string }).reply.trim()
    : '';
  if (!reply) {
    return undefined;
  }
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  const owner = agent ? state.users.find((candidate) => candidate.id === agent.ownerId) : undefined;
  if (!agent || !owner) {
    return undefined;
  }

  return {
    id: `msg-agent-chat-${triggerMessage.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    roomId: triggerMessage.roomId,
    senderId: owner.id,
    senderName: agent.displayName,
    body: reply,
    sentAt: new Date().toISOString(),
    type: 'agent',
    agentLabel: `${owner.name}的 Agent`,
    sourceAgentId: agent.id
  };
}

function applyScheduleNegotiation(
  state: DemoState,
  triggerMessage: Message,
  primaryAgentId: string,
  response: AgentRunResult
): { state: DemoState; response: AgentRunResult } {
  if (response.intent !== 'coordinate' || !response.requiresHuman || !response.actionRequest) {
    return { state, response };
  }
  const patch = parseCalendarPatch(response.actionRequest.input.calendarPatch);
  if (!patch) {
    return { state, response };
  }

  const targetAgentIds = selectA2ATargetAgentIds(state, triggerMessage, primaryAgentId, response);
  const constraints = targetAgentIds.map((agentId) => buildScheduleConstraint(state, agentId, patch));
  const counterProposal = constraints.find((constraint) => constraint.counterProposalStartsAt);
  if (!counterProposal?.counterProposalStartsAt) {
    const negotiation: ScheduleNegotiation = {
      finalStartsAt: patch.newStartsAt,
      constraints
    };
    return updateNegotiatedActionRequest(state, response, patch, negotiation);
  }

  const negotiatedPatch = {
    ...patch,
    newStartsAt: counterProposal.counterProposalStartsAt
  };
  const negotiation: ScheduleNegotiation = {
    finalStartsAt: negotiatedPatch.newStartsAt,
    constraints
  };
  return updateNegotiatedActionRequest(state, response, negotiatedPatch, negotiation);
}

function updateNegotiatedActionRequest(
  state: DemoState,
  response: AgentRunResult,
  patch: CalendarPatch,
  negotiation: ScheduleNegotiation
): { state: DemoState; response: AgentRunResult } {
  if (!response.actionRequest) {
    return { state, response };
  }
  const actionRequest: AgentActionRequest = {
    ...response.actionRequest,
    input: {
      ...response.actionRequest.input,
      calendarPatch: patch,
      negotiation
    }
  };
  const nextState = {
    ...state,
    actionRequests: state.actionRequests.map((request) =>
      request.id === actionRequest.id ? actionRequest : request
    )
  };
  const result = response.result && 'proposedPlan' in response.result
    ? {
        ...response.result,
        proposedPlan:
          negotiation.finalStartsAt === patch.newStartsAt
            ? `${response.result.proposedPlan}\nNegotiated target time: ${patch.newStartsAt}.`
            : response.result.proposedPlan
      }
    : response.result;
  return {
    state: nextState,
    response: {
      ...response,
      result,
      actionRequest
    }
  };
}

function buildScheduleConstraint(state: DemoState, agentId: string, patch: CalendarPatch): NegotiationConstraint {
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  const ownerId = agent?.ownerId ?? agentId;
  const conflict = state.calendar.find(
    (item) => item.startsAt === patch.newStartsAt && item.attendees.includes(ownerId)
  );
  if (conflict) {
    const counterProposalStartsAt = suggestCounterProposalStartsAt(patch.newStartsAt);
    return {
      agentId,
      ownerId,
      status: 'counter_proposal',
      conflictCalendarId: conflict.id,
      conflictTitle: conflict.title,
      counterProposalStartsAt,
      message: `${agent?.displayName ?? agentId} found a conflict with "${conflict.title}" at ${formatIsoTime(patch.newStartsAt)} and counter-proposes ${formatIsoTime(counterProposalStartsAt)}.`
    };
  }

  return {
    agentId,
    ownerId,
    status: 'accepted',
    message: `${agent?.displayName ?? agentId} checked authorized calendar context and accepts ${formatIsoTime(patch.newStartsAt)} pending human confirmation.`
  };
}

function parseCalendarPatch(value: unknown): CalendarPatch | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const patch = value as Record<string, unknown>;
  if (
    typeof patch.itemId !== 'string' ||
    typeof patch.oldStartsAt !== 'string' ||
    typeof patch.newStartsAt !== 'string' ||
    typeof patch.title !== 'string'
  ) {
    return undefined;
  }
  return {
    itemId: patch.itemId,
    oldStartsAt: patch.oldStartsAt,
    newStartsAt: patch.newStartsAt,
    title: patch.title
  };
}

function parseScheduleNegotiation(value: unknown): ScheduleNegotiation | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const negotiation = value as Record<string, unknown>;
  if (typeof negotiation.finalStartsAt !== 'string' || !Array.isArray(negotiation.constraints)) {
    return undefined;
  }
  return {
    finalStartsAt: negotiation.finalStartsAt,
    constraints: negotiation.constraints.filter(isNegotiationConstraint)
  };
}

function isNegotiationConstraint(value: unknown): value is NegotiationConstraint {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const constraint = value as Record<string, unknown>;
  return (
    typeof constraint.agentId === 'string' &&
    typeof constraint.ownerId === 'string' &&
    (constraint.status === 'accepted' || constraint.status === 'counter_proposal') &&
    typeof constraint.message === 'string'
  );
}

function suggestCounterProposalStartsAt(startsAt: string): string {
  const match = startsAt.match(/^(.*T)(\d{2}):(\d{2})(:\d{2}(?:[+-]\d{2}:\d{2}|Z))$/);
  if (!match) {
    return startsAt;
  }
  const hour = Number(match[2]);
  const minute = match[3];
  if (hour < 23) {
    return `${match[1]}23:00${match[4]}`;
  }
  const nextHour = String(Math.min(hour + 1, 23)).padStart(2, '0');
  return `${match[1]}${nextHour}:${minute}${match[4]}`;
}

function formatIsoTime(startsAt: string): string {
  const match = startsAt.match(/T(\d{2}:\d{2})/);
  return match?.[1] ?? startsAt;
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
  const targetAgentIds = selectA2ATargetAgentIds(input.state, input.triggerMessage, input.targetAgentId, input.response);

  return {
    id: `a2a-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    roomId: input.triggerMessage.roomId,
    initiatorAgentId,
    targetAgentIds,
    goal: input.triggerMessage.body,
    status,
    turns: createA2ATurns({
      initiatorAgentId,
      targetAgentIds,
      triggerMessage: input.triggerMessage,
      response: input.response,
      deliveredMessage: input.deliveredMessage,
      createdAt
    }),
    proposedActionRequestIds: input.response.actionRequest ? [input.response.actionRequest.id] : [],
    contextIds: uniqueStrings([input.triggerMessage.id, ...input.response.log.contextIds]),
    risk,
    createdAt,
    updatedAt: createdAt
  };
}

function createA2ATurns(input: {
  initiatorAgentId: string;
  targetAgentIds: string[];
  triggerMessage: Message;
  response: AgentRunResult;
  deliveredMessage?: Message;
  createdAt: string;
}): A2ASession['turns'] {
  if (input.response.intent === 'coordinate' && input.response.requiresHuman && input.targetAgentIds.length > 1) {
    const negotiation = parseScheduleNegotiation(input.response.actionRequest?.input.negotiation);
    return [
      {
        id: `a2a-turn-${Date.now()}-0`,
        agentId: input.initiatorAgentId,
        kind: 'observation',
        message: input.triggerMessage.body,
        toolCalls: ['message.observe'],
        createdAt: input.createdAt
      },
      {
        id: `a2a-turn-${Date.now()}-1`,
        agentId: input.initiatorAgentId,
        kind: 'proposal',
        message: `Proposed schedule change: ${input.triggerMessage.body}`,
        toolCalls: ['agent.coordinate', 'calendar.inspect'],
        createdAt: input.createdAt
      },
      ...input.targetAgentIds.map((agentId, index) => {
        const constraint = negotiation?.constraints.find((candidate) => candidate.agentId === agentId);
        const kind: A2ATurnKind = constraint?.status === 'counter_proposal' ? 'counter_proposal' : 'response';
        return {
          id: `a2a-turn-${Date.now()}-${index + 2}`,
          agentId,
          kind,
          message:
            constraint?.message ??
            (index === 0
              ? summarizeAgentRunResponse(input.response, input.deliveredMessage)
              : 'Reviewed authorized room tasks and calendar context; no automatic calendar mutation before human approval.'),
          toolCalls:
            kind === 'counter_proposal'
              ? ['agent.calendar_constraints.inspect', 'calendar.conflict.detect', 'agent.counter_proposal']
              : index === 0
                ? input.response.log.toolCalls
                : ['agent.calendar_constraints.inspect'],
          createdAt: input.createdAt
        };
      }),
      {
        id: `a2a-turn-${Date.now()}-${input.targetAgentIds.length + 2}`,
        agentId: input.targetAgentIds[0] ?? input.initiatorAgentId,
        kind: 'proposal',
        message: negotiation
          ? `Negotiation produced ${formatIsoTime(negotiation.finalStartsAt)} as the final proposed time and is waiting for human confirmation.`
          : 'Negotiation produced a schedule-change proposal and is waiting for human confirmation.',
        toolCalls: ['risk.gate', 'action_request.create'],
        createdAt: input.createdAt
      }
    ];
  }

  return [
    {
      id: `a2a-turn-${Date.now()}-0`,
      agentId: input.initiatorAgentId,
      kind: 'observation',
      message: input.triggerMessage.body,
      toolCalls: ['message.observe'],
      createdAt: input.createdAt
    },
    {
      id: `a2a-turn-${Date.now()}-1`,
      agentId: input.targetAgentIds[0] ?? input.initiatorAgentId,
      kind: input.response.requiresHuman ? 'proposal' : 'tool_result',
      message: summarizeAgentRunResponse(input.response, input.deliveredMessage),
      toolCalls: input.response.log.toolCalls,
      createdAt: input.createdAt
    }
  ];
}

function selectA2ATargetAgentIds(
  state: DemoState,
  triggerMessage: Message,
  primaryAgentId: string,
  response: AgentRunResult
): string[] {
  if (response.intent !== 'coordinate') {
    return [primaryAgentId];
  }
  const mentionedAgentIds = state.agents
    .filter((agent) => agent.allowedRoomIds.includes(triggerMessage.roomId))
    .filter((agent) => {
      const owner = state.users.find((candidate) => candidate.id === agent.ownerId);
      return owner && mentionsAgentDirectly(triggerMessage.body, agent.displayName, owner.name, owner.id);
    })
    .map((agent) => agent.id);
  const actionTarget = typeof response.actionRequest?.input.toAgentId === 'string' ? response.actionRequest.input.toAgentId : '';
  return uniqueStrings([primaryAgentId, actionTarget, ...mentionedAgentIds]);
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
