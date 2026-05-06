import {
  completeAgentAction,
  enqueueAgentAction,
  requireActionConfirmation
} from '../domain/actionQueue';
import { createFileShareAction } from '../domain/agentEngine';
import type { AgentActionRequest, DemoState, FileShareAction } from '../domain/types';
import type { AiProvider } from './aiProvider';

interface RuntimeFileShareInput {
  id?: string;
  createdAt?: string;
  agentId: string;
  roomId: string;
  requesterId: string;
  requestText: string;
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
      requesterId: input.requesterId,
      requestText: input.requestText
    },
    createdAt: input.createdAt
  });
  const result = await createFileShareAction(queued.state, input, {}, aiProvider);
  const withLog = {
    ...queued.state,
    actionLogs: [result.log, ...queued.state.actionLogs]
  };

  if (result.status === 'executed') {
    const completed = completeAgentAction(withLog, queued.request.id, {
      logId: result.log.id,
      risk: result.risk,
      updatedAt: result.log.createdAt
    });
    return {
      state: completed.state,
      result,
      actionRequest: completed.request
    };
  }

  const confirmationState = result.file && hasDownloadableBacking(result.file)
    ? {
        ...withLog,
        actionRequests: withLog.actionRequests.map((request) =>
          request.id === queued.request.id
            ? {
                ...request,
                input: {
                  ...request.input,
                  fileId: result.file?.id,
                  fileVersion: result.file?.version
                }
              }
            : request
        )
      }
    : withLog;
  const confirmation = requireActionConfirmation(confirmationState, queued.request.id, result.risk, {
    updatedAt: result.log.createdAt
  });
  return {
    state: confirmation.state,
    result,
    actionRequest: confirmation.request
  };
}

function hasDownloadableBacking(file: NonNullable<FileShareAction['file']>): boolean {
  return Boolean(file.mxcUri || file.localPath);
}
