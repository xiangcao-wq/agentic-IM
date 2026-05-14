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

export interface PendingTaskFollowUpInput {
  state: DemoState;
  roomId?: string;
  now?: string;
  limit?: number;
}

export interface PendingTaskFollowUpResult {
  state: DemoState;
  sessions: A2ASession[];
  logs: AgentActionLog[];
  actionRequests: AgentActionRequest[];
  processedTaskIds: string[];
  skippedTaskIds: string[];
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

export function runPendingTaskFollowUps(input: PendingTaskFollowUpInput): PendingTaskFollowUpResult {
  const now = input.now ? new Date(input.now) : new Date();
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
  const alreadyProcessed = processedTaskFollowUpIds(input.state);
  const candidates = input.state.tasks
    .filter((task) => task.status === 'pending')
    .filter((task) => !alreadyProcessed.has(task.id))
    .map((task) => ({ task, roomId: roomIdForTask(input.state, task.id, task.sourceMessageId) }))
    .filter((candidate): candidate is { task: DemoState['tasks'][number]; roomId: string } =>
      Boolean(candidate.roomId && (!input.roomId || candidate.roomId === input.roomId))
    )
    .filter(({ task }) => isTaskDueForFollowUp(task.deadline, now))
    .slice(0, limit);

  let state = input.state;
  const sessions: A2ASession[] = [];
  const logs: AgentActionLog[] = [];
  const actionRequests: AgentActionRequest[] = [];
  const processedTaskIds: string[] = [];
  const skippedTaskIds: string[] = [];

  for (const { task, roomId } of candidates) {
    const assignee = findTaskFollowUpAssignee(state, task, roomId);
    if (!assignee) {
      skippedTaskIds.push(task.id);
      continue;
    }
    const createdAt = new Date().toISOString();
    const risk = taskFollowUpRisk(task);
    const sourceIds = uniqueStrings([task.id, task.sourceMessageId]);
    const actionRequest: AgentActionRequest = {
      id: `action-task-follow-up-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      agentId: assignee.agentId,
      roomId,
      kind: 'task_update_suggest',
      status: 'needs_confirmation',
      input: {
        taskId: task.id,
        requestText: `Autopilot follow-up: ${task.title}`,
        plan: `The task "${task.title}" is still pending and due ${task.deadline}. Suggest marking it in progress after human confirmation.`,
        taskPatch: {
          taskId: task.id,
          oldStatus: task.status,
          newStatus: 'in_progress'
        }
      },
      risk,
      createdAt,
      updatedAt: createdAt,
      requiresHuman: true
    };
    const log: AgentActionLog = {
      id: `log-task-follow-up-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      agentId: assignee.agentId,
      roomId,
      action: `autopilot_task_follow_up:${task.id}`,
      status: 'needs_confirmation',
      risk,
      contextIds: sourceIds,
      toolCalls: ['autopilot.task_follow_up', 'task.inspect', 'task.suggest_update', 'action_request.create'],
      createdAt
    };
    const session = createTaskFollowUpSession({
      roomId,
      agentId: assignee.agentId,
      task,
      sourceIds,
      actionRequestId: actionRequest.id,
      risk,
      createdAt
    });

    actionRequests.push(actionRequest);
    sessions.push(session);
    logs.push(log);
    processedTaskIds.push(task.id);
    state = {
      ...state,
      actionRequests: [actionRequest, ...state.actionRequests],
      a2aSessions: [session, ...(state.a2aSessions ?? [])],
      actionLogs: [log, ...state.actionLogs]
    };
  }

  return { state, sessions, logs, actionRequests, processedTaskIds, skippedTaskIds };
}

function processedAutopilotMessageIds(state: DemoState): Set<string> {
  return new Set(
    (state.a2aSessions ?? [])
      .flatMap((session) => session.contextIds)
      .filter((contextId) => state.messages.some((message) => message.id === contextId))
  );
}

function processedTaskFollowUpIds(state: DemoState): Set<string> {
  return new Set([
    ...(state.a2aSessions ?? [])
      .filter((session) => session.goal.startsWith('autopilot_task_follow_up:'))
      .flatMap((session) => session.contextIds)
      .filter((contextId) => state.tasks.some((task) => task.id === contextId)),
    ...state.actionRequests
      .filter((request) => request.kind === 'task_update_suggest' && request.status !== 'rejected')
      .map((request) => request.input.taskId)
      .filter((taskId): taskId is string => typeof taskId === 'string')
  ]);
}

function emptyAutopilotResult(state: DemoState): AgentAutopilotResult {
  return { state, sessions: [], messages: [], logs: [], responses: [] };
}

function roomIdForTask(state: DemoState, taskId: string, sourceMessageId: string): string | undefined {
  const sourceMessage = state.messages.find((message) => message.id === sourceMessageId);
  if (sourceMessage) {
    return sourceMessage.roomId;
  }
  return state.calendar.find((item) => item.sourceTaskId === taskId)?.roomId;
}

function isTaskDueForFollowUp(deadline: string, now: Date): boolean {
  const dueAt = parseTaskDeadline(deadline, now);
  if (!dueAt) {
    return false;
  }
  const deltaMs = dueAt.getTime() - now.getTime();
  return deltaMs <= 48 * 60 * 60 * 1000;
}

function parseTaskDeadline(deadline: string, now: Date): Date | undefined {
  const explicit = deadline.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2})[:：](\d{2})/);
  if (explicit) {
    const month = explicit[1].padStart(2, '0');
    const day = explicit[2].padStart(2, '0');
    const hour = explicit[3].padStart(2, '0');
    const minute = explicit[4];
    return new Date(`${now.getFullYear()}-${month}-${day}T${hour}:${minute}:00+08:00`);
  }
  const iso = Date.parse(deadline);
  return Number.isNaN(iso) ? undefined : new Date(iso);
}

function findTaskFollowUpAssignee(
  state: DemoState,
  task: DemoState['tasks'][number],
  roomId: string
): { agentId: string; ownerId: string } | undefined {
  const ownerNames = task.owners.map((owner) => owner.trim().toLowerCase());
  for (const user of state.users) {
    if (!ownerNames.includes(user.name.trim().toLowerCase())) {
      continue;
    }
    const agent = state.agents.find((candidate) => candidate.id === user.agentId);
    const policy = state.agentAutopilotPolicies.find((candidate) => candidate.agentId === user.agentId);
    if (
      agent?.allowedRoomIds.includes(roomId) &&
      policy?.enabled &&
      policy.allowedRoomIds.includes(roomId) &&
      policy.allowedActions.includes('suggest_task_updates')
    ) {
      return { agentId: user.agentId, ownerId: user.id };
    }
  }
  return undefined;
}

function taskFollowUpRisk(task: DemoState['tasks'][number]): RiskAssessment {
  return {
    level: 'medium',
    score: 0.52,
    reason: `Autopilot found pending task "${task.title}" near its deadline; status changes require human confirmation.`,
    model: 'autopilot-task-follow-up-v1'
  };
}

function createTaskFollowUpSession(input: {
  roomId: string;
  agentId: string;
  task: DemoState['tasks'][number];
  sourceIds: string[];
  actionRequestId: string;
  risk: RiskAssessment;
  createdAt: string;
}): A2ASession {
  return {
    id: `a2a-task-follow-up-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    roomId: input.roomId,
    initiatorAgentId: input.agentId,
    targetAgentIds: [input.agentId],
    goal: `autopilot_task_follow_up:${input.task.id}`,
    status: 'needs_confirmation',
    turns: [
      {
        id: `a2a-task-turn-${Date.now()}-0`,
        agentId: input.agentId,
        kind: 'observation',
        message: `Autopilot found pending task "${input.task.title}" due ${input.task.deadline}.`,
        toolCalls: ['task.inspect'],
        createdAt: input.createdAt
      },
      {
        id: `a2a-task-turn-${Date.now()}-1`,
        agentId: input.agentId,
        kind: 'proposal',
        message: 'Suggest marking this task as in progress after human confirmation; no task data changed yet.',
        toolCalls: ['task.suggest_update', 'risk.gate', 'action_request.create'],
        createdAt: input.createdAt
      }
    ],
    proposedActionRequestIds: [input.actionRequestId],
    contextIds: input.sourceIds,
    risk: input.risk,
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
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
      const ownDelegation = Boolean(
        agent &&
        owner &&
        owner.id === triggerMessage.senderId &&
        inferredIntent &&
        isOwnAssistantDelegationCommand(triggerMessage.body, inferredIntent)
      );
      if (!agent || !owner || (owner.id === triggerMessage.senderId && !ownDelegation)) {
        return [];
      }
      const explicitlyMentioned = ownDelegation || mentionsAgent(triggerMessage.body, agent.displayName, owner.name, owner.id);
      const explicitAgentMention = ownDelegation || mentionsAgentDirectly(triggerMessage.body, agent.displayName, owner.name, owner.id);
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

function selectRunnableCandidates<T extends { explicitlyMentioned: boolean; intent: AgentRunIntent }>(candidates: T[]): T[] {
  const explicit = candidates.filter((candidate) => candidate.explicitlyMentioned);
  if (explicit.length > 0) {
    const coordinate = explicit.find((candidate) => candidate.intent === 'coordinate');
    if (coordinate) {
      return [coordinate];
    }
    return explicit.slice(0, 3);
  }
  return candidates.slice(0, 1);
}

function isOwnAssistantDelegationCommand(text: string, intent: AgentRunIntent): boolean {
  const lowered = text.toLowerCase();
  const asksOwnAssistant =
    includesAny(text, ['帮我', '替我', '麻烦你', '请你', '帮忙', '帮我和']) ||
    includesAny(lowered, ['help me', 'for me', 'on my behalf']);
  if (!asksOwnAssistant) {
    return false;
  }
  if (intent === 'coordinate') {
    return (
      includesAny(text, ['商量', '协商', '协调', '确认', '改到', '调整', '安排']) ||
      includesAny(lowered, ['negotiate', 'coordinate', 'reschedule'])
    );
  }
  if (intent === 'share_file') {
    return (
      includesAny(text, ['发', '发送', '代发', '转发', '分享']) ||
      includesAny(lowered, ['send', 'share', 'forward'])
    );
  }
  return intent === 'deadline' || intent === 'find_file' || intent === 'chat';
}

function inferAutopilotIntent(text: string): AgentRunIntent | undefined {
  const lowered = text.toLowerCase();
  const asksNotToSend =
    includesAny(text, ['不要发', '先不发', '别发', '不要发送', '先不要发']) ||
    includesAny(lowered, ['do not send', "don't send"]);
  const mentionsFileLike =
    includesAny(text, ['文件', '图片', '图像', '照片', '海报', '素材', '演示稿', '幻灯', '课件', '报告', '行动计划', '文档']) ||
    includesAny(lowered, ['file', 'image', 'picture', 'photo', 'poster', 'asset', 'slides', 'deck', 'plan', 'pdf']);
  const asksToSend =
    includesAny(text, ['发', '发送', '代发', '转发', '分享', '传一下', '发给', '发一下']) ||
    includesAny(lowered, ['send', 'share', 'forward']);
  const asksScheduleCoordination =
    includesAny(lowered, ['coordinate', 'reschedule', 'move the final review', 'move the meeting', 'negotiate']) ||
    includesAny(text, ['改到', '改成', '改为', '调整日程', '调整时间', '安排会议', '开会时间', '会面时间']) ||
    (includesAny(text, ['协调', '协商', '确认']) &&
      includesAny(text, ['时间', '日程', '会议', '开会', '会面', '合稿', '检查', '明天', '下午', '晚上']));

  if (asksScheduleCoordination) {
    return 'coordinate';
  }
  if (
    !asksNotToSend &&
    (includesAny(lowered, ['send latest', 'send the latest', 'share latest', 'send file', 'share file', 'latest slides']) ||
      (asksToSend && mentionsFileLike))
  ) {
    return 'share_file';
  }
  if (
    includesAny(text, ['截止', '到期', '什么时候交', 'ddl', 'DDL', '还有几天']) ||
    includesAny(lowered, ['deadline', 'due date', 'when is this due'])
  ) {
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
    mentionsPersonalAssistant(text, ownerName, ownerId) ||
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
    mentionsPersonalAssistant(text, ownerName, ownerId) ||
    lowered.includes(`${normalizedOwnerName} agent`) ||
    lowered.includes(`${normalizedOwnerName}的 agent`) ||
    lowered.includes(`${ownerSlug} agent`) ||
    lowered.includes(`${ownerSlug}'s agent`)
  );
}

function mentionsPersonalAssistant(text: string, ownerName: string, ownerId: string): boolean {
  const lowered = text.toLowerCase();
  const compactText = lowered.replace(/\s+/g, '');
  const ownerSlug = ownerId.replace(/^user-/, '').toLowerCase();
  const ownerNameLower = ownerName.toLowerCase();
  const ownerMentioned =
    compactText.includes(ownerNameLower.replace(/\s+/g, '')) ||
    compactText.includes(ownerSlug) ||
    compactText.includes(`${ownerSlug}的`);
  if (!ownerMentioned) {
    return false;
  }
  return includesAny(compactText, [
    '个人助手',
    '聊天分身',
    'ai分身',
    '智能分身',
    '分身',
    '托管',
    '代回',
    '代发'
  ]);
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
    senderName: owner.name,
    body: reply,
    sentAt: new Date().toISOString(),
    type: 'agent',
    agentLabel: '个人助手回复',
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
