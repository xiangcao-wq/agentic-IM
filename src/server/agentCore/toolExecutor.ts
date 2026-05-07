import type { DemoState, FileItem, Message, RiskAssessment } from '../../domain/types';
import { assessFileSharePolicy, assessMessageSendPolicy } from './policyEngine';
import { getCoreTool, type AgentCoreToolName, type FileShareInput, type MessageSendInput } from './toolRegistry';

export type CoreToolResultStatus = 'ok' | 'not_found' | 'denied' | 'needs_confirmation' | 'failed';

export interface CoreToolResult<T> {
  status: CoreToolResultStatus;
  data?: T;
  observations: string[];
  evidenceIds: string[];
  toolCalls: string[];
  risk?: RiskAssessment;
  policyReasons?: string[];
  error?: string;
}

export interface CoreToolExecutionRequest {
  toolName: AgentCoreToolName;
  agent: DemoState['agents'][number];
  sourceRoomId: string;
  input: unknown;
}

export interface MessageSendToolOutput {
  targetRoomId: string;
  targetUserId?: string;
  messageBody: string;
  message?: Message;
}

export interface FileShareToolOutput {
  targetRoomId: string;
  requesterId: string;
  requestText: string;
  file?: FileItem;
  message?: Message;
}

export function executeCoreTool(
  state: DemoState,
  request: CoreToolExecutionRequest & { toolName: 'message.send' }
): CoreToolResult<MessageSendToolOutput>;

export function executeCoreTool(
  state: DemoState,
  request: CoreToolExecutionRequest & { toolName: 'file.share' }
): CoreToolResult<FileShareToolOutput>;

export function executeCoreTool(
  state: DemoState,
  request: CoreToolExecutionRequest
): CoreToolResult<MessageSendToolOutput | FileShareToolOutput> {
  if (request.toolName === 'message.send') {
    return executeMessageSendTool(state, request);
  }
  if (request.toolName === 'file.share') {
    return executeFileShareTool(state, request);
  }

  return {
    status: 'failed',
    observations: [`Unsupported core tool: ${request.toolName}`],
    evidenceIds: [],
    toolCalls: [`tool_executor.${request.toolName}`, `${request.toolName}.unsupported`],
    error: `unsupported core tool: ${request.toolName}`
  };
}

function executeFileShareTool(
  state: DemoState,
  request: CoreToolExecutionRequest
): CoreToolResult<FileShareToolOutput> {
  const tool = getCoreTool('file.share');
  const toolCalls = ['tool_executor.file.share'];
  const validated = tool.validateInput(request.input);
  if (!validated.ok) {
    return {
      status: 'failed',
      observations: [validated.error],
      evidenceIds: [],
      toolCalls: [...toolCalls, 'file.share.validation_failed'],
      error: validated.error
    };
  }

  const input = validated.value as FileShareInput;
  const targetRoomId = input.targetRoomId ?? request.sourceRoomId;
  const requesterId = input.requesterId ?? '';
  const requestText = input.requestText ?? '';
  const policy = assessFileSharePolicy(state, {
    agent: request.agent,
    sourceRoomId: request.sourceRoomId,
    targetRoomId,
    requesterId,
    requestText,
    file: input.file
  });
  const evidenceIds = [targetRoomId, requesterId, input.file?.id].filter(Boolean) as string[];
  const output: FileShareToolOutput = {
    targetRoomId,
    requesterId,
    requestText,
    file: input.file
  };

  if (policy.outcome === 'deny') {
    return {
      status: 'denied',
      data: output,
      observations: policy.reasons,
      evidenceIds,
      toolCalls: [...toolCalls, 'file.share'],
      risk: policy.risk,
      policyReasons: policy.reasons
    };
  }

  if (policy.outcome === 'require_confirmation') {
    return {
      status: 'needs_confirmation',
      data: output,
      observations: policy.reasons,
      evidenceIds,
      toolCalls: [...toolCalls, 'file.share'],
      risk: policy.risk,
      policyReasons: policy.reasons
    };
  }

  const owner = state.users.find((user) => user.id === request.agent.ownerId);
  if (!owner || !input.file) {
    return {
      status: 'failed',
      data: output,
      observations: [!owner ? 'owner_not_found' : 'file_not_found'],
      evidenceIds,
      toolCalls: [...toolCalls, !owner ? 'file.share.owner_missing' : 'file.share.file_missing'],
      risk: policy.risk,
      policyReasons: [!owner ? 'owner_not_found' : 'file_not_found'],
      error: !owner ? 'Agent owner cannot be verified.' : 'File cannot be verified.'
    };
  }

  return {
    status: 'ok',
    data: {
      ...output,
      message: createAgentFileMessage({
        agent: request.agent,
        ownerName: owner.name,
        roomId: targetRoomId,
        file: input.file
      })
    },
    observations: policy.reasons,
    evidenceIds,
    toolCalls: [...toolCalls, 'file.share', 'matrix.send_event'],
    risk: policy.risk,
    policyReasons: policy.reasons
  };
}

function executeMessageSendTool(
  state: DemoState,
  request: CoreToolExecutionRequest
): CoreToolResult<MessageSendToolOutput> {
  const tool = getCoreTool('message.send');
  const toolCalls = ['tool_executor.message.send'];
  const validated = tool.validateInput(request.input);
  if (!validated.ok) {
    return {
      status: 'failed',
      observations: [validated.error],
      evidenceIds: [],
      toolCalls: [...toolCalls, 'message.send.validation_failed'],
      error: validated.error
    };
  }

  const input = validated.value as MessageSendInput;
  const policy = assessMessageSendPolicy(state, {
    agent: request.agent,
    targetRoomId: input.targetRoomId,
    targetUserId: input.targetUserId,
    messageBody: input.messageBody
  });
  const evidenceIds = [input.targetRoomId, input.targetUserId].filter(Boolean) as string[];
  const output: MessageSendToolOutput = {
    targetRoomId: input.targetRoomId,
    targetUserId: input.targetUserId,
    messageBody: input.messageBody
  };

  if (policy.outcome === 'deny') {
    return {
      status: 'denied',
      data: output,
      observations: policy.reasons,
      evidenceIds,
      toolCalls: [...toolCalls, 'message.send'],
      risk: policy.risk,
      policyReasons: policy.reasons
    };
  }

  if (policy.outcome === 'require_confirmation') {
    return {
      status: 'needs_confirmation',
      data: output,
      observations: policy.reasons,
      evidenceIds,
      toolCalls: [...toolCalls, 'message.send'],
      risk: policy.risk,
      policyReasons: policy.reasons
    };
  }

  const owner = state.users.find((user) => user.id === request.agent.ownerId);
  if (!owner) {
    return {
      status: 'failed',
      data: output,
      observations: ['owner_not_found'],
      evidenceIds,
      toolCalls: [...toolCalls, 'message.send.owner_missing'],
      risk: policy.risk,
      policyReasons: ['owner_not_found'],
      error: 'Agent owner cannot be verified.'
    };
  }

  return {
    status: 'ok',
    data: {
      ...output,
      message: createAgentDelegatedMessage({
        agent: request.agent,
        ownerName: owner.name,
        roomId: input.targetRoomId,
        body: input.messageBody
      })
    },
    observations: policy.reasons,
    evidenceIds,
    toolCalls: [...toolCalls, 'message.send', 'matrix.send_event'],
    risk: policy.risk,
    policyReasons: policy.reasons
  };
}

function createAgentDelegatedMessage(input: {
  agent: DemoState['agents'][number];
  ownerName: string;
  roomId: string;
  body: string;
}): Message {
  return {
    id: `msg-agent-send-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    roomId: input.roomId,
    senderId: input.agent.ownerId,
    senderName: input.agent.displayName,
    body: input.body,
    sentAt: new Date().toISOString(),
    type: 'agent',
    agentLabel: `${input.ownerName}的 Agent 代发`,
    sourceAgentId: input.agent.id
  };
}

function createAgentFileMessage(input: {
  agent: DemoState['agents'][number];
  ownerName: string;
  roomId: string;
  file: FileItem;
}): Message {
  return {
    id: `msg-agent-share-${input.file.id}`,
    roomId: input.roomId,
    senderId: input.agent.ownerId,
    senderName: input.agent.displayName,
    body: `我代表${input.ownerName}发送文件：${input.file.name}`,
    sentAt: new Date().toISOString(),
    type: 'file',
    agentLabel: `${input.ownerName}的 Agent 代发`,
    sourceAgentId: input.agent.id,
    fileId: input.file.id,
    mxcUri: input.file.mxcUri,
    contentType: input.file.contentType,
    size: input.file.size
  };
}
