import type { DemoState, FileItem, Message, RiskAssessment } from '../../domain/types';
import { assistantAgentLabel, assistantFileShareBody, assistantSenderName } from '../../domain/assistantMessage';
import { assessFileSharePolicy, assessMessageSendPolicy } from './policyEngine';
import { createToolPermissionDecision, type ToolPermissionDecision } from './permissionBroker';
import {
  createToolInvocationRecord,
  type ToolInvocationRecord,
  type ToolInvocationStatus
} from './toolInvocationAudit';
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
  permissionDecision?: ToolPermissionDecision;
  invocation?: ToolInvocationRecord;
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

  const error = `unsupported core tool: ${request.toolName}`;
  return {
    status: 'failed',
    observations: [`Unsupported core tool: ${request.toolName}`],
    evidenceIds: [],
    toolCalls: [`tool_executor.${request.toolName}`, `${request.toolName}.unsupported`],
    error,
    invocation: createToolInvocationRecord({
      toolName: request.toolName,
      agentId: request.agent.id,
      roomId: request.sourceRoomId,
      status: 'failed',
      error
    })
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
      error: validated.error,
      invocation: validationFailedInvocation({
        toolName: 'file.share',
        agentId: request.agent.id,
        roomId: request.sourceRoomId,
        error: validated.error
      })
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
  const permissionDecision = createToolPermissionDecision({
    tool,
    policy,
    agentId: request.agent.id,
    roomId: request.sourceRoomId
  });
  const evidenceIds = [targetRoomId, requesterId, input.file?.id].filter(Boolean) as string[];
  const output: FileShareToolOutput = {
    targetRoomId,
    requesterId,
    requestText,
    file: input.file
  };
  const inputSummary = fileShareInputSummary({
    targetRoomId,
    requesterId,
    fileId: input.fileId ?? input.file?.id,
    fileVersion: input.fileVersion ?? input.file?.version
  });

  if (policy.outcome === 'deny') {
    return {
      status: 'denied',
      data: output,
      observations: policy.reasons,
      evidenceIds,
      toolCalls: [...toolCalls, 'file.share'],
      risk: policy.risk,
      policyReasons: policy.reasons,
      permissionDecision,
      invocation: createToolInvocationRecord({
        toolName: 'file.share',
        agentId: request.agent.id,
        roomId: request.sourceRoomId,
        status: invocationStatusForResult('denied'),
        permission: permissionDecision,
        inputSummary,
        outputSummary: fileShareOutputSummary(output),
        evidenceIds
      })
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
      policyReasons: policy.reasons,
      permissionDecision,
      invocation: createToolInvocationRecord({
        toolName: 'file.share',
        agentId: request.agent.id,
        roomId: request.sourceRoomId,
        status: invocationStatusForResult('needs_confirmation'),
        permission: permissionDecision,
        inputSummary,
        outputSummary: fileShareOutputSummary(output),
        evidenceIds
      })
    };
  }

  const owner = state.users.find((user) => user.id === request.agent.ownerId);
  const failureReason = !owner ? 'owner_not_found' : 'file_not_found';
  const failureError = !owner ? 'Agent owner cannot be verified.' : 'File cannot be verified.';
  if (!owner || !input.file) {
    return {
      status: 'failed',
      data: output,
      observations: [failureReason],
      evidenceIds,
      toolCalls: [...toolCalls, !owner ? 'file.share.owner_missing' : 'file.share.file_missing'],
      risk: policy.risk,
      policyReasons: [failureReason],
      error: failureError,
      permissionDecision,
      invocation: createToolInvocationRecord({
        toolName: 'file.share',
        agentId: request.agent.id,
        roomId: request.sourceRoomId,
        status: invocationStatusForResult('failed'),
        permission: permissionDecision,
        inputSummary,
        outputSummary: fileShareOutputSummary(output),
        evidenceIds,
        error: failureError
      })
    };
  }

  const message = createAgentFileMessage({
    agent: request.agent,
    ownerName: owner.name,
    roomId: targetRoomId,
    file: input.file
  });
  const data: FileShareToolOutput = {
    ...output,
    message
  };

  return {
    status: 'ok',
    data,
    observations: policy.reasons,
    evidenceIds,
    toolCalls: [...toolCalls, 'file.share', 'matrix.send_event'],
    risk: policy.risk,
    policyReasons: policy.reasons,
    permissionDecision,
    invocation: createToolInvocationRecord({
      toolName: 'file.share',
      agentId: request.agent.id,
      roomId: request.sourceRoomId,
      status: invocationStatusForResult('ok'),
      permission: permissionDecision,
      inputSummary,
      outputSummary: fileShareOutputSummary(data),
      evidenceIds
    })
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
      error: validated.error,
      invocation: validationFailedInvocation({
        toolName: 'message.send',
        agentId: request.agent.id,
        roomId: request.sourceRoomId,
        error: validated.error
      })
    };
  }

  const input = validated.value as MessageSendInput;
  const policy = assessMessageSendPolicy(state, {
    agent: request.agent,
    targetRoomId: input.targetRoomId,
    targetUserId: input.targetUserId,
    messageBody: input.messageBody
  });
  const permissionDecision = createToolPermissionDecision({
    tool,
    policy,
    agentId: request.agent.id,
    roomId: request.sourceRoomId
  });
  const evidenceIds = [input.targetRoomId, input.targetUserId].filter(Boolean) as string[];
  const output: MessageSendToolOutput = {
    targetRoomId: input.targetRoomId,
    targetUserId: input.targetUserId,
    messageBody: input.messageBody
  };
  const inputSummary = messageSendInputSummary(input);

  if (policy.outcome === 'deny') {
    return {
      status: 'denied',
      data: output,
      observations: policy.reasons,
      evidenceIds,
      toolCalls: [...toolCalls, 'message.send'],
      risk: policy.risk,
      policyReasons: policy.reasons,
      permissionDecision,
      invocation: createToolInvocationRecord({
        toolName: 'message.send',
        agentId: request.agent.id,
        roomId: request.sourceRoomId,
        status: invocationStatusForResult('denied'),
        permission: permissionDecision,
        inputSummary,
        outputSummary: messageSendOutputSummary(output),
        evidenceIds
      })
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
      policyReasons: policy.reasons,
      permissionDecision,
      invocation: createToolInvocationRecord({
        toolName: 'message.send',
        agentId: request.agent.id,
        roomId: request.sourceRoomId,
        status: invocationStatusForResult('needs_confirmation'),
        permission: permissionDecision,
        inputSummary,
        outputSummary: messageSendOutputSummary(output),
        evidenceIds
      })
    };
  }

  const owner = state.users.find((user) => user.id === request.agent.ownerId);
  const failureError = 'Agent owner cannot be verified.';
  if (!owner) {
    return {
      status: 'failed',
      data: output,
      observations: ['owner_not_found'],
      evidenceIds,
      toolCalls: [...toolCalls, 'message.send.owner_missing'],
      risk: policy.risk,
      policyReasons: ['owner_not_found'],
      error: failureError,
      permissionDecision,
      invocation: createToolInvocationRecord({
        toolName: 'message.send',
        agentId: request.agent.id,
        roomId: request.sourceRoomId,
        status: invocationStatusForResult('failed'),
        permission: permissionDecision,
        inputSummary,
        outputSummary: messageSendOutputSummary(output),
        evidenceIds,
        error: failureError
      })
    };
  }

  const message = createAgentDelegatedMessage({
    agent: request.agent,
    ownerName: owner.name,
    roomId: input.targetRoomId,
    body: input.messageBody
  });
  const data: MessageSendToolOutput = {
    ...output,
    message
  };

  return {
    status: 'ok',
    data,
    observations: policy.reasons,
    evidenceIds,
    toolCalls: [...toolCalls, 'message.send', 'matrix.send_event'],
    risk: policy.risk,
    policyReasons: policy.reasons,
    permissionDecision,
    invocation: createToolInvocationRecord({
      toolName: 'message.send',
      agentId: request.agent.id,
      roomId: request.sourceRoomId,
      status: invocationStatusForResult('ok'),
      permission: permissionDecision,
      inputSummary,
      outputSummary: messageSendOutputSummary(data),
      evidenceIds
    })
  };
}

function invocationStatusForResult(status: CoreToolResultStatus): ToolInvocationStatus {
  if (status === 'denied') return 'denied';
  if (status === 'needs_confirmation') return 'awaiting_permission';
  if (status === 'ok') return 'completed';
  if (status === 'failed' || status === 'not_found') return 'failed';
  return 'failed';
}

function validationFailedInvocation(input: {
  toolName: AgentCoreToolName;
  agentId: string;
  roomId: string;
  error: string;
}): ToolInvocationRecord {
  return createToolInvocationRecord({
    toolName: input.toolName,
    agentId: input.agentId,
    roomId: input.roomId,
    status: 'validation_failed',
    error: input.error
  });
}

function messageSendInputSummary(input: MessageSendInput): Record<string, unknown> {
  return compactSummary({
    targetRoomId: input.targetRoomId,
    targetUserId: input.targetUserId,
    messageLength: input.messageBody.length
  });
}

function messageSendOutputSummary(output: MessageSendToolOutput): Record<string, unknown> {
  return compactSummary({
    messageId: output.message?.id,
    roomId: output.message?.roomId ?? output.targetRoomId
  });
}

function fileShareInputSummary(input: {
  targetRoomId: string;
  requesterId: string;
  fileId?: string;
  fileVersion?: number;
}): Record<string, unknown> {
  return compactSummary({
    targetRoomId: input.targetRoomId,
    requesterId: input.requesterId,
    fileId: input.fileId,
    fileVersion: input.fileVersion
  });
}

function fileShareOutputSummary(output: FileShareToolOutput): Record<string, unknown> {
  return compactSummary({
    fileId: output.file?.id,
    messageId: output.message?.id,
    roomId: output.message?.roomId ?? output.targetRoomId
  });
}

function compactSummary(summary: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
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
    senderName: assistantSenderName(input.ownerName),
    body: input.body,
    sentAt: new Date().toISOString(),
    type: 'agent',
    agentLabel: assistantAgentLabel('delegated_message'),
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
    senderName: assistantSenderName(input.ownerName),
    body: assistantFileShareBody({ ownerName: input.ownerName, fileName: input.file.name }),
    sentAt: new Date().toISOString(),
    type: 'file',
    agentLabel: assistantAgentLabel('delegated_file'),
    sourceAgentId: input.agent.id,
    fileId: input.file.id,
    mxcUri: input.file.mxcUri,
    contentType: input.file.contentType,
    size: input.file.size
  };
}
