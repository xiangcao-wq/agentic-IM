import type { DemoState, MemoryItem, MemoryKind, PersonalAgent, Message, User } from './types';

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
}

export function buildStructuredContext(
  state: DemoState,
  roomId: string,
  agentId?: string,
  options?: StructuredContextOptions
): string {
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
  let msgs = state.messages.filter((m) => m.roomId === roomId);

  if (focus === 'deadline') {
    // 侧重提及截止日期的消息
    const deadlineMsgs = msgs.filter((m) =>
      /截止|deadline|ddl|到期|due|提交/i.test(m.body)
    );
    // 保留截止日期相关 + 最近 15 条
    const recentMsgs = msgs.slice(-15);
    const merged = new Map<string, Message>();
    for (const m of [...deadlineMsgs, ...recentMsgs]) merged.set(m.id, m);
    msgs = [...merged.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
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
