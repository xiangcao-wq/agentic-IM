import type {
  AgentActionLog,
  CoordinationResult,
  DeadlineAnswer,
  DemoState,
  FileItem,
  FileShareAction,
  Message,
  PersonalAgent,
  RiskAssessment,
  RoomSummary
} from './types';
import { buildStructuredContext, buildAgentSystemPrompt } from './memory';
import type { AiProvider } from '../server/aiProvider';

interface DeadlineQuestionInput {
  agentId: string;
  roomId: string;
  question: string;
}

interface FileShareInput {
  agentId: string;
  roomId: string;
  targetRoomId?: string;
  requesterId: string;
  requestText: string;
  fileId?: string;
  fileVersion?: number;
}

interface CoordinationInput {
  fromAgentId: string;
  toAgentId: string;
  roomId: string;
  proposal: string;
}

const lowRiskModel = 'risk-mini-v1';

/* ═══════════════════════════════════════════════════════════
 *  1. summarizeRoom
 * ═══════════════════════════════════════════════════════════ */

export async function summarizeRoom(
  state: DemoState,
  roomId: string,
  agentId: string,
  aiProvider?: AiProvider
): Promise<RoomSummary> {
  if (!aiProvider) return summarizeRoomFallback(state, roomId, agentId);

  try {
    const agentPrompt = buildAgentSystemPrompt(state, agentId);
    const systemPrompt = [
      agentPrompt,
      '',
      '## 当前任务',
      '你负责总结群聊对话。请分析对话内容，提取关键信息、截止日期、待办事项和重要决定。',
      '',
      '请严格以 JSON 格式回复，不要包含任何其他文字。JSON 格式如下：',
      '{"headline":"一句话总结","deadlines":["截止日期1"],"todos":["待办1"],"sources":["消息或文件ID"]}'
    ].join('\n');

    const context = buildStructuredContext(state, roomId, agentId, { focus: 'summary' });
    const userPrompt = [
      context,
      '',
      '## Current Request',
      'Summarize this room from the authorized context above.'
    ].join('\n');

    const raw = await aiProvider.generateText({
      actorRole: 'personal_agent',
      actorId: agentId,
      instructions: systemPrompt,
      input: userPrompt,
      responseFormat: 'json_object',
      maxOutputTokens: 400
    });

    const parsed = parseJson<{
      headline: string;
      deadlines: string[];
      todos?: string[];
      openQuestions?: string[];
      sources?: string[];
    }>(raw);
    const sources = buildExistingContextIds(state, parsed.sources ?? []);
    if (sources.length === 0) {
      return summarizeRoomFallback(state, roomId, agentId);
    }

    return {
      headline: parsed.headline,
      deadlines: parsed.deadlines ?? [],
      todos: parsed.todos ?? parsed.openQuestions ?? [],
      sources
    };
  } catch {
    return summarizeRoomFallback(state, roomId, agentId);
  }
}

function summarizeRoomFallback(state: DemoState, roomId: string, agentId: string): RoomSummary {
  const agent = getAgent(state, agentId);
  ensureRoomAccess(agent, roomId);

  const accessibleRoomIds = new Set([roomId, ...agent.allowedRoomIds]);
  const roomMessages = state.messages.filter((message) => accessibleRoomIds.has(message.roomId));
  const relatedTasks = state.tasks.filter((task) =>
    roomMessages.some((message) => message.id === task.sourceMessageId)
  );
  if (roomMessages.length === 0 && relatedTasks.length === 0) {
    return {
      headline: '我在当前授权上下文里没有找到可用于总结这个房间的消息或任务证据。',
      deadlines: [],
      todos: [],
      sources: []
    };
  }
  const requirementMessages = roomMessages.filter((message) =>
    includesAny(message.body, ['截止', '提交', '演示稿', '调研报告', '合稿'])
  );
  const deadlines = unique(relatedTasks.map((task) => task.deadline).filter((deadline) => deadline.includes('5月12日')));
  const todos = [
    ...relatedTasks
      .filter((task) => task.id !== 'task-report')
      .map((task) =>
        task.id === 'task-slides'
          ? '林雯整理已完成的演示稿 v3'
          : `${task.deadline} 前完成${task.title.replace('最后一次', '最后一次')}`
      )
  ];

  return {
    headline: '信息系统作业小组需要在 5月12日 23:59 前提交调研报告和演示稿。',
    deadlines: deadlines.length > 0 ? deadlines : ['5月12日 23:59'],
    todos: unique(todos),
    sources: unique([...requirementMessages.map((message) => message.id), ...relatedTasks.map((task) => task.sourceMessageId)])
  };
}

/* ═══════════════════════════════════════════════════════════
 *  2. answerDeadlineQuestion
 * ═══════════════════════════════════════════════════════════ */

export async function answerDeadlineQuestion(
  state: DemoState,
  input?: DeadlineQuestionInput,
  aiProvider?: AiProvider
): Promise<DeadlineAnswer> {
  if (!input) return { answer: '', citations: [] };
  if (!aiProvider) return answerDeadlineQuestionFallback(state, input);

  try {
    const agentPrompt = buildAgentSystemPrompt(state, input.agentId);
    const systemPrompt = [
      agentPrompt,
      '',
      '## 当前任务',
      '你负责根据群聊上下文和任务信息回答关于截止日期的问题。请提供准确、有帮助的回答。',
      '',
      '请严格以 JSON 格式回复，不要包含任何其他文字。JSON 格式如下：',
      '{"answer":"你的回答","sources":["引用的消息或文件ID"],"confidence":0.95}'
    ].join('\n');

    const context = buildStructuredContext(state, input.roomId, input.agentId, {
      focus: 'deadline',
      userText: input.question
    });
    const userPrompt = [
      context,
      '',
      '## Current User Question',
      input.question
    ].join('\n');

    const raw = await aiProvider.generateText({
      actorRole: 'personal_agent',
      actorId: input.agentId,
      instructions: systemPrompt,
      input: userPrompt,
      responseFormat: 'json_object',
      maxOutputTokens: 300
    });

    const parsed = parseJson<{
      answer: string;
      sources?: string[];
      confidence?: number;
    }>(raw);
    const citations = buildExistingContextIds(state, parsed.sources ?? []);
    if (citations.length === 0) {
      return answerDeadlineQuestionFallback(state, input);
    }

    return {
      answer: parsed.answer,
      citations
    };
  } catch {
    return answerDeadlineQuestionFallback(state, input);
  }
}

function answerDeadlineQuestionFallback(state: DemoState, input: DeadlineQuestionInput): DeadlineAnswer {
  const agent = getAgent(state, input.agentId);
  ensureRoomAccess(agent, input.roomId);
  const accessibleRoomIds = new Set(agent.allowedRoomIds);
  const relevantMessages = state.messages.filter(
    (message) => accessibleRoomIds.has(message.roomId) && includesAny(message.body, ['截止', '提交', '调研报告', '演示稿'])
  );
  const relevantFiles = state.files.filter(
    (file) =>
      accessibleRoomIds.has(file.roomId) &&
      file.visibility === 'room' &&
      includesAny(file.summary, ['截止', '提交', '调研报告'])
  );
  if (relevantMessages.length === 0 && relevantFiles.length === 0) {
    return {
      answer: '我在当前授权上下文里没有找到明确的截止时间证据，因此不能确认具体提交时间。你可以同步最新群聊或提供课程要求文件后再让我检查。',
      citations: []
    };
  }
  const citations = unique([...relevantMessages.map((message) => message.id), ...relevantFiles.map((file) => file.id)]);
  const deadline = extractDeadline([...relevantMessages.map((message) => message.body), ...relevantFiles.map((file) => file.summary)]);
  if (!deadline) {
    return {
      answer: '我在当前授权上下文里找到了和提交/截止相关的内容，但没有找到明确的截止时间，因此不能确认具体提交时间。',
      citations
    };
  }
  const baseAnswer = `这次信息系统作业的截止时间是 ${deadline}，需要提交调研报告 PDF 和 8 分钟课堂演示稿。`;
  const remainingDays = estimateRemainingDays(deadline);
  const answer =
    remainingDays !== null && asksRemainingTime(input.question)
      ? `${baseAnswer} 距离截止还有大约 ${remainingDays} 天。`
      : baseAnswer;

  return {
    answer,
    citations
  };
}

/* ═══════════════════════════════════════════════════════════
 *  3. createFileShareAction
 * ═══════════════════════════════════════════════════════════ */

export async function createFileShareAction(
  state: DemoState,
  input?: FileShareInput,
  options: { forceExecute?: boolean } = {},
  aiProvider?: AiProvider
): Promise<FileShareAction> {
  if (!input) throw new Error('file share input is required');
  if (!aiProvider) return createFileShareActionFallback(state, input, options);

  try {
    const agentPrompt = buildAgentSystemPrompt(state, input.agentId);
    const systemPrompt = [
      agentPrompt,
      '',
      '## 当前任务',
      '你负责评估文件分享请求的合理性和风险。分析请求者身份、请求内容、可用文件，判断应该分享哪个文件，并评估风险等级。',
      '',
      '风险评估标准：',
      '- low：请求来自同组成员，目标文件已授权，动作可控',
      '- medium：请求意图不够明确或文件匹配不确定',
      '- high：请求者未知、文件未授权或存在安全隐患',
      '',
      '请严格以 JSON 格式回复，不要包含任何其他文字。JSON 格式如下：',
      '{"matchedFileId":"文件ID或null","risk":{"level":"low","score":0.18,"reason":"风险说明"},"reasoning":"决策理由"}'
    ].join('\n');

    const context = buildStructuredContext(state, input.roomId, input.agentId, {
      focus: 'file_share',
      userText: input.requestText
    });
    const userPrompt = [
      context,
      '',
      '## Current File Request',
      `Requester: ${input.requesterId}`,
      `Request text: ${input.requestText}`
    ].join('\n');

    const raw = await aiProvider.generateText({
      actorRole: 'personal_agent',
      actorId: input.agentId,
      instructions: systemPrompt,
      input: userPrompt,
      responseFormat: 'json_object',
      maxOutputTokens: 300
    });

    const parsed = parseJson<{
      matchedFileId: string | null;
      risk: { level: 'low' | 'medium' | 'high'; score: number; reason: string };
      reasoning?: string;
    }>(raw);

    const agent = getAgent(state, input.agentId);
    ensureRoomAccess(agent, input.roomId);
    const targetRoomId = input.targetRoomId ?? input.roomId;
    ensureRoomAccess(agent, targetRoomId);
    const owner = state.users.find((user) => user.id === agent.ownerId);

    const explicitFile = input.fileId
      ? findAuthorizedShareableFileById(state, agent.ownerId, input.roomId, input.fileId, input.fileVersion)
      : undefined;
    const file = explicitFile ?? (parsed.matchedFileId
      ? findAuthorizedShareableFileById(state, agent.ownerId, input.roomId, parsed.matchedFileId) ??
        findNewestShareableFile(state, agent.ownerId, input.roomId, input.requestText)
      : input.fileId
        ? undefined
        : findNewestShareableFile(state, agent.ownerId, input.roomId, input.requestText));

    const risk: RiskAssessment = explicitFile && hasDownloadableBacking(explicitFile)
      ? explicitFileShareRisk()
      : {
      level: parsed.risk.level,
      score: parsed.risk.score,
      reason: parsed.risk.reason,
      model: 'llm-driven'
    };

    const gatedRisk: RiskAssessment = file && !hasDownloadableBacking(file)
      ? {
          ...risk,
          level: risk.level === 'high' ? 'high' : 'medium',
          score: Math.max(risk.score, 0.55),
          reason: `${risk.reason} 文件只有元数据，没有 Matrix 或本地可下载文件备份，不能自动代发。`
        }
      : file && targetRoomId !== input.roomId
        ? {
            ...risk,
            level: risk.level === 'high' ? 'high' : 'medium',
            score: Math.max(risk.score, 0.58),
            reason: `${risk.reason} 目标房间不同于文件来源房间，需要人工确认跨房间代发。`
          }
      : risk;
    const canExecuteShare =
      hasDownloadableBacking(file) &&
      Boolean(file?.agentCanShare) &&
      (gatedRisk.level === 'low' || options.forceExecute);
    const status = file && canExecuteShare ? 'executed' : 'needs_confirmation';
    const message =
      status === 'executed' && file && owner
        ? createAgentFileMessage({ agent, file, ownerName: owner.name, roomId: targetRoomId })
        : undefined;
    const log = createActionLog({
      agentId: agent.id,
      roomId: input.roomId,
      action:
        status === 'executed'
          ? `代发文件：${file?.name ?? '未找到文件'}`
          : '文件代发需要人工确认',
      status,
      risk: gatedRisk,
      contextIds: buildExistingContextIds(state, [input.fileId, file?.id]),
      toolCalls: ['llm.evaluate', 'room_search', 'file_library.lookup_latest', ...(message ? ['matrix.send_event'] : [])]
    });

    return { status, requiresHuman: status !== 'executed', risk: gatedRisk, file, message, log };
  } catch {
    return createFileShareActionFallback(state, input, options);
  }
}

function createFileShareActionFallback(
  state: DemoState,
  input: FileShareInput,
  options: { forceExecute?: boolean } = {}
): FileShareAction {
  const agent = getAgent(state, input.agentId);
  ensureRoomAccess(agent, input.roomId);
  const targetRoomId = input.targetRoomId ?? input.roomId;
  ensureRoomAccess(agent, targetRoomId);
  const owner = state.users.find((user) => user.id === agent.ownerId);
  const requester = state.users.find((user) => user.id === input.requesterId);
  const file = input.fileId
    ? findAuthorizedShareableFileById(state, agent.ownerId, input.roomId, input.fileId, input.fileVersion)
    : findNewestShareableFile(state, agent.ownerId, input.roomId, input.requestText);
  const baseRisk = input.fileId && requester && file && hasDownloadableBacking(file)
    ? explicitFileShareRisk()
    : assessFileShareRisk(Boolean(requester), file, input.requestText);
  const risk = file && targetRoomId !== input.roomId
    ? {
        ...baseRisk,
        level: baseRisk.level === 'high' ? 'high' : 'medium',
        score: Math.max(baseRisk.score, 0.58),
        reason: `${baseRisk.reason} 目标房间不同于文件来源房间，需要人工确认跨房间代发。`
      } as RiskAssessment
    : baseRisk;
  const status = file && (risk.level === 'low' || options.forceExecute) ? 'executed' : 'needs_confirmation';
  const message =
    status === 'executed' && file && owner
      ? createAgentFileMessage({
          agent,
          file,
          ownerName: owner.name,
          roomId: targetRoomId
        })
      : undefined;
  const log = createActionLog({
    agentId: agent.id,
    roomId: input.roomId,
    action:
      status === 'executed'
        ? `代发文件：${file?.name ?? '未找到文件'}`
        : '文件代发需要人工确认',
    status,
    risk,
    contextIds: buildExistingContextIds(state, [input.fileId, file?.id]),
    toolCalls: ['room_search', 'file_library.lookup_latest', ...(message ? ['matrix.send_event'] : [])]
  });

  return {
    status,
    requiresHuman: status !== 'executed',
    risk,
    file,
    message,
    log
  };
}

/* ═══════════════════════════════════════════════════════════
 *  4. coordinateAgents
 * ═══════════════════════════════════════════════════════════ */

export async function coordinateAgents(
  state: DemoState,
  input?: CoordinationInput,
  aiProvider?: AiProvider
): Promise<CoordinationResult> {
  if (!input) throw new Error('coordination input is required');
  if (!aiProvider) return coordinateAgentsFallback(state, input);

  try {
    const agentPrompt = buildAgentSystemPrompt(state, input.toAgentId);
    const systemPrompt = [
      agentPrompt,
      '',
      '## 当前任务',
      '你负责分析日程变更对团队的影响。检测消息中的日程变更意图，评估风险，决定是否需要人工确认。',
      '',
      '风险评估标准：',
      '- low：不涉及日程变更或影响范围极小',
      '- medium：日程影响范围有限，建议记录协商过程',
      '- high：修改多人日程、声称默认同意、超过可自动执行边界',
      '',
      '请严格以 JSON 格式回复，不要包含任何其他文字。JSON 格式如下：',
      '{"hasScheduleChange":true,"risk":{"level":"high","score":0.82,"reason":"风险说明"},"suggestion":"建议方案","reasoning":"分析过程"}'
    ].join('\n');

    const context = buildStructuredContext(state, input.roomId, input.toAgentId, {
      focus: 'coordinate',
      userText: input.proposal
    });
    const userPrompt = [
      context,
      '',
      '## Current Coordination Proposal',
      `From agent: ${input.fromAgentId}`,
      `Proposal: ${input.proposal}`
    ].join('\n');

    const raw = await aiProvider.generateText({
      actorRole: 'personal_agent',
      actorId: input.toAgentId,
      instructions: systemPrompt,
      input: userPrompt,
      responseFormat: 'json_object',
      maxOutputTokens: 300
    });

    const parsed = parseJson<{
      hasScheduleChange: boolean;
      risk: { level: 'low' | 'medium' | 'high'; score: number; reason: string };
      suggestion: string;
      reasoning?: string;
    }>(raw);

    const fromAgent = getAgent(state, input.fromAgentId);
    const toAgent = getAgent(state, input.toAgentId);
    ensureRoomAccess(fromAgent, input.roomId);
    ensureRoomAccess(toAgent, input.roomId);

    const risk: RiskAssessment = {
      level: parsed.risk.level,
      score: parsed.risk.score,
      reason: parsed.risk.reason,
      model: 'llm-driven'
    };

    const status = risk.level === 'low' ? 'executed' : 'needs_confirmation';
    const proposedPlan = parsed.suggestion;
    const log = createActionLog({
      agentId: toAgent.id,
      roomId: input.roomId,
      action: `处理来自 ${fromAgent.displayName} 的日程协调提案`,
      status,
      risk,
      contextIds: buildExistingContextIds(state, ['cal-review', 'task-check']),
      toolCalls: ['llm.evaluate', 'calendar.inspect', 'agent_to_agent.negotiate']
    });

    return { status, requiresHuman: status !== 'executed', risk, proposedPlan, log };
  } catch {
    return coordinateAgentsFallback(state, input);
  }
}

function coordinateAgentsFallback(state: DemoState, input: CoordinationInput): CoordinationResult {
  const fromAgent = getAgent(state, input.fromAgentId);
  const toAgent = getAgent(state, input.toAgentId);
  ensureRoomAccess(fromAgent, input.roomId);
  ensureRoomAccess(toAgent, input.roomId);
  const risk = assessCoordinationRisk(input.proposal);
  const status = risk.level === 'low' ? 'executed' : 'needs_confirmation';
  const proposedPlan =
    status === 'needs_confirmation'
      ? '建议先在群里确认所有成员是否同意改到周三 23:00；确认后再由 Agent 更新日程和任务。'
      : '两个 Agent 已确认当前时间不影响已授权日程，可自动更新任务安排。';
  const log = createActionLog({
    agentId: toAgent.id,
    roomId: input.roomId,
    action: `处理来自 ${fromAgent.displayName} 的日程协调提案`,
    status,
    risk,
    contextIds: buildExistingContextIds(state, ['cal-review', 'task-check']),
    toolCalls: ['calendar.inspect', 'agent_to_agent.negotiate']
  });

  return {
    status,
    requiresHuman: status !== 'executed',
    risk,
    proposedPlan,
    log
  };
}

/* ═══════════════════════════════════════════════════════════
 *  Shared helpers
 * ═══════════════════════════════════════════════════════════ */

function parseJson<T>(raw: string): T {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  return JSON.parse(cleaned) as T;
}

function getAgent(state: DemoState, agentId: string): PersonalAgent {
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error(`unknown agent: ${agentId}`);
  }
  return agent;
}

function ensureRoomAccess(agent: PersonalAgent, roomId: string): void {
  if (!agent.allowedRoomIds.includes(roomId)) {
    throw new Error(`${agent.displayName} cannot read room ${roomId}`);
  }
}

function findNewestShareableFile(state: DemoState, ownerId: string, roomId: string, requestText: string): FileItem | undefined {
  const wantsSlides = includesAny(requestText, ['演示稿', 'ppt', 'PPT', 'slides']);
  const searchTerms = buildFileSearchTerms(requestText);
  const candidates = state.files.filter(
    (file) =>
      file.uploaderId === ownerId &&
      file.roomId === roomId &&
      file.visibility === 'room' &&
      file.agentCanShare &&
      (!wantsSlides ||
        includesAny(`${file.name} ${file.summary} ${file.contentType ?? ''}`.toLowerCase(), [
          '演示稿',
          'pptx',
          'powerpoint',
          'presentation',
          'slide deck',
          'slides deck'
        ]))
  );
  const scored = candidates.map((file) => ({
    file,
    score: scoreFileAgainstRequest(file, searchTerms)
  }));
  const relevant = searchTerms.length > 0 ? scored.filter((candidate) => candidate.score > 0) : scored;

  return [...relevant].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.file.version - a.file.version || b.file.updatedAt.localeCompare(a.file.updatedAt);
  })[0]?.file;
}

function findAuthorizedShareableFileById(
  state: DemoState,
  ownerId: string,
  roomId: string,
  fileId: string,
  fileVersion?: number
): FileItem | undefined {
  return state.files.find(
    (file) =>
      file.id === fileId &&
      (fileVersion === undefined || file.version === fileVersion) &&
      file.uploaderId === ownerId &&
      file.roomId === roomId &&
      file.visibility === 'room' &&
      file.agentCanShare
  );
}

function assessFileShareRisk(requesterKnown: boolean, file: FileItem | undefined, requestText: string): RiskAssessment {
  if (!requesterKnown || !file) {
    return {
      level: 'high',
      score: 0.86,
      reason: '请求者或可代发文件无法确认，需要用户介入。',
      model: lowRiskModel
    };
  }

  if (!file.agentCanShare || file.visibility !== 'room') {
    return {
      level: 'high',
      score: 0.91,
      reason: '目标文件未授权 Agent 代发或不属于群可见范围。',
      model: lowRiskModel
    };
  }

  if (!hasDownloadableBacking(file) || !file.contentType || !file.size) {
    return {
      level: 'medium',
      score: 0.58,
      reason: '已匹配到授权文件，但缺少可下载媒体元数据，发送前需要用户确认或重新上传真实文件。',
      model: lowRiskModel
    };
  }

  const asksLatestSharedFile = includesAny(requestText, [
    '最新',
    '发一下',
    '演示稿',
    '行动计划',
    '图片',
    '图像',
    '照片',
    '海报',
    '素材',
    '昨晚生成'
  ]) ||
    includesAny(requestText.toLowerCase(), ['action plan', 'slides', 'send', 'plan', 'image', 'picture', 'poster']);
  return {
    level: asksLatestSharedFile ? 'low' : 'medium',
    score: asksLatestSharedFile ? 0.18 : 0.48,
    reason: asksLatestSharedFile
      ? '请求来自同组成员，目标文件是上传者授权的群内最新版本，动作可控。'
      : '请求意图不够明确，建议确认后执行。',
    model: lowRiskModel
  };
}

function explicitFileShareRisk(): RiskAssessment {
  return {
    level: 'low',
    score: 0.16,
    reason: '用户已在授权文件列表中明确选择目标文件，且文件具备可下载媒体备份。',
    model: lowRiskModel
  };
}

function buildFileSearchTerms(requestText: string): string[] {
  const lowered = requestText.toLowerCase();
  const terms = lowered
    .split(/[\s,，。！？:：;；'"""''()（）]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !fileRequestStopWords.has(term));

  if (requestText.includes('行动计划') || lowered.includes('action plan')) {
    terms.push('行动计划', 'action', 'plan');
  }
  if (includesAny(requestText, ['演示稿', 'ppt', 'PPT']) || lowered.includes('slides')) {
    terms.push('演示稿', 'pptx', 'slides');
  }
  if (
    includesAny(requestText, ['图片', '图像', '照片', '海报', '素材', '昨晚生成']) ||
    includesAny(lowered, ['image', 'picture', 'photo', 'poster', 'visual', 'asset', 'svg'])
  ) {
    terms.push('图片', '图像', '照片', '海报', '素材', 'image', 'picture', 'poster', 'svg');
  }
  if (includesAny(requestText, ['访谈', '纪要']) || lowered.includes('interview')) {
    terms.push('访谈', '纪要', 'interview');
  }

  return unique(terms);
}

function scoreFileAgainstRequest(file: FileItem, terms: string[]): number {
  const haystack = `${file.name} ${file.tags.join(' ')} ${file.summary} ${file.contentType ?? ''}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0);
}

const fileRequestStopWords = new Set([
  'please',
  'send',
  'the',
  'file',
  'latest',
  'newest',
  '给我',
  '帮我',
  '发一下',
  '最新'
]);

function assessCoordinationRisk(proposal: string): RiskAssessment {
  const changesCalendar = includesAny(proposal, ['改到', '默认大家都同意', '周三 23:00']);
  return {
    level: changesCalendar ? 'high' : 'medium',
    score: changesCalendar ? 0.82 : 0.54,
    reason: changesCalendar
      ? '该提案会修改多人日程且声称默认同意，超过可自动执行边界。'
      : '日程影响范围有限，但仍建议记录协商过程。',
    model: lowRiskModel
  };
}

function createAgentFileMessage(input: {
  agent: PersonalAgent;
  ownerName: string;
  roomId: string;
  file: FileItem;
}): Message {
  return {
    id: `msg-agent-share-${input.file.id}`,
    roomId: input.roomId,
    senderId: input.agent.ownerId,
    senderName: input.agent.displayName,
    body: `我代表${input.ownerName}发送最新文件：${input.file.name}`,
    sentAt: '2026-05-04T14:06:12+08:00',
    type: 'file',
    agentLabel: `${input.ownerName}的 Agent 代发`,
    sourceAgentId: input.agent.id,
    fileId: input.file.id,
    mxcUri: input.file.mxcUri,
    contentType: input.file.contentType,
    size: input.file.size
  };
}

function hasDownloadableBacking(file: FileItem | undefined): boolean {
  return Boolean(file?.mxcUri || file?.localPath);
}

function createActionLog(input: Omit<AgentActionLog, 'id' | 'createdAt'>): AgentActionLog {
  return {
    id: `log-${input.agentId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    ...input
  };
}

function buildExistingContextIds(state: DemoState, ids: Array<string | undefined>): string[] {
  const existingIds = new Set([
    ...state.messages.map((message) => message.id),
    ...state.files.map((file) => file.id),
    ...state.tasks.map((task) => task.id),
    ...state.calendar.map((item) => item.id),
    ...state.actionRequests.map((request) => request.id),
    ...state.actionLogs.map((log) => log.id),
    ...(state.memories ?? []).map((memory) => memory.id)
  ]);
  return unique(ids.filter((id): id is string => typeof id === 'string' && existingIds.has(id)));
}

function extractDeadline(texts: string[]): string | null {
  const joined = texts.join('\n');
  const match = joined.match(/5月12日\s*23:59/);
  return match?.[0] ?? null;
}

function asksRemainingTime(question: string): boolean {
  const lowered = question.toLowerCase();
  return includesAny(question, ['还有几天', '还剩几天', '还有多久', '还剩多久', '几天截止']) ||
    lowered.includes('days left') ||
    lowered.includes('how many days');
}

function estimateRemainingDays(deadline: string, now = new Date()): number | null {
  const match = deadline.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (!match) {
    return null;
  }
  const [, month, day, hour, minute] = match;
  const deadlineDate = new Date(
    now.getFullYear(),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute)
  );
  const diff = deadlineDate.getTime() - now.getTime();
  return Math.max(0, Math.floor(diff / (24 * 60 * 60 * 1000)));
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
