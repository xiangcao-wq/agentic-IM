import {
  answerDeadlineQuestion,
  coordinateAgents,
  summarizeRoom
} from '../domain/agentEngine';
import { enqueueAgentAction, requireActionConfirmation } from '../domain/actionQueue';
import { buildAgentSystemPrompt, buildStructuredContext, listAgentMemories, writeMemory } from '../domain/memory';
import type {
  AgentActionKind,
  AgentActionLog,
  AgentPlan,
  AgentProgressEvent,
  AgentRunIntent,
  AgentRunRequest,
  AgentRunResult,
  AgentToolCall,
  ChatResult,
  DemoState,
  FileItem,
  Message,
  RiskAssessment,
  WebSearchAnswer,
  WebSearchResultItem
} from '../domain/types';
import type { AiProvider, AiTextPrompt } from './aiProvider';
import { defaultToolCallsForIntent, isAgentToolName, primaryToolNameForIntent } from './agentTools';
import { runFileShareAction } from './agentRuntime';
import { searchFileTextChunks } from './fileTextIndex';
import type { WebSearchProvider } from './webSearch';

interface AgentRunDecision {
  intent: AgentRunIntent;
  plan: string;
  answer?: string;
  targetUserId?: string;
  usedFallback?: boolean;
}

interface AgentRunProgressOptions {
  runId?: string;
  onProgress?: (event: Omit<AgentProgressEvent, 'id' | 'createdAt' | 'sequence'>) => void;
}

interface AgentRuntimeToolOptions {
  webSearchProvider?: WebSearchProvider;
}

const agentRunIntents = new Set<AgentRunIntent>([
  'summary',
  'deadline',
  'find_file',
  'share_file',
  'coordinate',
  'task_update_suggest',
  'web_search',
  'chat'
]);

function emitAgentRunProgress(
  progress: AgentRunProgressOptions | undefined,
  input: AgentRunRequest,
  event: Omit<AgentProgressEvent, 'id' | 'createdAt' | 'sequence' | 'runId' | 'agentId' | 'roomId'>
): void {
  progress?.onProgress?.({
    runId: progress.runId ?? `agent-run-${Date.now()}`,
    agentId: input.agentId,
    roomId: input.roomId,
    ...event
  });
}

export async function runAgentIntent(
  state: DemoState,
  input: AgentRunRequest,
  aiProvider?: AiProvider,
  progress?: AgentRunProgressOptions,
  tools: AgentRuntimeToolOptions = {}
): Promise<{ state: DemoState; response: AgentRunResult }> {
  emitAgentRunProgress(progress, input, {
    phase: 'started',
    label: '校验 Agent 权限',
    detail: input.agentId,
    toolCalls: []
  });
  const agent = state.agents.find((candidate) => candidate.id === input.agentId);
  if (!agent) {
    throw new Error(`unknown agent: ${input.agentId}`);
  }
  if (!agent.allowedRoomIds.includes(input.roomId)) {
    throw new Error(`${agent.displayName} cannot read ${input.roomId}`);
  }

  emitAgentRunProgress(progress, input, {
    phase: 'planning',
    label: '构建授权上下文',
    detail: input.roomId,
    toolCalls: ['context.build']
  });
  emitAgentRunProgress(progress, input, {
    phase: 'planning',
    label: '规划 Agent 动作',
    detail: input.userText,
    toolCalls: []
  });
  const plan = await planAgentRun(state, input, aiProvider);
  emitAgentRunProgress(progress, input, {
    phase: 'executing',
    label: `执行工具：${plan.toolCalls.map((toolCall) => toolCall.tool).join('、') || plan.intent}`,
    detail: plan.userVisiblePlan,
    toolCalls: plan.toolCalls.map((toolCall) => toolCall.tool),
    riskLevel: plan.risk.level
  });
  const result = await executeAgentPlan(state, input, agent, plan, aiProvider, progress, tools);
  emitAgentRunProgress(progress, input, {
    phase: 'completed',
    label: `完成 ${result.response.intent}`,
    detail: result.response.requiresHuman ? '已进入人工确认队列' : '已写入运行结果和记忆',
    toolCalls: result.response.log.toolCalls,
    riskLevel: result.response.log.risk.level
  });
  return result;
}

async function executeAgentPlan(
  state: DemoState,
  input: AgentRunRequest,
  agent: DemoState['agents'][number],
  plan: AgentPlan,
  aiProvider?: AiProvider,
  progress?: AgentRunProgressOptions,
  tools: AgentRuntimeToolOptions = {}
): Promise<{ state: DemoState; response: AgentRunResult }> {
  const decision = agentPlanToDecision(plan, input);
  const intent = plan.intent;
  const plannedToolNames = plan.toolCalls.map((toolCall) => toolCall.tool);

  if (intent === 'summary') {
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '读取并总结对话',
      detail: input.roomId,
      toolCalls: ['room.summarize']
    });
    const result = await summarizeRoom(state, input.roomId, input.agentId, aiProvider);
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '写入 Agent 记忆',
      detail: `${result.sources.length} 个来源`,
      toolCalls: ['memory.write']
    });
    const memoryWrite = writeMemory(state, {
      agentId: input.agentId,
      scopeRoomIds: [input.roomId, ...agent.allowedRoomIds],
      kind: 'summary',
      content: `${result.headline}\n${result.todos.join('\n')}`,
      sourceIds: result.sources
    });
    const log = createLog({
      agentId: input.agentId,
      roomId: input.roomId,
      action: `agent_run:summary:${input.userText}`,
      risk: lowRisk('只读总结并写入结构化记忆。'),
      contextIds: [...result.sources, memoryWrite.memory.id],
      toolCalls: uniqueStrings([...modelToolCalls(aiProvider, plan), ...plannedToolNames, 'room_search', 'task_extract', 'memory.write'])
    });
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '写入运行日志',
      detail: log.action,
      toolCalls: log.toolCalls,
      riskLevel: log.risk.level
    });
    return {
      state: { ...memoryWrite.state, actionLogs: [log, ...memoryWrite.state.actionLogs] },
      response: {
        intent,
        requiresHuman: false,
        plan: decision.plan,
        reasoning: decision.plan,
        result,
        memory: memoryWrite.memory,
        log
      }
    };
  }

  if (intent === 'deadline') {
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '检索截止信息',
      detail: input.userText,
      toolCalls: ['deadline.answer']
    });
    const result = await answerDeadlineQuestion(state, {
      agentId: input.agentId,
      roomId: input.roomId,
      question: input.userText
    }, aiProvider);
    const relatedMemories = listAgentMemories(state, input.agentId, input.userText);
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '写入 Agent 记忆',
      detail: `${result.citations.length} 条引用，${relatedMemories.length} 条相关记忆`,
      toolCalls: ['memory.write']
    });
    const memoryWrite = writeMemory(state, {
      agentId: input.agentId,
      scopeRoomIds: [input.roomId, ...agent.allowedRoomIds],
      kind: 'deadline',
      content: `${result.answer}\n参考记忆：${relatedMemories.map((memory) => memory.content).join('\n')}`,
      sourceIds: [...result.citations, ...relatedMemories.map((memory) => memory.id)]
    });
    const log = createLog({
      agentId: input.agentId,
      roomId: input.roomId,
      action: `agent_run:deadline:${input.userText}`,
      risk: lowRisk('只读检索授权房间、文件和结构化记忆。'),
      contextIds: [...result.citations, ...relatedMemories.map((memory) => memory.id), memoryWrite.memory.id],
      toolCalls: uniqueStrings([
        ...modelToolCalls(aiProvider, plan),
        ...plannedToolNames,
        'room_search',
        'file_library.search',
        'memory.search',
        'memory.write'
      ])
    });
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '写入运行日志',
      detail: log.action,
      toolCalls: log.toolCalls,
      riskLevel: log.risk.level
    });
    return {
      state: { ...memoryWrite.state, actionLogs: [log, ...memoryWrite.state.actionLogs] },
      response: {
        intent,
        requiresHuman: false,
        plan: decision.plan,
        reasoning: decision.plan,
        result,
        memory: memoryWrite.memory,
        log
      }
    };
  }

  if (intent === 'find_file') {
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '检索授权文件',
      detail: input.userText,
      toolCalls: ['file.search']
    });
    const files = findAuthorizedFiles(state, input.agentId, input.roomId, input.userText);
    const log = createLog({
      agentId: input.agentId,
      roomId: input.roomId,
      action: `agent_run:find_file:${input.userText}`,
      risk: lowRisk('只读检索授权文件库。'),
      contextIds: files.map((file) => file.id),
      toolCalls: uniqueStrings([...modelToolCalls(aiProvider, plan), ...plannedToolNames, 'file_library.search'])
    });
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '写入运行日志',
      detail: `命中 ${files.length} 个文件`,
      toolCalls: log.toolCalls,
      riskLevel: log.risk.level
    });
    return {
      state: { ...state, actionLogs: [log, ...state.actionLogs] },
      response: {
        intent,
        requiresHuman: false,
        plan: decision.plan,
        reasoning: decision.plan,
        files,
        log
      }
    };
  }

  if (intent === 'share_file') {
    const requesterId = getPlanStringArg(plan, 'file.share', 'requesterId') ?? decision.targetUserId ?? input.targetUserId ?? 'user-chen';
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '评估文件代发',
      detail: requesterId,
      toolCalls: ['file.share']
    });
    const runtime = await runFileShareAction(state, {
      agentId: input.agentId,
      roomId: input.roomId,
      requesterId,
      requestText: input.userText
    }, aiProvider);
    const resultLog = {
      ...runtime.result.log,
      toolCalls: uniqueStrings([...modelToolCalls(aiProvider, plan), ...plannedToolNames, ...runtime.result.log.toolCalls])
    };
    const result = {
      ...runtime.result,
      log: resultLog
    };
    const memoryWrite = writeMemory(runtime.state, {
      agentId: input.agentId,
      scopeRoomIds: [input.roomId],
      kind: 'file',
      content: `${result.status}: ${result.file?.name ?? '未找到可代发文件'}`,
      sourceIds: [runtime.actionRequest.id, result.file?.id, result.message?.id].filter(Boolean) as string[]
    });
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '写入 Agent 记忆',
      detail: result.file?.name ?? '没有可代发文件',
      toolCalls: ['memory.write'],
      riskLevel: result.risk.level
    });
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: result.requiresHuman ? '写入确认队列' : '写入运行日志',
      detail: result.status,
      toolCalls: resultLog.toolCalls,
      riskLevel: result.risk.level
    });
    return {
      state: memoryWrite.state,
      response: {
        intent,
        requiresHuman: result.requiresHuman,
        plan: decision.plan,
        reasoning: decision.plan,
        result,
        message: result.message,
        memory: memoryWrite.memory,
        log: resultLog,
        actionRequest: runtime.actionRequest
      }
    };
  }

  if (intent === 'coordinate') {
    const targetUserId = getPlanStringArg(plan, 'agent.coordinate', 'targetUserId') ?? decision.targetUserId ?? input.targetUserId;
    const toAgentId = targetUserId
      ? state.users.find((user) => user.id === targetUserId)?.agentId
      : 'agent-lin';
    if (!toAgentId) {
      throw new Error(`unknown target user: ${targetUserId}`);
    }
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '分析协调风险',
      detail: toAgentId,
      toolCalls: ['agent.coordinate']
    });
    const result = await coordinateAgents(state, {
      fromAgentId: input.agentId,
      toAgentId,
      roomId: input.roomId,
      proposal: input.userText
    }, aiProvider);
    const message = result.requiresHuman ? undefined : createAgentCoordinationMessage(state, input.agentId, result.proposedPlan);
    const memoryWrite = writeMemory(state, {
      agentId: input.agentId,
      scopeRoomIds: [input.roomId],
      kind: 'coordination',
      content: result.proposedPlan,
      sourceIds: [...result.log.contextIds, ...(message ? [message.id] : [])]
    });
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '写入 Agent 记忆',
      detail: result.proposedPlan.slice(0, 80),
      toolCalls: ['memory.write'],
      riskLevel: result.risk.level
    });
    const log = { ...result.log, toolCalls: uniqueStrings([...modelToolCalls(aiProvider, plan), ...plannedToolNames, ...result.log.toolCalls, 'memory.write']) };
    const queued = result.requiresHuman
      ? queueActionForConfirmation(memoryWrite.state, {
          agentId: input.agentId,
          roomId: input.roomId,
          kind: 'coordinate',
          input: {
            fromAgentId: input.agentId,
            toAgentId,
            proposal: input.userText,
            proposedPlan: result.proposedPlan,
            calendarPatch: createCalendarPatch(state, input.roomId, input.userText)
          },
          risk: result.risk,
          log
        })
      : undefined;
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: queued ? '写入确认队列' : '写入运行日志',
      detail: result.requiresHuman ? '等待人工确认' : log.action,
      toolCalls: log.toolCalls,
      riskLevel: log.risk.level
    });
    return {
      state: queued?.state ?? { ...memoryWrite.state, actionLogs: [log, ...memoryWrite.state.actionLogs] },
      response: {
        intent,
        requiresHuman: result.requiresHuman,
        plan: decision.plan,
        reasoning: decision.plan,
        result,
        message,
        memory: memoryWrite.memory,
        log,
        actionRequest: queued?.request
      }
    };
  }

  if (intent === 'chat') {
    return handleAgentChat(state, input, aiProvider, decision, progress);
  }

  if (intent === 'web_search') {
    return handleAgentWebSearch(state, input, agent, plan, aiProvider, progress, tools.webSearchProvider);
  }

  emitAgentRunProgress(progress, input, {
    phase: 'executing',
    label: '生成任务更新建议',
    detail: input.userText,
    toolCalls: ['task.suggest_update']
  });
  const memoryWrite = writeMemory(state, {
    agentId: input.agentId,
    scopeRoomIds: [input.roomId],
    kind: 'note',
    content: `任务更新建议：${input.userText}`,
    sourceIds: []
  });
  emitAgentRunProgress(progress, input, {
    phase: 'executing',
    label: '写入 Agent 记忆',
    detail: memoryWrite.memory.id,
    toolCalls: ['memory.write']
  });
  const log = createLog({
    agentId: input.agentId,
    roomId: input.roomId,
    action: `agent_run:task_update_suggest:${input.userText}`,
    status: 'needs_confirmation',
    risk: {
      level: 'medium',
      score: 0.52,
      reason: '任务更新会影响多人协作，第一版只生成建议并等待人工确认。',
      model: 'risk-mini-v1'
    },
    contextIds: [memoryWrite.memory.id],
      toolCalls: uniqueStrings([...modelToolCalls(aiProvider, plan), ...plannedToolNames, 'task.inspect', 'memory.write'])
  });
  const queued = queueActionForConfirmation(memoryWrite.state, {
    agentId: input.agentId,
    roomId: input.roomId,
    kind: 'task_update_suggest',
    input: {
      requestText: input.userText,
      memoryId: memoryWrite.memory.id,
      plan: decision.plan,
      taskPatch: createTaskPatch(state, input.roomId, input.userText)
    },
    risk: log.risk,
    log
  });
  emitAgentRunProgress(progress, input, {
    phase: 'executing',
    label: '写入确认队列',
    detail: queued.request.id,
    toolCalls: log.toolCalls,
    riskLevel: log.risk.level
  });
  return {
    state: queued.state,
    response: {
      intent,
      requiresHuman: true,
      plan: decision.plan,
      reasoning: decision.plan,
      memory: memoryWrite.memory,
      log,
      actionRequest: queued.request
    }
  };
}

async function planAgentRun(
  state: DemoState,
  input: AgentRunRequest,
  aiProvider?: AiProvider
): Promise<AgentPlan> {
  const fallback = createFallbackAgentPlan(input);
  if (!aiProvider) {
    return fallback;
  }

  try {
    const systemPrompt = [
      buildAgentSystemPrompt(state, input.agentId),
      '',
      '## Agent Planner',
      'Default internal context scope is the current room/chat only. Expand to all authorized rooms only when the user explicitly asks for global, all-room, all-chat, or cross-room context.',
      'For internal project facts, prefer messages, tasks, file metadata, and file excerpts. Agent memory is lower-confidence and must not be the only source for a concrete internal claim.',
      'If the current-room context lacks the answer, do not silently use other rooms. Ask for global scope unless the request already explicitly asked for global/all-room context.',
      'You may handle general AI chat using the model’s broad capabilities. Do not restrict ordinary conversation to internal room context.',
      'When the user explicitly asks for online, web, latest, news, DeepSeek search, or public external information, choose web_search and call web.search.',
      'If authorized current/global context cannot answer and the user asks for external public facts or DeepSeek/web search, use web_search instead of inventing an internal answer.',
      'Do not invent internal project details that are not explicit in the authorized context. If an internal claim is only inferred, say it is an inference.',
      '你先判断用户真实意图，再输出一个可执行计划。此步骤只做规划，不发送消息、不改文件、不改日程。',
      '可选 intent：summary、deadline、find_file、share_file、coordinate、task_update_suggest、web_search、chat。',
      'userVisiblePlan 是展示给用户看的简短执行计划或判断依据，不要输出隐藏推理过程。',
      '当用户只是自然提问或闲聊时选择 chat，并在 answer 中给出可直接展示的回复。',
      '当用户明确要求“联网/网上/搜索/查一下/最新/news/current/web search”等外部公开信息时选择 web_search，不要把它降级为只读内部上下文。',
      '询问“谁负责、进度如何、我今天先做什么、能看到哪些上下文”等上下文问题，一律选择 chat。',
      '只有用户明确要求改变日程/任务安排，或要求你和某个用户/Agent 协商确认时，才选择 coordinate。',
      '当用户请求总结、截止日期、文件、协调等能力时选择对应 intent；targetUserId 仅在明确提到目标用户时填写。',
      '如果不确定是否要执行外部动作，选择 chat，先解释判断并请求确认。',
      '可用 tool：chat.answer、room.summarize、deadline.answer、file.search、file.share、web.search、agent.coordinate、task.suggest_update。',
      '',
      '请严格以 JSON 回复，不要包含其他文字。JSON 格式如下：',
      '{"mode":"answer","intent":"chat","userVisiblePlan":"一句话说明要如何处理","answer":"chat 时的直接回复","toolCalls":[{"tool":"chat.answer","args":{}}],"risk":{"level":"low","score":0.1,"reason":"只读回答","model":"llm-planner"},"citations":["消息或文件ID"],"needsConfirmationReason":null}'
    ].join('\n');
    const context = buildStructuredContext(state, input.roomId, input.agentId, {
      focus: 'chat',
      userText: input.userText
    });
    const requestTail = [
      '## Current User Request',
      `Frontend intent: ${input.intent ?? 'unspecified'}`,
      `User input: ${input.userText}`
    ].join('\n');
    const raw = await aiProvider.generateText({
      actorRole: 'personal_agent',
      actorId: input.agentId,
      instructions: systemPrompt,
      input: [
        context,
        '',
        requestTail
      ].join('\n'),
      messages: buildCacheFriendlyMessages(systemPrompt, context, requestTail),
      responseFormat: 'json_object',
      maxOutputTokens: 360
    });
    return normalizeAgentPlan(parseAgentPlan(raw, fallback, input), input);
  } catch {
    return fallback;
  }
}

function createFallbackDecision(input: AgentRunRequest): AgentRunDecision {
  const intent = isAgentRunIntent(input.intent) ? input.intent : inferIntentFromText(input.userText);
  return {
    intent,
    targetUserId: input.targetUserId,
    plan: fallbackPlanForIntent(intent)
  };
}

function createFallbackAgentPlan(input: AgentRunRequest): AgentPlan {
  const decision = createFallbackDecision(input);
  return {
    mode: decision.intent === 'chat' ? 'answer' : 'execute',
    intent: decision.intent,
    userVisiblePlan: decision.plan,
    answer: decision.answer,
    toolCalls: defaultToolCallsForIntent(decision.intent, {
      targetUserId: decision.targetUserId,
      requesterId: decision.targetUserId,
      question: input.userText,
      requestText: input.userText,
      proposal: input.userText
    }),
    risk: {
      level: 'low',
      score: 0.12,
      reason: 'Fallback local rules selected the safest available capability.',
      model: 'fallback.local_rules'
    },
    citations: []
  };
}

function parseAgentPlan(raw: string, fallback: AgentPlan, input: AgentRunRequest): AgentPlan {
  const parsed = parseJson<Record<string, unknown>>(raw);
  const isLegacyDecision =
    !('mode' in parsed) &&
    !('toolCalls' in parsed) &&
    !('userVisiblePlan' in parsed) &&
    ('plan' in parsed || 'intent' in parsed || 'answer' in parsed);
  const legacyIntent = isAgentRunIntent(parsed.intent) ? parsed.intent : fallback.intent;
  const intent = normalizeDecisionIntent(legacyIntent, input.userText);
  const targetUserId =
    typeof parsed.targetUserId === 'string' && parsed.targetUserId.trim() ? parsed.targetUserId.trim() : input.targetUserId;
  const toolCalls = parseToolCalls(parsed.toolCalls, intent, input, targetUserId);
  const risk = isLegacyDecision && !parsed.risk
    ? {
        level: 'low' as const,
        score: 0.18,
        reason: 'Legacy LLM decision shape was normalized into an AgentPlan.',
        model: 'llm-planner-legacy'
      }
    : parsePlanRisk(parsed.risk);

  return {
    mode: parsed.mode === 'answer' || parsed.mode === 'execute' || parsed.mode === 'request_confirmation'
      ? parsed.mode
      : intent === 'chat'
        ? 'answer'
        : 'execute',
    intent,
    userVisiblePlan:
      typeof parsed.userVisiblePlan === 'string' && parsed.userVisiblePlan.trim()
        ? parsed.userVisiblePlan.trim()
        : typeof parsed.plan === 'string' && parsed.plan.trim()
          ? parsed.plan.trim()
          : fallback.userVisiblePlan,
    answer: typeof parsed.answer === 'string' ? parsed.answer.trim() : undefined,
    toolCalls,
    risk,
    citations: Array.isArray(parsed.citations)
      ? parsed.citations.filter((item): item is string => typeof item === 'string')
      : [],
    needsConfirmationReason:
      typeof parsed.needsConfirmationReason === 'string' ? parsed.needsConfirmationReason.trim() : undefined
  };
}

function parsePlanRisk(value: unknown): RiskAssessment {
  if (!value || typeof value !== 'object') {
    throw new Error('Agent plan risk is required');
  }
  const risk = value as Partial<RiskAssessment>;
  if (risk.level !== 'low' && risk.level !== 'medium' && risk.level !== 'high') {
    throw new Error('Agent plan risk level is invalid');
  }
  if (typeof risk.score !== 'number' || !Number.isFinite(risk.score)) {
    throw new Error('Agent plan risk score is invalid');
  }
  if (typeof risk.reason !== 'string' || !risk.reason.trim()) {
    throw new Error('Agent plan risk reason is required');
  }
  return {
    level: risk.level,
    score: risk.score,
    reason: risk.reason,
    model: typeof risk.model === 'string' && risk.model.trim() ? risk.model : 'llm-planner'
  };
}

function parseToolCalls(
  value: unknown,
  intent: AgentRunIntent,
  input: AgentRunRequest,
  targetUserId?: string
): AgentToolCall[] {
  const defaults = defaultToolCallsForIntent(intent, {
    targetUserId,
    requesterId: targetUserId,
    question: input.userText,
    requestText: input.userText,
    proposal: input.userText
  });
  if (!Array.isArray(value) || value.length === 0) {
    return defaults;
  }
  const parsed = value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return undefined;
      }
      const candidate = item as { tool?: unknown; args?: unknown };
      if (!isAgentToolName(candidate.tool)) {
        return undefined;
      }
      return {
        tool: candidate.tool,
        args: candidate.args && typeof candidate.args === 'object' ? candidate.args as Record<string, unknown> : {}
      };
    })
    .filter(Boolean) as AgentToolCall[];
  return parsed.length > 0 ? parsed : defaults;
}

function normalizeAgentPlan(plan: AgentPlan, input: AgentRunRequest): AgentPlan {
  const intent = normalizeDecisionIntent(plan.intent, input.userText);
  const toolCalls = normalizeToolCallsForIntent(intent, plan.toolCalls);
  return {
    ...plan,
    intent,
    mode: plan.mode === 'request_confirmation' || plan.risk.level !== 'low' ? 'request_confirmation' : plan.mode,
    toolCalls
  };
}

function normalizeToolCallsForIntent(intent: AgentRunIntent, toolCalls: AgentToolCall[]): AgentToolCall[] {
  const primary = primaryToolNameForIntent(intent);
  const matching = toolCalls.filter((toolCall) => toolCall.tool === primary);
  return matching.length > 0 ? matching : defaultToolCallsForIntent(intent, toolCalls[0]?.args ?? {});
}

function agentPlanToDecision(plan: AgentPlan, input: AgentRunRequest): AgentRunDecision {
  return {
    intent: plan.intent,
    plan: plan.userVisiblePlan,
    answer: plan.answer,
    usedFallback: plan.risk.model === 'fallback.local_rules',
    targetUserId:
      getPlanStringArg(plan, primaryToolNameForIntent(plan.intent), 'targetUserId') ??
      getPlanStringArg(plan, primaryToolNameForIntent(plan.intent), 'requesterId') ??
      input.targetUserId
  };
}

function inferIntentFromText(text: string): AgentRunIntent {
  const lowered = text.toLowerCase();
  const asksNotToSend = includesAny(text, ['不要发', '先不发', '别发', '不要发送', '先不要发']) ||
    lowered.includes('do not send') ||
    lowered.includes("don't send");
  const mentionsFile = includesAny(text, [
    '文件',
    '图片',
    '图像',
    '照片',
    '海报',
    '素材',
    '演示稿',
    '访谈',
    '纪要',
    '行动计划'
  ]) ||
    includesAny(lowered, ['file', 'image', 'picture', 'photo', 'poster', 'asset', 'slides', 'ppt', 'deck', 'interview', 'plan']);
  const asksResponsibility = includesAny(text, ['谁在负责', '谁负责', '负责人', '负责谁']) ||
    includesAny(text, ['归谁管', '谁管', '谁来管']) ||
    (lowered.includes('who') && lowered.includes('responsib'));
  const asksVisibility = includesAny(text, ['能看到哪些', '可以看到哪些', '可见哪些', '你能看到']) ||
    lowered.includes('what can you see');

  if (looksLikeWebSearchRequest(text)) {
    return 'web_search';
  }
  if (includesAny(text, ['总结', '概括', '归纳', '重要信息']) || lowered.includes('summary')) {
    return 'summary';
  }
  if (includesAny(text, ['截止', '到期', 'ddl', '什么时候交']) || lowered.includes('deadline')) {
    return 'deadline';
  }
  if (asksResponsibility) {
    return 'chat';
  }
  if (asksVisibility) {
    return 'chat';
  }
  if (looksLikeTaskUpdateRequest(text)) {
    return 'task_update_suggest';
  }
  if (
    !asksNotToSend &&
    mentionsFile &&
    (includesAny(text, ['发', '发文件', '代发', '转发', '分享', '分享文件', '发一下', '发给', '发送', '传一下']) ||
      includesAny(lowered, ['send', 'share', 'forward']))
  ) {
    return 'share_file';
  }
  if (includesAny(text, ['找文件', '搜索文件', '哪个文件', '哪份文件']) || lowered.includes('find file') || mentionsFile) {
    return asksNotToSend ? 'chat' : 'find_file';
  }
  if (looksLikeCoordinationRequest(text)) {
    return 'coordinate';
  }
  return 'chat';
}

function normalizeDecisionIntent(intent: AgentRunIntent, text: string): AgentRunIntent {
  if (looksLikeWebSearchRequest(text)) {
    return 'web_search';
  }
  if (intent === 'coordinate' && !looksLikeCoordinationRequest(text)) {
    return 'chat';
  }
  if (intent === 'find_file' && looksLikeContextQuestion(text)) {
    return 'chat';
  }
  if (intent === 'task_update_suggest' && !looksLikeTaskUpdateRequest(text)) {
    return 'chat';
  }
  return intent;
}

function looksLikeWebSearchRequest(text: string): boolean {
  const lowered = text.toLowerCase();
  const explicitSearch = includesAny(text, ['网上', '联网', '搜索一下', '搜一下', '外部资料', '互联网']) ||
    includesAny(lowered, ['web search', 'search the web', 'online', 'google']);
  const explicitDeepSeekSearch = /deepseek\s*(搜索|搜|search)|(?:搜索|搜)\s*deepseek/i.test(text);
  const currentPublicInfo = includesAny(text, ['查一下最新', '最新消息', '新闻']) ||
    ((lowered.includes('latest') || lowered.includes('current') || lowered.includes('news')) &&
      includesAny(lowered, ['search', 'web', 'online', 'news']));
  return explicitSearch || explicitDeepSeekSearch || currentPublicInfo;
}

function looksLikeContextQuestion(text: string): boolean {
  const lowered = text.toLowerCase();
  return (
    includesAny(text, ['谁负责', '谁在负责', '归谁管', '谁管', '能看到哪些', '可以看到哪些', '你能看到']) ||
    lowered.includes('what can you see') ||
    (lowered.includes('who') && lowered.includes('responsib'))
  );
}

function looksLikeCoordinationRequest(text: string): boolean {
  const lowered = text.toLowerCase();
  if (includesAny(lowered, ['coordinate', 'reschedule', 'move the meeting', 'negotiate with'])) {
    return true;
  }

  const asksForChange = includesAny(text, [
    '协调',
    '协商',
    '改到',
    '改成',
    '改为',
    '调整',
    '调整日程',
    '调整时间',
    '推迟',
    '提前',
    '安排',
    '安排会议',
    '开会时间',
    '会面时间',
    '约一下',
    '确认大家',
    '和陈晨确认',
    '跟陈晨确认',
    '和赵一鸣确认',
    '跟赵一鸣确认'
  ]);
  const hasScheduleOrAgentTarget = includesAny(text, [
    '时间',
    '日程',
    '会议',
    '开会',
    '会面',
    '合稿',
    '检查',
    '截止',
    '明天',
    '下午',
    '晚上',
    'Agent',
    '大家',
    '陈晨',
    '赵一鸣'
  ]);
  return asksForChange && hasScheduleOrAgentTarget;
}

function looksLikeTaskUpdateRequest(text: string): boolean {
  const lowered = text.toLowerCase();
  if (
    includesAny(text, ['记录进度', '任务标记', '标记为进行中', '建议把']) ||
    includesAny(lowered, ['update task', 'mark in progress', 'record progress'])
  ) {
    return true;
  }
  return (
    includesAny(text, ['更新任务', '修改任务', '标记完成', '改成完成', '记录进度', '把任务']) ||
    includesAny(lowered, ['update task', 'mark done', 'mark complete'])
  );
}

function fallbackPlanForIntent(intent: AgentRunIntent): string {
  const plans: Record<AgentRunIntent, string> = {
    summary: '根据当前授权上下文生成结构化总结。',
    deadline: '检索授权消息、任务和文件后回答截止日期问题。',
    find_file: '只读检索授权文件清单并返回匹配结果。',
    share_file: '评估文件分享请求、匹配授权文件并按风险决定是否执行。',
    coordinate: '分析日程或任务协调请求的影响和风险。',
    task_update_suggest: '生成任务更新建议并等待人工确认。',
    web_search: '搜索公开网页信息，结合来源片段生成带引用的回答。',
    chat: '基于当前上下文直接回答用户问题。'
  };
  return plans[intent];
}

function isAgentRunIntent(value: unknown): value is AgentRunIntent {
  return typeof value === 'string' && agentRunIntents.has(value as AgentRunIntent);
}

function parseJson<T>(raw: string): T {
  const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  return JSON.parse(cleaned) as T;
}

function createAgentCoordinationMessage(state: DemoState, agentId: string, body: string): Message {
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  const owner = state.users.find((candidate) => candidate.id === agent?.ownerId);
  if (!agent || !owner) {
    throw new Error(`unknown agent: ${agentId}`);
  }
  const roomId = state.rooms.some((room) => room.id === 'room-agent') ? 'room-agent' : agent.allowedRoomIds[0];

  return {
    id: `msg-agent-coordinate-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    roomId,
    senderId: owner.id,
    senderName: agent.displayName,
    body,
    sentAt: new Date().toISOString(),
    type: 'agent',
    agentLabel: `${owner.name}的 Agent 协调`,
    sourceAgentId: agent.id
  };
}

function findAuthorizedFiles(state: DemoState, agentId: string, roomId: string, query: string): FileItem[] {
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error(`unknown agent: ${agentId}`);
  }
  const terms = buildFileQueryTerms(query);
  const matches = state.files
    .filter((file) => agent.allowedRoomIds.includes(file.roomId) && file.roomId === roomId && file.visibility === 'room')
    .map((file) => ({ file, score: scoreAuthorizedFile(state, file, terms) }))
    .filter((candidate) => terms.length === 0 || candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.file.version - a.file.version || b.file.updatedAt.localeCompare(a.file.updatedAt))
    .map((candidate) => candidate.file);

  const deduped = new Map<string, FileItem>();
  for (const file of matches) {
    const key = file.name.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, file);
    }
  }
  return [...deduped.values()];
}

function buildFileQueryTerms(query: string): string[] {
  const lowered = query.toLowerCase();
  const terms = lowered
    .split(/[\s,，。！？?、"'()（）]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !fileQueryStopWords.has(term));

  if (includesAny(query, ['演示稿', '幻灯', '课件']) || includesAny(lowered, ['slides', 'slide', 'ppt', 'deck'])) {
    terms.push('演示稿', 'slides', 'ppt', 'pptx', 'presentation');
  }
  if (includesAny(query, ['访谈', '纪要']) || lowered.includes('interview')) {
    terms.push('访谈', '纪要', 'interview');
  }
  if (includesAny(query, ['行动计划']) || includesAny(lowered, ['action plan', 'plan'])) {
    terms.push('行动计划', 'action', 'plan');
  }
  if (includesAny(query, ['报告']) || lowered.includes('report')) {
    terms.push('报告', 'report', 'pdf');
  }
  if (
    includesAny(query, ['图片', '图像', '照片', '海报', '素材', '昨晚生成']) ||
    includesAny(lowered, ['image', 'picture', 'photo', 'poster', 'visual', 'asset', 'svg'])
  ) {
    terms.push('图片', '图像', '照片', '海报', '素材', 'image', 'picture', 'poster', 'visual', 'asset', 'svg');
  }
  if (includesAny(query, ['流程图']) || includesAny(lowered, ['flow', 'diagram'])) {
    terms.push('流程图', 'flow', 'diagram');
  }

  const cjkPairs = (query.match(/[\u4e00-\u9fff]{2,}/g) ?? []).flatMap((segment) => {
    const pairs: string[] = [];
    for (let index = 0; index < segment.length - 1; index += 1) {
      pairs.push(segment.slice(index, index + 2));
    }
    return pairs;
  });
  return [...new Set([...terms, ...cjkPairs].map((term) => term.toLowerCase()))];
}

function normalizeFileText(file: FileItem): string {
  return `${file.name} ${file.summary} ${file.tags.join(' ')} ${file.contentType ?? ''}`.toLowerCase();
}

function scoreAuthorizedFile(state: DemoState, file: FileItem, terms: string[]): number {
  const haystack = normalizeFileText(file);
  const metadataScore = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
  const chunkScore = (state.fileTextChunks ?? [])
    .filter((chunk) => chunk.fileId === file.id)
    .reduce((score, chunk) => {
      const chunkText = chunk.text.toLowerCase();
      return score + terms.reduce((innerScore, term) => innerScore + (chunkText.includes(term) ? 2 : 0), 0);
    }, 0);
  return metadataScore + chunkScore;
}

const fileQueryStopWords = new Set([
  'latest',
  'newest',
  'file',
  'files',
  'send',
  'share',
  'please',
  'which',
  'what',
  'the',
  '最新',
  '文件',
  '哪个',
  '哪份',
  '一下',
  '帮我',
  '给我'
]);

function lowRisk(reason: string): RiskAssessment {
  return {
    level: 'low',
    score: 0.12,
    reason,
    model: 'risk-mini-v1'
  };
}

function modelToolCalls(aiProvider?: AiProvider, plan?: AgentPlan): string[] {
  if (plan?.risk.model === 'fallback.local_rules') {
    return ['fallback.local_rules'];
  }
  return aiProvider ? ['deepseek.pro.chat.completions'] : ['fallback.local_rules'];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function getPlanStringArg(plan: AgentPlan, tool: string, key: string): string | undefined {
  const value = plan.toolCalls.find((toolCall) => toolCall.tool === tool)?.args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function createCalendarPatch(state: DemoState, roomId: string, text: string):
  | { itemId: string; oldStartsAt: string; newStartsAt: string; title: string }
  | undefined {
  const item = selectCalendarItemForPatch(state, roomId, text);
  if (!item) {
    return undefined;
  }
  const newStartsAt = inferNewStartsAt(item.startsAt, text);
  if (!newStartsAt || newStartsAt === item.startsAt) {
    return undefined;
  }
  return {
    itemId: item.id,
    title: item.title,
    oldStartsAt: item.startsAt,
    newStartsAt
  };
}

function selectCalendarItemForPatch(
  state: DemoState,
  roomId: string,
  text: string
): DemoState['calendar'][number] | undefined {
  const candidates = state.calendar.filter((candidate) => candidate.roomId === roomId);
  if (candidates.length === 0) {
    return undefined;
  }
  const terms = extractMatchingTerms(text);
  const lowered = text.toLowerCase();
  return candidates
    .map((item) => ({
      item,
      score: scoreCalendarPatchCandidate(state, item, terms, lowered)
    }))
    .sort((left, right) =>
      right.score - left.score ||
      right.item.attendees.length - left.item.attendees.length ||
      left.item.startsAt.localeCompare(right.item.startsAt)
    )[0]?.item;
}

function scoreCalendarPatchCandidate(
  state: DemoState,
  item: DemoState['calendar'][number],
  terms: string[],
  loweredText: string
): number {
  const sourceTask = state.tasks.find((task) => task.id === item.sourceTaskId);
  const haystack = [
    item.id,
    item.title,
    item.sourceTaskId ?? '',
    sourceTask?.title ?? '',
    sourceTask?.owners.join(' ') ?? ''
  ].join(' ').toLowerCase();
  let score = item.attendees.length;
  if (item.sourceTaskId) {
    score += 1;
  }
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += Math.max(2, term.length);
    }
  }
  if (
    loweredText.includes('final review') &&
    (item.sourceTaskId === 'task-check' || /review|\u5408\u7a3f|\u68c0\u67e5/.test(item.title.toLowerCase()))
  ) {
    score += 20;
  }
  if (loweredText.includes('meeting') && item.attendees.length > 1) {
    score += 3;
  }
  return score;
}

function createTaskPatch(state: DemoState, roomId: string, text: string):
  | { taskId: string; oldStatus: DemoState['tasks'][number]['status']; newStatus: DemoState['tasks'][number]['status'] }
  | undefined {
  const newStatus = inferRequestedTaskStatus(text);
  if (!newStatus) {
    return undefined;
  }
  const roomMessageIds = new Set(state.messages.filter((message) => message.roomId === roomId).map((message) => message.id));
  const candidates = state.tasks.filter((task) => roomMessageIds.has(task.sourceMessageId));
  const terms = extractMatchingTerms(text);
  const task = candidates.find((candidate) => {
    const haystack = `${candidate.id} ${candidate.title} ${candidate.owners.join(' ')}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
  if (!task || task.status === newStatus) {
    return undefined;
  }
  return {
    taskId: task.id,
    oldStatus: task.status,
    newStatus
  };
}

function inferRequestedTaskStatus(text: string): DemoState['tasks'][number]['status'] | undefined {
  const lowered = text.toLowerCase();
  if (includesAny(text, ['进行中', '处理中', '开始做']) || includesAny(lowered, ['in progress', 'ongoing'])) {
    return 'in_progress';
  }
  if (includesAny(text, ['完成', '已做完', '标记完成']) || includesAny(lowered, ['done', 'complete'])) {
    return 'done';
  }
  if (includesAny(text, ['待处理', '未开始']) || lowered.includes('pending')) {
    return 'pending';
  }
  return undefined;
}

function inferNewStartsAt(oldStartsAt: string, text: string): string | undefined {
  const date = oldStartsAt.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/);
  const time = text.match(/(\d{1,2})[:：](\d{2})/);
  const targetDay = inferTargetWeekday(text);
  if (!date || !time || targetDay === undefined) {
    return undefined;
  }

  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const oldWeekday = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  const deltaDays = (targetDay - oldWeekday + 7) % 7;
  const targetDate = new Date(Date.UTC(year, month - 1, day + deltaDays, 12));
  const targetYear = targetDate.getUTCFullYear();
  const targetMonth = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
  const targetDayOfMonth = String(targetDate.getUTCDate()).padStart(2, '0');
  const hour = String(Number(time[1])).padStart(2, '0');
  const minute = time[2];
  return `${targetYear}-${targetMonth}-${targetDayOfMonth}T${hour}:${minute}:00${date[4]}`;
}

function inferTargetWeekday(text: string): number | undefined {
  const lowered = text.toLowerCase();
  const matches: Array<[number, string[]]> = [
    [1, ['周一', '星期一', 'monday']],
    [2, ['周二', '星期二', 'tuesday']],
    [3, ['周三', '星期三', 'wednesday']],
    [4, ['周四', '星期四', 'thursday']],
    [5, ['周五', '星期五', 'friday']],
    [6, ['周六', '星期六', 'saturday']],
    [0, ['周日', '周天', '星期日', '星期天', 'sunday']]
  ];
  const targetSegment = lowered.split(/改到|改成|调整到|移到|延到|挪到|\bto\b/).pop() ?? lowered;
  const targetMatch = matches.find(([, aliases]) =>
    aliases.some((alias) => targetSegment.includes(alias.toLowerCase()))
  );
  if (targetMatch) {
    return targetMatch[0];
  }

  const orderedMatches = matches.flatMap(([weekday, aliases]) =>
    aliases
      .map((alias) => ({ weekday, index: lowered.lastIndexOf(alias.toLowerCase()) }))
      .filter((match) => match.index >= 0)
  );
  return orderedMatches.sort((left, right) => right.index - left.index)[0]?.weekday;
}

function extractMatchingTerms(text: string): string[] {
  const lowered = text.toLowerCase();
  const ascii = lowered.match(/[a-z0-9_+-]{2,}/g) ?? [];
  const cjk = lowered.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const cjkPairs = cjk.flatMap((segment) => {
    const pairs: string[] = [];
    for (let index = 0; index < segment.length - 1; index += 1) {
      pairs.push(segment.slice(index, index + 2));
    }
    return pairs;
  });
  return [...new Set([...ascii, ...cjk, ...cjkPairs])];
}

function queueActionForConfirmation(
  state: DemoState,
  input: {
    agentId: string;
    roomId: string;
    kind: AgentActionKind;
    input: Record<string, unknown>;
    risk: RiskAssessment;
    log: AgentActionLog;
  }
) {
  const queued = enqueueAgentAction(state, {
    agentId: input.agentId,
    roomId: input.roomId,
    kind: input.kind,
    input: input.input,
    createdAt: input.log.createdAt
  });
  const withLog = {
    ...queued.state,
    actionLogs: [input.log, ...queued.state.actionLogs]
  };
  return requireActionConfirmation(withLog, queued.request.id, input.risk, {
    updatedAt: input.log.createdAt
  });
}

function createLog(input: {
  agentId: string;
  roomId: string;
  action: string;
  risk: RiskAssessment;
  contextIds: string[];
  toolCalls: string[];
  status?: AgentActionLog['status'];
}): AgentActionLog {
  return {
    id: `log-agent-run-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    agentId: input.agentId,
    roomId: input.roomId,
    action: input.action,
    status: input.status ?? 'executed',
    risk: input.risk,
    contextIds: input.contextIds,
    toolCalls: input.toolCalls,
    createdAt: new Date().toISOString()
  };
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function truncateForReply(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}...`;
}

async function handleAgentWebSearch(
  state: DemoState,
  input: AgentRunRequest,
  agent: DemoState['agents'][number],
  plan: AgentPlan,
  aiProvider?: AiProvider,
  progress?: AgentRunProgressOptions,
  webSearchProvider?: WebSearchProvider
): Promise<{ state: DemoState; response: AgentRunResult }> {
  const decision = agentPlanToDecision(plan, input);
  const query =
    getPlanStringArg(plan, 'web.search', 'query') ??
    getPlanStringArg(plan, 'web.search', 'q') ??
    input.userText;
  const plannedToolNames = plan.toolCalls.map((toolCall) => toolCall.tool);

  if (!webSearchProvider) {
    const result: WebSearchAnswer = {
      answer: '外部搜索工具不可用，所以我不能假装已经联网搜索。你可以继续让我基于通用知识回答，或启用 Web 搜索后再查实时信息。',
      results: [],
      citations: [],
      unavailableReason: 'web_search_provider_missing'
    };
    return persistWebSearchResult(state, input, agent, decision.plan, result, {
      toolCalls: uniqueStrings([...modelToolCalls(aiProvider, plan), ...plannedToolNames, 'web.search.unavailable']),
      riskReason: '只读请求，但当前没有可用外部搜索工具；未访问网页、未修改内部状态。'
    });
  }

  emitAgentRunProgress(progress, input, {
    phase: 'executing',
    label: '搜索公开网页',
    detail: query,
    toolCalls: ['web.search']
  });

  let results: WebSearchResultItem[] = [];
  let unavailableReason: string | undefined;
  try {
    results = rankWebSearchResults(await webSearchProvider.search(query, { maxResults: 5 }));
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : 'web_search_failed';
  }

  let answer: string;
  const toolCalls = uniqueStrings([...modelToolCalls(aiProvider, plan), ...plannedToolNames, 'web.search']);
  if (unavailableReason) {
    answer = `外部搜索失败，所以我不能把这次回答说成联网结果。失败原因：${truncateForReply(unavailableReason, 180)}`;
  } else if (results.length === 0) {
    answer = '这次外部搜索没有拿到可用结果，所以我不能编造来源。你可以换一个更具体的关键词再搜。';
  } else {
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '整理搜索结果',
      detail: `${results.length} 个来源`,
      toolCalls: aiProvider ? ['deepseek.pro.chat.completions'] : ['fallback.web_snippets']
    });
    answer = aiProvider
      ? await generateWebSearchAnswer(state, input, query, results, aiProvider)
      : createFallbackWebSearchAnswer(query, results);
  }

  const result: WebSearchAnswer = {
    answer,
    results,
    citations: results.map((item) => item.url),
    unavailableReason
  };
  return persistWebSearchResult(state, input, agent, decision.plan, result, {
    toolCalls: unavailableReason ? uniqueStrings([...toolCalls, 'web.search.failed']) : toolCalls,
    riskReason: '只读外部搜索和回答；未修改内部任务、日程、文件或消息。'
  });
}

async function persistWebSearchResult(
  state: DemoState,
  input: AgentRunRequest,
  agent: DemoState['agents'][number],
  plan: string,
  result: WebSearchAnswer,
  logInput: { toolCalls: string[]; riskReason: string }
): Promise<{ state: DemoState; response: AgentRunResult }> {
  const sourceIds = result.citations.slice(0, 8);
  const memoryWrite = writeMemory(state, {
    agentId: input.agentId,
    scopeRoomIds: [input.roomId, ...agent.allowedRoomIds],
    kind: 'note',
    content: `Web search: ${input.userText} -> ${result.answer.slice(0, 160)}`,
    sourceIds
  });
  const log = createLog({
    agentId: input.agentId,
    roomId: input.roomId,
    action: `agent_run:web_search:${input.userText.slice(0, 60)}`,
    risk: lowRisk(logInput.riskReason),
    contextIds: uniqueStrings([...sourceIds, memoryWrite.memory.id]),
    toolCalls: uniqueStrings([...logInput.toolCalls, 'memory.write'])
  });
  return {
    state: { ...memoryWrite.state, actionLogs: [log, ...memoryWrite.state.actionLogs] },
    response: {
      intent: 'web_search',
      requiresHuman: false,
      plan,
      reasoning: plan,
      result,
      memory: memoryWrite.memory,
      log
    }
  };
}

async function generateWebSearchAnswer(
  state: DemoState,
  input: AgentRunRequest,
  query: string,
  results: WebSearchResultItem[],
  aiProvider: AiProvider
): Promise<string> {
  const systemPrompt = [
    buildAgentSystemPrompt(state, input.agentId),
    '',
    '## Web answer instructions',
    'Answer the user in natural Chinese.',
    'Use only the web snippets as public external sources unless the user explicitly asks to combine the answer with current room context.',
    'Do not mention room messages, member status, tasks, or files when the user only asked for public web information.',
    'Prefer official/vendor documentation over blogs, forums, or SEO pages. If unofficial snippets make claims that official snippets do not confirm, label them as third-party claims instead of facts.',
    'Only state exact current model names, prices, dates, or API parameters when they appear verbatim in the provided snippets. If snippets are insufficient, say that the search snippets do not confirm the exact value.',
    'Cite web results with bracket numbers like [1], [2].',
    'Do not claim you opened pages beyond the snippets. Do not invent source details.'
  ].join('\n');
  const shouldUseRoomContext = includesAny(input.userText, ['结合当前', '结合群聊', '结合这个群', '结合任务', '结合文件', '我们组', '本组']);
  const context = shouldUseRoomContext
    ? buildStructuredContext(state, input.roomId, input.agentId, {
        focus: 'chat',
        userText: input.userText
      })
    : [
        '# Authorized Agent Context',
        buildAgentSystemPrompt(state, input.agentId),
        '',
        'No internal room facts are needed for this web-search answer. Do not mention unrelated room context.'
      ].join('\n');
  const webContext = results
    .map((item, index) => [
      `[${index + 1}] ${item.title}`,
      `URL: ${item.url}`,
      `Snippet: ${item.snippet}`
    ].join('\n'))
    .join('\n\n');
  const requestTail = [
    '## Current User Request',
    `User input: ${input.userText}`,
    `Search query: ${query}`,
    '',
    '## Web search results',
    webContext
  ].join('\n');
  return aiProvider.generateText({
    actorRole: 'personal_agent',
    actorId: input.agentId,
    instructions: systemPrompt,
    input: [context, '', requestTail].join('\n'),
    messages: buildCacheFriendlyMessages(systemPrompt, context, requestTail),
    maxOutputTokens: 650
  });
}

function createFallbackWebSearchAnswer(query: string, results: WebSearchResultItem[]): string {
  const cited = results.slice(0, 3).map((item, index) => {
    return `[${index + 1}] ${item.title}: ${truncateForReply(item.snippet, 160)}`;
  });
  return [`我搜索了“${query}”，可用来源摘要如下：`, ...cited].join('\n');
}

function rankWebSearchResults(results: WebSearchResultItem[]): WebSearchResultItem[] {
  return [...results].sort((left, right) => scoreWebSearchResult(right) - scoreWebSearchResult(left));
}

function scoreWebSearchResult(result: WebSearchResultItem): number {
  try {
    const host = new URL(result.url).hostname.toLowerCase();
    if (host === 'api-docs.deepseek.com' || host === 'docs.deepseek.com') {
      return 100;
    }
    if (host.endsWith('.deepseek.com') || host === 'deepseek.com') {
      return 80;
    }
    if (host.includes('docs.') || host.includes('developer.')) {
      return 30;
    }
  } catch {
    return 0;
  }
  return 0;
}

async function handleAgentChat(
  state: DemoState,
  input: AgentRunRequest,
  aiProvider?: AiProvider,
  decision?: AgentRunDecision,
  progress?: AgentRunProgressOptions
): Promise<{ state: DemoState; response: AgentRunResult }> {
  const agent = state.agents.find((a) => a.id === input.agentId);
  if (!agent) {
    throw new Error(`unknown agent: ${input.agentId}`);
  }

  if (!aiProvider || decision?.usedFallback) {
    const fallback = createFallbackChatReply(state, input);
    const plan = decision?.plan ?? fallbackPlanForIntent('chat');
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '写入 Agent 记忆',
      detail: `${fallback.contextIds.length} 个来源`,
      toolCalls: ['memory.write']
    });
    const memoryWrite = writeMemory(state, {
      agentId: input.agentId,
      scopeRoomIds: [input.roomId],
      kind: 'note',
      content: `自由对话：${input.userText} -> ${fallback.reply.slice(0, 120)}`,
      sourceIds: fallback.contextIds
    });
    const log = createLog({
      agentId: input.agentId,
      roomId: input.roomId,
      action: `agent_run:chat:fallback`,
      risk: lowRisk('本地降级自由对话；未调用外部搜索，未修改内部状态。'),
      contextIds: [...fallback.contextIds, memoryWrite.memory.id],
      toolCalls: uniqueStrings(['fallback.local_rules', 'fallback.local_context', 'memory.write'])
    });
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: '写入运行日志',
      detail: log.action,
      toolCalls: log.toolCalls,
      riskLevel: log.risk.level
    });
    return {
      state: { ...memoryWrite.state, actionLogs: [log, ...memoryWrite.state.actionLogs] },
      response: {
        intent: 'chat',
        requiresHuman: false,
        plan,
        reasoning: plan,
        result: { reply: fallback.reply } as ChatResult,
        memory: memoryWrite.memory,
        log
      }
    };
  }

  let replyText = decision?.answer;
  let usedFallbackReply = false;
  let fallbackContextIds: string[] = [];
  if (!replyText) {
    try {
      replyText = await generateChatReply(state, input, aiProvider);
    } catch {
      const fallback = createFallbackChatReply(state, input);
      replyText = fallback.reply;
      fallbackContextIds = fallback.contextIds;
      usedFallbackReply = true;
    }
  }
  const plan = decision?.plan ?? fallbackPlanForIntent('chat');

  emitAgentRunProgress(progress, input, {
    phase: 'executing',
    label: '写入 Agent 记忆',
    detail: '保存本次回答摘要',
    toolCalls: ['memory.write']
  });
  const memoryWrite = writeMemory(state, {
    agentId: input.agentId,
    scopeRoomIds: [input.roomId],
    kind: 'note',
    content: `自由对话：${input.userText} -> ${replyText.slice(0, 120)}`,
    sourceIds: fallbackContextIds
  });

  const log = createLog({
    agentId: input.agentId,
    roomId: input.roomId,
    action: `agent_run:chat:${input.userText.slice(0, 60)}`,
    risk: lowRisk('自由对话回复；可使用通用模型能力，未修改内部任务、日程、文件或消息。'),
    contextIds: [...fallbackContextIds, memoryWrite.memory.id],
    toolCalls: [
      'deepseek.pro.chat.completions',
      ...(usedFallbackReply ? ['fallback.local_context'] : []),
      'memory.write'
    ]
  });
  emitAgentRunProgress(progress, input, {
    phase: 'executing',
    label: '写入运行日志',
    detail: log.action,
    toolCalls: log.toolCalls,
    riskLevel: log.risk.level
  });

  return {
    state: { ...memoryWrite.state, actionLogs: [log, ...memoryWrite.state.actionLogs] },
    response: {
      intent: 'chat',
      requiresHuman: false,
      plan,
      reasoning: plan,
      result: { reply: replyText } as ChatResult,
      memory: memoryWrite.memory,
      log
    }
  };
}

function createFallbackChatReply(
  state: DemoState,
  input: AgentRunRequest
): { reply: string; contextIds: string[] } {
  const agent = state.agents.find((candidate) => candidate.id === input.agentId);
  const owner = state.users.find((candidate) => candidate.id === agent?.ownerId);
  const room = state.rooms.find((candidate) => candidate.id === input.roomId);
  const roomMessages = state.messages.filter((message) => message.roomId === input.roomId);
  const text = input.userText;
  const lowered = text.toLowerCase();
  const chunkMatches = searchFileTextChunks(state, {
    agentId: input.agentId,
    roomId: input.roomId,
    query: input.userText,
    limit: 3
  }).filter((match) => match.score >= 4);
  if (chunkMatches.length > 0) {
    const top = chunkMatches[0];
    const otherFiles = uniqueStrings(chunkMatches.slice(1).map((match) => match.file.name)).filter(
      (name) => name !== top.file.name
    );
    const suffix = otherFiles.length > 0 ? `；另外也命中了 ${otherFiles.join('、')}` : '';
    return {
      reply: `在授权文件《${top.file.name}》的文本内容里提到。相关片段：${truncateForReply(top.chunk.text, 180)}${suffix}。`,
      contextIds: uniqueStrings([
        top.file.id,
        top.chunk.id,
        ...chunkMatches.flatMap((match) => [match.file.id, match.chunk.id])
      ])
    };
  }

  if (!agent || !owner) {
    return { reply: '我无法确认当前 Agent 身份，因此不能继续处理。', contextIds: [] };
  }

  if (includesAny(text, ['私聊', '私信']) || lowered.includes('private')) {
    return {
      reply: `我不能读取未授权的私聊或其他房间内容。当前只能基于 ${owner.name} 授权给我的房间和文件回答。`,
      contextIds: []
    };
  }

  if (
    includesAny(text, ['你是谁', '能代谁', '代表谁', '代谁发']) ||
    (lowered.includes('who') && (lowered.includes('act') || lowered.includes('agent')))
  ) {
    return {
      reply: `我是 ${owner.name} 的个人 Agent，只能在 ${owner.name} 授权的房间内读取上下文，并在授权边界内代 ${owner.name} 查找或发送文件。涉及他人身份、私聊、日程变更或高风险操作时，我会要求人工确认。`,
      contextIds: []
    };
  }

  if (includesAny(text, ['访谈', '纪要']) || lowered.includes('interview')) {
    const evidence = roomMessages
      .filter((message) => includesAny(message.body, ['访谈', '纪要']) || message.body.toLowerCase().includes('interview'))
      .slice(-4);
    const contextIds = evidence.map((message) => message.id);
    const mentionsChen = evidence.some((message) => message.senderName.includes('陈晨') || message.body.includes('陈晨'));
    const files = findAuthorizedFiles(state, input.agentId, input.roomId, text).filter((file) =>
      includesAny(`${file.name} ${file.summary} ${file.tags.join(' ')}`, ['访谈', '纪要']) ||
      `${file.name} ${file.summary} ${file.tags.join(' ')}`.toLowerCase().includes('interview')
    );
    if (includesAny(text, ['不要发', '先不发', '先不要发', '别发']) || lowered.includes('do not send')) {
      const fileText = files[0] ? `我找到了可见文件《${files[0].name}》，但不会发送。` : '我暂时没有匹配到可见的访谈文件，也不会发送任何内容。';
      return { reply: `${fileText} 如果你要我继续，只能先做风险评估或等你明确授权。`, contextIds: [...contextIds, ...files.map((file) => file.id)] };
    }
    if (mentionsChen) {
      return {
        reply: `从当前房间上下文看，访谈材料主要由陈晨补充和核对；${owner.name} 这边可见的访谈相关文件我可以先帮你查找，但代发前需要确认目标文件和授权。`,
        contextIds: [...contextIds, ...files.map((file) => file.id)]
      };
    }
  }

  if (includesAny(text, ['先做', '优先', '哪件事']) || lowered.includes('first')) {
    const activeTasks = [...state.tasks]
      .filter((task) => task.status !== 'done')
      .sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime())
      .slice(0, 2);
    if (activeTasks.length > 0) {
      return {
        reply: `建议先处理「${activeTasks[0].title}」，截止时间是 ${activeTasks[0].deadline}。${activeTasks[1] ? `之后跟进「${activeTasks[1].title}」。` : ''}`,
        contextIds: activeTasks.map((task) => task.sourceMessageId)
      };
    }
  }

  const recent = roomMessages.slice(-3);
  return {
    reply: `我可以基于 ${room?.name ?? input.roomId} 的授权消息、任务和文件回答。当前没有外部 LLM 可用，所以我只能做本地上下文检索；你可以问截止时间、负责人、可见文件，或要求我评估是否能代发。`,
    contextIds: recent.map((message) => message.id)
  };
}

async function generateChatReply(state: DemoState, input: AgentRunRequest, aiProvider: AiProvider): Promise<string> {
  const systemPrompt = [
    buildAgentSystemPrompt(state, input.agentId),
    '',
    '## 自由对话指引',
    '你可以回答用户的任何问题，基于当前对话上下文和可用信息。',
    '优先依据消息、任务、文件元数据和文件片段；Agent memory 只是较低可信的历史笔记，不能单独作为事实依据。',
    '不要编造未明确出现的细节，例如编号差异、对方私聊内容、文件正文。若只是推断，必须明确说“我只能推断”。',
    '如果用户的请求涉及到文件分享、日程协调等操作，请说明你的分析和建议。',
    '如果你不确定答案，诚实说明并建议用户如何获取准确信息。',
    '请用自然的中文回答。'
  ].join('\n');

  const context = buildStructuredContext(state, input.roomId, input.agentId, {
    focus: 'chat',
    userText: input.userText
  });
  const requestTail = ['## Current User Request', `User input: ${input.userText}`].join('\n');
  const userPrompt = [context, '', requestTail].join('\n');

  return aiProvider.generateText({
    actorRole: 'personal_agent',
    actorId: input.agentId,
    instructions: systemPrompt,
    input: userPrompt,
    messages: buildCacheFriendlyMessages(systemPrompt, context, requestTail),
    maxOutputTokens: 500
  });
}

export function buildCacheFriendlyMessages(
  systemPrompt: string,
  context: string,
  requestTail: string
): AiTextPrompt['messages'] {
  const { stable, volatile } = splitContextForPrefixCache(context);
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: stable },
    { role: 'user', content: [volatile, requestTail].filter(Boolean).join('\n\n') }
  ];
}

function splitContextForPrefixCache(context: string): { stable: string; volatile: string } {
  const blocks = context.split(/\n(?=## )/);
  if (blocks.length <= 1) {
    return { stable: context, volatile: '' };
  }

  const stableSections = [blocks[0]];
  const volatileSections: string[] = [];
  const stableTitles = new Set(['Tasks', 'Files', 'Members']);

  for (const block of blocks.slice(1)) {
    const title = block.match(/^## ([^\n]+)/)?.[1]?.trim();
    if (title && stableTitles.has(title)) {
      stableSections.push(block);
    } else {
      volatileSections.push(block);
    }
  }

  return {
    stable: stableSections.filter(Boolean).join('\n\n'),
    volatile: volatileSections.filter(Boolean).join('\n\n')
  };
}
