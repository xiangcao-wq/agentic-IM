import {
  answerDeadlineQuestion,
  coordinateAgents,
  summarizeRoom
} from '../domain/agentEngine';
import { buildAgentSystemPrompt, buildStructuredContext, listAgentMemories, writeMemory } from '../domain/memory';
import type {
  AgentActionLog,
  AgentRunRequest,
  AgentRunResult,
  ChatResult,
  DemoState,
  FileItem,
  Message,
  RiskAssessment
} from '../domain/types';
import type { AiProvider } from './aiProvider';
import { runFileShareAction } from './agentRuntime';

export async function runAgentIntent(
  state: DemoState,
  input: AgentRunRequest,
  aiProvider?: AiProvider
): Promise<{ state: DemoState; response: AgentRunResult }> {
  const agent = state.agents.find((candidate) => candidate.id === input.agentId);
  if (!agent) {
    throw new Error(`unknown agent: ${input.agentId}`);
  }
  if (!agent.allowedRoomIds.includes(input.roomId)) {
    throw new Error(`${agent.displayName} cannot read ${input.roomId}`);
  }

  if (input.intent === 'summary') {
    const result = await summarizeRoom(state, input.roomId, input.agentId, aiProvider);
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
      toolCalls: ['deepseek.pro.chat.completions', 'room_search', 'task_extract', 'memory.write']
    });
    return {
      state: { ...memoryWrite.state, actionLogs: [log, ...memoryWrite.state.actionLogs] },
      response: {
        intent: input.intent,
        requiresHuman: false,
        result,
        memory: memoryWrite.memory,
        log
      }
    };
  }

  if (input.intent === 'deadline') {
    const result = await answerDeadlineQuestion(state, {
      agentId: input.agentId,
      roomId: input.roomId,
      question: input.userText
    }, aiProvider);
    const relatedMemories = listAgentMemories(state, input.agentId, input.userText);
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
      toolCalls: ['deepseek.pro.chat.completions', 'room_search', 'file_library.search', 'memory.search', 'memory.write']
    });
    return {
      state: { ...memoryWrite.state, actionLogs: [log, ...memoryWrite.state.actionLogs] },
      response: {
        intent: input.intent,
        requiresHuman: false,
        result,
        memory: memoryWrite.memory,
        log
      }
    };
  }

  if (input.intent === 'find_file') {
    const files = findAuthorizedFiles(state, input.agentId, input.roomId, input.userText);
    const log = createLog({
      agentId: input.agentId,
      roomId: input.roomId,
      action: `agent_run:find_file:${input.userText}`,
      risk: lowRisk('只读检索授权文件库。'),
      contextIds: files.map((file) => file.id),
      toolCalls: ['deepseek.pro.chat.completions', 'file_library.search']
    });
    return {
      state: { ...state, actionLogs: [log, ...state.actionLogs] },
      response: {
        intent: input.intent,
        requiresHuman: false,
        files,
        log
      }
    };
  }

  if (input.intent === 'share_file') {
    const requesterId = input.targetUserId ?? 'user-chen';
    const runtime = await runFileShareAction(state, {
      agentId: input.agentId,
      roomId: input.roomId,
      requesterId,
      requestText: input.userText
    }, aiProvider);
    const memoryWrite = writeMemory(runtime.state, {
      agentId: input.agentId,
      scopeRoomIds: [input.roomId],
      kind: 'file',
      content: `${runtime.result.status}: ${runtime.result.file?.name ?? '未找到可代发文件'}`,
      sourceIds: [runtime.actionRequest.id, runtime.result.file?.id, runtime.result.message?.id].filter(Boolean) as string[]
    });
    return {
      state: memoryWrite.state,
      response: {
        intent: input.intent,
        requiresHuman: runtime.result.requiresHuman,
        result: runtime.result,
        message: runtime.result.message,
        memory: memoryWrite.memory,
        log: runtime.result.log,
        actionRequest: runtime.actionRequest
      }
    };
  }

  if (input.intent === 'coordinate') {
    const toAgentId = input.targetUserId
      ? state.users.find((user) => user.id === input.targetUserId)?.agentId
      : 'agent-lin';
    if (!toAgentId) {
      throw new Error(`unknown target user: ${input.targetUserId}`);
    }
    const result = await coordinateAgents(state, {
      fromAgentId: input.agentId,
      toAgentId,
      roomId: input.roomId,
      proposal: input.userText
    }, aiProvider);
    const message = createAgentCoordinationMessage(state, input.agentId, result.proposedPlan);
    const memoryWrite = writeMemory(state, {
      agentId: input.agentId,
      scopeRoomIds: [input.roomId],
      kind: 'coordination',
      content: result.proposedPlan,
      sourceIds: [...result.log.contextIds, message.id]
    });
    const log = { ...result.log, toolCalls: ['deepseek.pro.chat.completions', ...result.log.toolCalls, 'memory.write'] };
    return {
      state: { ...memoryWrite.state, actionLogs: [log, ...memoryWrite.state.actionLogs] },
      response: {
        intent: input.intent,
        requiresHuman: result.requiresHuman,
        result,
        message,
        memory: memoryWrite.memory,
        log
      }
    };
  }

  if (input.intent === 'chat') {
    return handleAgentChat(state, input, aiProvider);
  }

  const memoryWrite = writeMemory(state, {
    agentId: input.agentId,
    scopeRoomIds: [input.roomId],
    kind: 'note',
    content: `任务更新建议：${input.userText}`,
    sourceIds: []
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
    toolCalls: ['deepseek.pro.chat.completions', 'task.inspect', 'memory.write']
  });
  return {
    state: { ...memoryWrite.state, actionLogs: [log, ...memoryWrite.state.actionLogs] },
    response: {
      intent: input.intent,
      requiresHuman: true,
      memory: memoryWrite.memory,
      log
    }
  };
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
  const terms = query.toLowerCase().split(/[\s,，。！？]+/).filter(Boolean);
  return state.files
    .filter((file) => agent.allowedRoomIds.includes(file.roomId) && file.roomId === roomId && file.visibility === 'room')
    .filter((file) => {
      const haystack = `${file.name} ${file.summary} ${file.tags.join(' ')}`.toLowerCase();
      return terms.length === 0 || terms.some((term) => haystack.includes(term.toLowerCase()));
    })
    .sort((a, b) => b.version - a.version || b.updatedAt.localeCompare(a.updatedAt));
}

function lowRisk(reason: string): RiskAssessment {
  return {
    level: 'low',
    score: 0.12,
    reason,
    model: 'risk-mini-v1'
  };
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

async function handleAgentChat(
  state: DemoState,
  input: AgentRunRequest,
  aiProvider?: AiProvider
): Promise<{ state: DemoState; response: AgentRunResult }> {
  const agent = state.agents.find((a) => a.id === input.agentId);
  if (!agent) {
    throw new Error(`unknown agent: ${input.agentId}`);
  }

  if (!aiProvider) {
    const fallbackReply = '当前 AI 服务不可用，请检查配置。';
    const log = createLog({
      agentId: input.agentId,
      roomId: input.roomId,
      action: `agent_run:chat:fallback`,
      risk: lowRisk('自由对话回复，无外部副作用。'),
      contextIds: [],
      toolCalls: []
    });
    return {
      state: { ...state, actionLogs: [log, ...state.actionLogs] },
      response: {
        intent: 'chat',
        requiresHuman: false,
        result: { reply: fallbackReply } as ChatResult,
        log
      }
    };
  }

  const systemPrompt = [
    buildAgentSystemPrompt(state, input.agentId),
    '',
    '## 自由对话指引',
    '你可以回答用户的任何问题，基于当前对话上下文和可用信息。',
    '如果用户的请求涉及到文件分享、日程协调等操作，请说明你的分析和建议。',
    '如果你不确定答案，诚实说明并建议用户如何获取准确信息。',
    '请用自然的中文回答。'
  ].join('\n');

  const context = buildStructuredContext(state, input.roomId, input.agentId, { focus: 'chat' });
  const userPrompt = `用户输入：${input.userText}\n\n${context}`;

  const replyText = await aiProvider.generateText({
    actorRole: 'personal_agent',
    actorId: input.agentId,
    instructions: systemPrompt,
    input: userPrompt,
    maxOutputTokens: 500
  });

  const memoryWrite = writeMemory(state, {
    agentId: input.agentId,
    scopeRoomIds: [input.roomId],
    kind: 'note',
    content: `自由对话：${input.userText} -> ${replyText.slice(0, 120)}`,
    sourceIds: []
  });

  const log = createLog({
    agentId: input.agentId,
    roomId: input.roomId,
    action: `agent_run:chat:${input.userText.slice(0, 60)}`,
    risk: lowRisk('自由对话回复，只读上下文，无外部副作用。'),
    contextIds: [memoryWrite.memory.id],
    toolCalls: ['deepseek.pro.chat.completions', 'memory.write']
  });

  return {
    state: { ...memoryWrite.state, actionLogs: [log, ...memoryWrite.state.actionLogs] },
    response: {
      intent: 'chat',
      requiresHuman: false,
      reasoning: `基于房间 ${input.roomId} 的上下文回答用户问题`,
      result: { reply: replyText } as ChatResult,
      memory: memoryWrite.memory,
      log
    }
  };
}
