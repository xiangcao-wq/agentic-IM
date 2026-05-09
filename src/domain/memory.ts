import type { DemoState, FileTextChunk, MemoryItem, MemoryKind, PersonalAgent, Message, User } from './types';
import { compareTimestamps, sortMessagesChronologically } from './messages';

interface WriteMemoryInput {
  agentId: string;
  scopeRoomIds: string[];
  kind: MemoryKind;
  content: string;
  sourceIds: string[];
  now?: string;
}

export function writeMemory(state: DemoState, input: WriteMemoryInput): { state: DemoState; memory: MemoryItem } {
  const agent = getAgent(state, input.agentId);
  const scopeRoomIds = input.scopeRoomIds.filter((roomId) => agent.allowedRoomIds.includes(roomId));
  const now = input.now ?? new Date().toISOString();
  const memory: MemoryItem = {
    id: `mem-${input.agentId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ownerAgentId: input.agentId,
    scopeRoomIds,
    kind: input.kind,
    content: input.content,
    sourceIds: [...new Set(input.sourceIds)],
    createdAt: now,
    updatedAt: now
  };

  return {
    state: {
      ...state,
      memories: [memory, ...(state.memories ?? [])]
    },
    memory
  };
}

export function listAgentMemories(state: DemoState, agentId: string, query = ''): MemoryItem[] {
  const agent = getAgent(state, agentId);
  const terms = tokenize(query);
  return (state.memories ?? [])
    .filter((memory) => memory.ownerAgentId === agent.id)
    .filter((memory) => memory.scopeRoomIds.some((roomId) => agent.allowedRoomIds.includes(roomId)))
    .filter((memory) => terms.length === 0 || terms.some((term) => memory.content.toLowerCase().includes(term)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function buildShortTermContext(state: DemoState, roomId: string, agentId?: string): string {
  const roomIds = agentId ? getAgent(state, agentId).allowedRoomIds : [roomId];
  const visibleRoomIds = new Set([roomId, ...roomIds]);
  const messages = state.messages
    .filter((message) => visibleRoomIds.has(message.roomId))
    .sort((a, b) => compareTimestamps(a.sentAt, b.sentAt) || a.id.localeCompare(b.id))
    .slice(-30)
    .map((message) => `${message.senderName}: ${message.body}`)
    .join('\n');
  const files = state.files
    .filter((file) => visibleRoomIds.has(file.roomId) && file.visibility === 'room')
    .slice(0, 8)
    .map((file) => `${file.name} ${file.agentCanShare ? '可代发' : '不可代发'} ${file.summary}`)
    .join('\n');
  const tasks = state.tasks.map((task) => `${task.title} ${task.deadline} ${task.status}`).join('\n');
  return [`最近消息：`, messages, '', '文件：', files, '', '任务：', tasks].join('\n');
}

/* ─── Structured Context ─── */

type ContextFocus = 'summary' | 'deadline' | 'file_share' | 'coordinate' | 'chat';

interface StructuredContextOptions {
  focus?: ContextFocus;
  userText?: string;
}

export interface AgentContextBundleInput {
  roomId: string;
  agentId: string;
  userText?: string;
  focus?: ContextFocus;
}

export interface AgentContextMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  senderRole: string;
  sentAt: string;
  body: string;
  type: Message['type'];
}

export interface AgentContextFile {
  id: string;
  name: string;
  roomId: string;
  uploaderId: string;
  uploaderName: string;
  version: number;
  updatedAt: string;
  visibility: string;
  agentCanShare: boolean;
  downloadable: boolean;
  tags: string[];
  summary: string;
  contentType?: string;
  size?: number;
}

export interface AgentContextFileTextChunk {
  id: string;
  fileId: string;
  fileName: string;
  roomId: string;
  index: number;
  text: string;
}

export interface AgentContextBundle {
  room: {
    id: string;
    name: string;
    type: string;
  };
  agent: {
    id: string;
    ownerId: string;
    displayName: string;
    allowedRoomIds: string[];
    allowedToolIds: string[];
  };
  recentMessages: AgentContextMessage[];
  relevantMessages: AgentContextMessage[];
  tasks: Array<{
    id: string;
    title: string;
    deadline: string;
    owners: string[];
    status: string;
    sourceMessageId: string;
  }>;
  files: AgentContextFile[];
  fileTextChunks: AgentContextFileTextChunk[];
  calendar: Array<{
    id: string;
    title: string;
    startsAt: string;
    roomId: string;
    attendees: string[];
    attendeeNames: string[];
  }>;
  members: Array<{
    id: string;
    name: string;
    role: string;
    status: string;
    agentId: string;
  }>;
  memories: MemoryItem[];
  actionLogs: Array<{
    id: string;
    action: string;
    status: string;
    riskLevel: string;
    createdAt: string;
  }>;
  text: string;
}

export function buildStructuredContext(
  state: DemoState,
  roomId: string,
  agentId?: string,
  options?: StructuredContextOptions
): string {
  if (agentId) {
    return buildAgentContextBundle(state, {
      roomId,
      agentId,
      userText: options?.userText,
      focus: options?.focus ?? 'chat'
    }).text;
  }

  const focus: ContextFocus = options?.focus ?? 'chat';
  const sections: string[] = [];

  // ── a. 对话历史区 ──
  sections.push(buildConversationSection(state, roomId, focus));

  // ── b. 任务状态区 ──
  sections.push(buildTaskSection(state, roomId, focus));

  // ── c. 文件清单区 ──
  sections.push(buildFileSection(state, roomId, focus));

  // ── d. 成员信息区 ──
  sections.push(buildMemberSection(state, roomId, focus));

  // ── e. Agent 记忆区 ──
  if (agentId) {
    sections.push(buildAgentMemorySection(state, agentId));
  }

  return sections.filter(Boolean).join('\n\n');
}

export function buildAgentContextBundle(state: DemoState, input: AgentContextBundleInput): AgentContextBundle {
  const focus = input.focus ?? 'chat';
  const agent = getAgent(state, input.agentId);
  const room = state.rooms.find((candidate) => candidate.id === input.roomId);
  if (!room) {
    throw new Error(`unknown room: ${input.roomId}`);
  }
  if (!agent.allowedRoomIds.includes(input.roomId)) {
    throw new Error(`${agent.displayName} cannot read ${input.roomId}`);
  }

  const includeGlobalContext = wantsGlobalContext(input.userText ?? '');
  const visibleRoomIds = includeGlobalContext
    ? new Set([input.roomId, ...agent.allowedRoomIds])
    : new Set([input.roomId]);
  const roomMessages = sortMessagesChronologically(state.messages.filter((message) => message.roomId === input.roomId));
  const recentLimit = focus === 'summary' ? roomMessages.length : 30;
  const recentMessages = roomMessages.slice(-recentLimit).map((message) => toContextMessage(state, message));
  const relevantMessages = selectRelevantMessages(state, visibleRoomIds, input.userText ?? '', focus)
    .filter((message) => !recentMessages.some((recent) => recent.id === message.id))
    .map((message) => toContextMessage(state, message));

  const roomMessageIds = new Set(roomMessages.map((message) => message.id));
  const tasks = state.tasks
    .filter((task) => roomMessageIds.has(task.sourceMessageId) || focus === 'deadline' || focus === 'chat' || focus === 'coordinate')
    .map((task) => ({
      id: task.id,
      title: task.title,
      deadline: task.deadline,
      owners: task.owners,
      status: task.status,
      sourceMessageId: task.sourceMessageId
    }));

  const files = state.files
    .filter((file) => visibleRoomIds.has(file.roomId))
    .filter((file) => file.visibility === 'room' || file.uploaderId === agent.ownerId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, focus === 'file_share' ? 30 : 12)
    .map((file) => toContextFile(state, file));
  const fileTextChunks = selectRelevantFileTextChunks(state, agent, input.roomId, input.userText ?? '', focus);

  const members = room.memberIds
    .map((userId) => state.users.find((user) => user.id === userId))
    .filter(Boolean)
    .map((user) => ({
      id: user!.id,
      name: user!.name,
      role: user!.role,
      status: user!.status,
      agentId: user!.agentId
    }));
  const memberIds = new Set(room.memberIds);
  const calendar = state.calendar
    .filter((item) =>
      item.attendees.some((attendeeId) => memberIds.has(attendeeId)) &&
      (includeGlobalContext || item.roomId === input.roomId || item.attendees.some((attendeeId) => memberIds.has(attendeeId)))
    )
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .slice(0, 12)
    .map((item) => ({
      id: item.id,
      title: item.title,
      startsAt: item.startsAt,
      roomId: item.roomId,
      attendees: item.attendees,
      attendeeNames: item.attendees.map((attendeeId) => state.users.find((user) => user.id === attendeeId)?.name ?? attendeeId)
    }));

  const memories = (state.memories ?? [])
    .filter((memory) => memory.ownerAgentId === agent.id)
    .filter((memory) => memory.scopeRoomIds.some((roomId) => visibleRoomIds.has(roomId)))
    .filter((memory) => !looksCorruptedMemory(memory.content))
    .filter((memory) => memory.kind !== 'note' || memory.sourceIds.length > 0)
    .slice(0, 10);

  const actionLogs = (state.actionLogs ?? [])
    .filter((log) => log.agentId === agent.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8)
    .map((log) => ({
      id: log.id,
      action: log.action,
      status: log.status,
      riskLevel: log.risk.level,
      createdAt: log.createdAt
    }));

  const partial: Omit<AgentContextBundle, 'text'> = {
    room: {
      id: room.id,
      name: room.name,
      type: room.type
    },
    agent: {
      id: agent.id,
      ownerId: agent.ownerId,
      displayName: agent.displayName,
      allowedRoomIds: agent.allowedRoomIds,
      allowedToolIds: agent.allowedToolIds
    },
    recentMessages,
    relevantMessages,
    tasks,
    files,
    fileTextChunks,
    calendar,
    members,
    memories,
    actionLogs
  };

  return {
    ...partial,
    text: renderAgentContextBundle(partial)
  };
}

function selectRelevantMessages(
  state: DemoState,
  visibleRoomIds: Set<string>,
  userText: string,
  focus: ContextFocus
): Message[] {
  const terms = buildContextTerms(userText, focus);
  if (terms.length === 0) {
    return [];
  }

  return sortMessagesChronologically(
    state.messages.filter((message) => {
      if (!visibleRoomIds.has(message.roomId)) {
        return false;
      }
      const haystack = `${message.senderName} ${message.body}`.toLowerCase();
      return terms.some((term) => haystack.includes(term));
    })
  ).slice(-20);
}

function buildContextTerms(userText: string, focus: ContextFocus): string[] {
  const lowered = userText.toLowerCase();
  const terms = tokenize(lowered).filter((term) => term.length >= 2);
  if (/访谈|interview/i.test(userText)) terms.push('访谈', 'interview');
  if (/截止|deadline|ddl|due/i.test(userText) || focus === 'deadline') terms.push('截止', 'deadline', 'ddl', 'due');
  if (/文件|演示稿|slides|ppt|file/i.test(userText) || focus === 'file_share') {
    terms.push('文件', '演示稿', 'slides', 'ppt', 'file');
  }
  if (/协调|改到|日程|会议|coordinate|reschedule/i.test(userText) || focus === 'coordinate') {
    terms.push('协调', '改到', '日程', '会议', 'coordinate', 'reschedule');
  }
  const cjkPairs = (userText.match(/[\u4e00-\u9fff]{2,}/g) ?? []).flatMap((segment) => {
    const pairs: string[] = [];
    for (let index = 0; index < segment.length - 1; index += 1) {
      pairs.push(segment.slice(index, index + 2));
    }
    return pairs;
  });
  return [...new Set([...terms, ...cjkPairs].map((term) => term.toLowerCase()))];
}

function wantsGlobalContext(userText: string): boolean {
  const lowered = userText.toLowerCase();
  return (
    /全局|所有会话|全部会话|所有群|全部群|所有房间|跨群|整个项目|全部内容/.test(userText) ||
    /\bglobal\s+(?:context|scope|search|lookup|rooms?|chats?|conversations?)\b/.test(lowered) ||
    lowered.includes('all rooms') ||
    lowered.includes('all chats') ||
    lowered.includes('across rooms')
  );
}

function toContextMessage(state: DemoState, message: Message): AgentContextMessage {
  const user = state.users.find((candidate) => candidate.id === message.senderId);
  return {
    id: message.id,
    roomId: message.roomId,
    senderId: message.senderId,
    senderName: message.senderName,
    senderRole: message.agentLabel || message.sourceAgentId ? 'agent' : user?.role ?? 'unknown',
    sentAt: message.sentAt,
    body: message.body,
    type: message.type
  };
}

function toContextFile(state: DemoState, file: DemoState['files'][number]): AgentContextFile {
  const uploader = state.users.find((user) => user.id === file.uploaderId);
  return {
    id: file.id,
    name: file.name,
    roomId: file.roomId,
    uploaderId: file.uploaderId,
    uploaderName: uploader?.name ?? file.uploaderId,
    version: file.version,
    updatedAt: file.updatedAt,
    visibility: file.visibility,
    agentCanShare: file.agentCanShare,
    downloadable: Boolean(file.mxcUri || file.localPath),
    tags: file.tags,
    summary: file.summary,
    contentType: file.contentType,
    size: file.size
  };
}

function selectRelevantFileTextChunks(
  state: DemoState,
  agent: PersonalAgent,
  roomId: string,
  userText: string,
  focus: ContextFocus
): AgentContextFileTextChunk[] {
  const terms = buildContextTerms(userText, focus);
  const filesById = new Map(state.files.map((file) => [file.id, file]));
  const limit = focus === 'file_share' ? 8 : 4;
  const visibleRoomIds = wantsGlobalContext(userText)
    ? new Set([roomId, ...agent.allowedRoomIds])
    : new Set([roomId]);
  return (state.fileTextChunks ?? [])
    .flatMap((chunk) => {
      const file = filesById.get(chunk.fileId);
      if (!file || !agentCanReadFileText(agent, visibleRoomIds, file)) {
        return [];
      }
      const score = scoreChunkText(chunk, terms);
      if (terms.length > 0 && score === 0) {
        return [];
      }
      return [{
        chunk,
        file,
        score: score || 1
      }];
    })
    .sort((left, right) => right.score - left.score || left.chunk.index - right.chunk.index)
    .slice(0, limit)
    .map(({ chunk, file }) => ({
      id: chunk.id,
      fileId: chunk.fileId,
      fileName: file.name,
      roomId: chunk.roomId,
      index: chunk.index,
      text: chunk.text
    }));
}

function agentCanReadFileText(agent: PersonalAgent, visibleRoomIds: Set<string>, file: DemoState['files'][number]): boolean {
  if (!visibleRoomIds.has(file.roomId) || !agent.allowedRoomIds.includes(file.roomId)) {
    return false;
  }
  return file.visibility === 'room' || file.uploaderId === agent.ownerId;
}

function scoreChunkText(chunk: FileTextChunk, terms: string[]): number {
  if (terms.length === 0) {
    return 0;
  }
  const haystack = chunk.text.toLowerCase();
  return terms.reduce((score, term) => (haystack.includes(term) ? score + Math.max(1, term.length) : score), 0);
}

function renderAgentContextBundle(bundle: Omit<AgentContextBundle, 'text'>): string {
  const sections = [
    '# Authorized Agent Context',
    'Boundary: Do not assume hidden room, private chat, or missing file contents are visible.',
    `Room: ${bundle.room.name} (${bundle.room.id}, ${bundle.room.type})`,
    `Agent: ${bundle.agent.displayName} (${bundle.agent.id}); allowedRooms=${bundle.agent.allowedRoomIds.join(', ')}`,
    '',
    '## Recent messages',
    ...bundle.recentMessages.map((message) =>
      `- [${message.sentAt}] ${message.senderName} (${message.senderRole}) ${message.id}: ${message.body}`
    ),
    '',
    '## Relevant older messages',
    ...(bundle.relevantMessages.length > 0
      ? bundle.relevantMessages.map((message) =>
          `- [${message.sentAt}] ${message.senderName} (${message.senderRole}) ${message.id}: ${message.body}`
        )
      : ['- none']),
    '',
    '## Tasks',
    ...(bundle.tasks.length > 0
      ? bundle.tasks.map((task) =>
          `- ${task.id}: ${task.title}; deadline=${task.deadline}; owners=${task.owners.join(', ')}; status=${task.status}`
        )
      : ['- none']),
    '',
    '## Files',
    ...(bundle.files.length > 0
      ? bundle.files.map((file) =>
          `- ${file.id}: ${file.name}; visibility=${file.visibility}; agentCanShare=${file.agentCanShare}; downloadable=${file.downloadable}; uploader=${file.uploaderName}; updatedAt=${file.updatedAt}; tags=${file.tags.join(', ')}; summary=${file.summary}`
        )
      : ['- none']),
    '',
    '## File text excerpts',
    ...(bundle.fileTextChunks.length > 0
      ? bundle.fileTextChunks.map((chunk) =>
          `- ${chunk.id}: file=${chunk.fileName} (${chunk.fileId}); index=${chunk.index}; text=${chunk.text}`
        )
      : ['- none']),
    '',
    '## Calendar availability',
    ...(bundle.calendar.length > 0
      ? bundle.calendar.map((item) =>
          `- ${item.id}: ${item.title}; startsAt=${item.startsAt}; room=${item.roomId}; attendees=${item.attendees.join(', ')}; names=${item.attendeeNames.join(', ')}`
        )
      : ['- none']),
    '',
    '## Members',
    ...bundle.members.map((member) =>
      `- ${member.id}: ${member.name}; role=${member.role}; status=${member.status}; agent=${member.agentId}`
    ),
    '',
    '## Agent memory',
    'Note: memories are lower-confidence prior notes. Use them only when supported by messages, tasks, files, or file excerpts.',
    ...(bundle.memories.length > 0
      ? bundle.memories.map((memory) => `- ${memory.id}: [${memory.kind}] ${memory.content}`)
      : ['- none']),
    '',
    '## Recent agent logs',
    ...(bundle.actionLogs.length > 0
      ? bundle.actionLogs.map((log) => `- ${log.id}: ${log.action}; status=${log.status}; risk=${log.riskLevel}`)
      : ['- none'])
  ];

  return sections.join('\n');
}

function looksCorruptedMemory(content: string): boolean {
  const questionMarks = content.match(/\?{4,}/g);
  if (!questionMarks) {
    return false;
  }
  const totalQuestionMarks = questionMarks.reduce((sum, item) => sum + item.length, 0);
  return totalQuestionMarks / Math.max(content.length, 1) > 0.08;
}

export function buildAgentSystemPrompt(state: DemoState, agentId: string): string {
  const agent = getAgent(state, agentId);
  const owner = state.users.find((u) => u.id === agent.ownerId);
  const ownerInfo = owner ? `，服务于用户「${owner.name}」` : '';

  return [
    `# 你是 ${agent.displayName}`,
    `你是一名个人智能助手${ownerInfo}。`,
    '',
    '## 能力',
    '- 总结对话内容，提炼关键信息',
    '- 回答用户提出的问题',
    '- 代为查找并分享文件',
    '- 协调日程与任务分工',
    '',
    '## 行为准则',
    '- 如实回答，不编造不确定的信息',
    '- 涉及高风险操作（如共享文件、修改任务截止日期）时，先进行风险评估',
    '- 不确定用户意图时，主动请求确认',
    '- 回复简洁直接，避免冗余',
  ].join('\n');
}

/* ─── Section builders ─── */

function buildConversationSection(state: DemoState, roomId: string, focus: ContextFocus): string {
  let msgs = sortMessagesChronologically(state.messages.filter((m) => m.roomId === roomId));

  if (focus === 'deadline') {
    // 侧重提及截止日期的消息
    const deadlineMsgs = msgs.filter((m) =>
      /截止|deadline|ddl|到期|due|提交/i.test(m.body)
    );
    // 保留截止日期相关 + 最近 15 条
    const recentMsgs = msgs.slice(-15);
    const merged = new Map<string, Message>();
    for (const m of [...deadlineMsgs, ...recentMsgs]) merged.set(m.id, m);
    msgs = sortMessagesChronologically([...merged.values()]);
  } else if (focus !== 'summary') {
    // summary 取全量，其他取最近 30 条
    msgs = msgs.slice(-30);
  }

  const userMap = buildUserMap(state);
  const lines = msgs.map((m) => {
    const user = userMap.get(m.senderId);
    const role = user ? (isAgent(state, m.senderId) ? 'Agent' : '用户') : '未知';
    const time = formatTime(m.sentAt);
    return `[${time}] ${m.senderName}(${role}): ${m.body}`;
  });

  return `## 对话历史\n${lines.join('\n')}`;
}

function buildTaskSection(state: DemoState, roomId: string, focus: ContextFocus): string {
  // tasks 没有 roomId 字段，通过 sourceMessageId 关联 room
  const roomMsgIds = new Set(state.messages.filter((m) => m.roomId === roomId).map((m) => m.id));
  let tasks = state.tasks.filter((t) => roomMsgIds.has(t.sourceMessageId));

  // 如果没匹配到，列出所有 tasks（兜底）
  if (tasks.length === 0) tasks = [...state.tasks];

  const brief = focus !== 'deadline' && focus !== 'coordinate' && focus !== 'chat';
  const now = Date.now();

  const lines = tasks.map((t) => {
    const owners = t.owners.join(', ');
    const status = t.status;
    const deadlineDate = new Date(t.deadline);
    const diff = deadlineDate.getTime() - now;
    const relative = formatRelativeTime(diff);
    if (brief) {
      return `- ${t.title} | ${status} | ${relative}`;
    }
    return `- ${t.title} | 截止: ${t.deadline} (${relative}) | 负责人: ${owners} | 状态: ${status}`;
  });

  return `## 任务状态\n${lines.join('\n') || '（暂无任务）'}`;
}

function buildFileSection(state: DemoState, roomId: string, focus: ContextFocus): string {
  let files = state.files
    .filter((f) => f.roomId === roomId && f.visibility === 'room')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const detailed = focus === 'file_share';

  const lines = files.map((f) => {
    const uploader = f.uploaderId;
    const time = formatTime(f.updatedAt);
    const tags = f.tags.length > 0 ? `[${f.tags.join(', ')}]` : '';
    if (detailed) {
      const size = f.size ? `${(f.size / 1024).toFixed(1)}KB` : '';
      const ct = f.contentType ?? '';
      return `- ${f.name} ${tags} | 上传者: ${uploader} | 时间: ${time} | 类型: ${ct} | 大小: ${size} | 可代发: ${f.agentCanShare ? '是' : '否'} | 摘要: ${f.summary}`;
    }
    return `- ${f.name} ${tags} | ${uploader} | ${time}`;
  });

  return `## 文件清单\n${lines.join('\n') || '（暂无文件）'}`;
}

function buildMemberSection(state: DemoState, roomId: string, focus: ContextFocus): string {
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room) return '## 成员信息\n（未知房间）';

  const brief = focus !== 'coordinate' && focus !== 'chat';
  const agentIds = new Set(state.agents.map((a) => a.id));
  const agentOwnerToAgent = new Map(state.agents.map((a) => [a.ownerId, a]));

  const lines = room.memberIds.map((uid) => {
    const user = state.users.find((u) => u.id === uid);
    if (!user) return `- ${uid} (未知)`;
    const isAg = agentIds.has(uid) || !!state.agents.find((a) => a.ownerId === uid);
    const agentInfo = agentOwnerToAgent.get(uid);
    const rolePart = isAg ? 'Agent' : '用户';
    if (brief) return `- ${user.name} (${rolePart})`;
    const extra = agentInfo ? ` | Agent: ${agentInfo.displayName}` : '';
    return `- ${user.name} (${rolePart}) | 状态: ${user.status}${extra}`;
  });

  return `## 成员信息\n${lines.join('\n')}`;
}

function buildAgentMemorySection(state: DemoState, agentId: string): string {
  const parts: string[] = ['## Agent 记忆'];

  // 结构化记忆
  const memories = (state.memories ?? []).filter((m) => m.ownerAgentId === agentId);
  if (memories.length > 0) {
    parts.push('### 记忆条目');
    for (const m of memories) {
      parts.push(`- [${m.kind}] ${m.content} (${formatTime(m.updatedAt)})`);
    }
  }

  // 最近审计日志
  const logs = (state.actionLogs ?? [])
    .filter((l) => l.agentId === agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);
  if (logs.length > 0) {
    parts.push('### 最近动作日志');
    for (const l of logs) {
      parts.push(`- ${l.action} | ${l.status} | 风险: ${l.risk.level} (${formatTime(l.createdAt)})`);
    }
  }

  // 待确认动作
  const pending = (state.actionRequests ?? [])
    .filter((r) => r.agentId === agentId && r.status !== 'executed');
  if (pending.length > 0) {
    parts.push('### 待处理动作');
    for (const r of pending) {
      parts.push(`- [${r.kind}] ${r.status} | 需人工: ${r.requiresHuman ? '是' : '否'} (${formatTime(r.createdAt)})`);
    }
  }

  return parts.join('\n');
}

/* ─── Helpers ─── */

function buildUserMap(state: DemoState): Map<string, User> {
  return new Map(state.users.map((u) => [u.id, u]));
}

function isAgent(state: DemoState, userId: string): boolean {
  return state.agents.some((a) => a.id === userId);
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return iso;
  }
}

function formatRelativeTime(diffMs: number): string {
  const absDiff = Math.abs(diffMs);
  const suffix = diffMs >= 0 ? '后' : '前';
  const minutes = Math.floor(absDiff / 60000);
  if (minutes < 60) return `${minutes}分钟${suffix}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时${suffix}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天${suffix}`;
  const months = Math.floor(days / 30);
  return `${months}个月${suffix}`;
}

function getAgent(state: DemoState, agentId: string): PersonalAgent {
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error(`unknown agent: ${agentId}`);
  }
  return agent;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，。！？:：;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}
