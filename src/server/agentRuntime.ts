import {
  blockAgentAction,
  completeAgentAction,
  enqueueAgentAction,
  requireActionConfirmation
} from '../domain/actionQueue';
import { createFileShareAction } from '../domain/agentEngine';
import type { AgentActionRequest, DemoState, FileShareAction } from '../domain/types';
import type { AiProvider } from './aiProvider';
import { executeCoreTool } from './agentCore/toolExecutor';

interface RuntimeFileShareInput {
  id?: string;
  createdAt?: string;
  agentId: string;
  roomId: string;
  targetRoomId?: string;
  requesterId: string;
  requestText: string;
  fileId?: string;
  fileVersion?: number;
}

export async function runFileShareAction(
  state: DemoState,
  input: RuntimeFileShareInput,
  aiProvider?: AiProvider
): Promise<{ state: DemoState; result: FileShareAction; actionRequest: AgentActionRequest }> {
  const queued = enqueueAgentAction(state, {
    id: input.id,
    agentId: input.agentId,
    roomId: input.roomId,
    kind: 'share_file',
    input: {
      targetRoomId: input.targetRoomId,
      requesterId: input.requesterId,
      requestText: input.requestText,
      fileId: input.fileId,
      fileVersion: input.fileVersion
    },
    createdAt: input.createdAt
  });
  const result = await createFileShareAction(queued.state, input, {}, aiProvider);
  const enforcedResult = enforceFileSharePolicy(queued.state, input, result);
  const withLog = {
    ...queued.state,
    actionLogs: [enforcedResult.log, ...queued.state.actionLogs]
  };

  if (enforcedResult.status === 'executed') {
    const completed = completeAgentAction(withLog, queued.request.id, {
      logId: enforcedResult.log.id,
      risk: enforcedResult.risk,
      updatedAt: enforcedResult.log.createdAt
    });
    return {
      state: completed.state,
      result: enforcedResult,
      actionRequest: completed.request
    };
  }

  if (enforcedResult.status === 'blocked') {
    const blocked = blockAgentAction(withLog, queued.request.id, {
      logId: enforcedResult.log.id,
      risk: enforcedResult.risk,
      updatedAt: enforcedResult.log.createdAt
    });
    return {
      state: blocked.state,
      result: enforcedResult,
      actionRequest: blocked.request
    };
  }

  const confirmationState = enforcedResult.file && hasDownloadableBacking(enforcedResult.file)
    ? {
        ...withLog,
        actionRequests: withLog.actionRequests.map((request) =>
          request.id === queued.request.id
            ? {
                ...request,
                input: {
                  ...request.input,
                  fileId: enforcedResult.file?.id,
                  fileVersion: enforcedResult.file?.version,
                  targetRoomId: input.targetRoomId
                }
              }
            : request
        )
      }
    : withLog;
  const confirmation = requireActionConfirmation(confirmationState, queued.request.id, enforcedResult.risk, {
    updatedAt: enforcedResult.log.createdAt
  });
  return {
    state: confirmation.state,
    result: enforcedResult,
    actionRequest: confirmation.request
  };
}

function enforceFileSharePolicy(
  state: DemoState,
  input: RuntimeFileShareInput,
  result: FileShareAction
): FileShareAction {
  const agent = state.agents.find((candidate) => candidate.id === input.agentId);
  if (!agent) {
    return result;
  }

  const toolResult = executeCoreTool(state, {
    toolName: 'file.share',
    agent,
    sourceRoomId: input.roomId,
    input: {
      targetRoomId: input.targetRoomId ?? input.roomId,
      requesterId: input.requesterId,
      requestText: input.requestText,
      fileId: input.fileId,
      fileVersion: input.fileVersion,
      file: result.file
    }
  });
  const status: FileShareAction['status'] = toolResult.status === 'ok'
    ? 'executed'
    : toolResult.status === 'needs_confirmation'
      ? 'needs_confirmation'
      : 'blocked';
  const toolCalls = uniqueStrings([
    ...result.log.toolCalls.filter((toolCall) => toolCall !== 'matrix.send_event'),
    ...toolResult.toolCalls
  ]);

  return {
    ...result,
    status,
    requiresHuman: status === 'needs_confirmation',
    risk: toolResult.risk ?? {
      level: 'high',
      score: 0.9,
      reason: toolResult.error ?? 'File share tool execution failed.',
      model: 'tool-executor-v1'
    },
    file: toolResult.data?.file ?? result.file,
    message: status === 'executed' ? toolResult.data?.message : undefined,
    log: {
      ...result.log,
      status,
      risk: toolResult.risk ?? result.risk,
      toolCalls
    }
  };
}

function hasDownloadableBacking(file: NonNullable<FileShareAction['file']>): boolean {
  return Boolean(file.mxcUri || file.localPath);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
