import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { completeAgentAction, rejectAgentAction } from '../domain/actionQueue';
import {
  answerDeadlineQuestion,
  coordinateAgents,
  createFileShareAction,
  summarizeRoom
} from '../domain/agentEngine';
import { createDemoState } from '../domain/demoState';
import { buildShortTermContext, listAgentMemories } from '../domain/memory';
import type { AgentActionLog, AgentActionRequest, AgentRunRequest, DemoState, FileItem, Message } from '../domain/types';
import { getAiActorProfile, buildHumanReplyInstructions } from './aiActors';
import { runAiAutoreplies } from './aiAutoreply';
import type { AiProvider } from './aiProvider';
import { runAgentIntent } from './agentRunRuntime';
import { runFileShareAction } from './agentRuntime';
import { createAiDemoSeedProvider } from './aiDemoSeed';
import { createRuntimeDemoAssets, type DemoAsset } from './demoAssets';
import { MatrixStore } from './matrixClient';
import { JsonStateStore, type StateStore } from './stateStore';

interface ServerOptions {
  dbPath: string;
  port: number;
  host?: string;
  matrixBootstrapPath?: string | null;
  stateStore?: StateStore;
  aiProvider?: AiProvider;
  apiToken?: string | null;
  allowedOrigins?: string[];
  maxUploadBytes?: number;
}

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

type EventClient = ServerResponse<IncomingMessage>;

const jsonHeaders = {
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-file-name,x-agent-im-token,authorization',
  'content-type': 'application/json; charset=utf-8'
};

const defaultAllowedOrigins = ['http://127.0.0.1:5175', 'http://localhost:5175'];
const defaultMaxUploadBytes = 10 * 1024 * 1024;

export async function createAppServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const db = options.stateStore ?? new JsonStateStore(options.dbPath);
  await db.init();
  const matrixPath =
    options.matrixBootstrapPath === undefined
      ? process.env.MATRIX_BOOTSTRAP_PATH ?? 'data/matrix-bootstrap.json'
      : options.matrixBootstrapPath;
  const matrixStore = matrixPath ? await MatrixStore.fromFile(matrixPath) : null;
  const aiProvider = options.aiProvider ?? createAiDemoSeedProvider(process.env);
  const enableAutoreplyRuntime = Boolean(options.aiProvider || process.env.DEEPSEEK_API_KEY?.trim());
  const apiToken = options.apiToken === undefined ? process.env.AGENT_IM_API_TOKEN?.trim() : options.apiToken;
  const allowedOrigins = options.allowedOrigins ?? parseAllowedOrigins(process.env.AGENT_IM_ALLOWED_ORIGINS);
  const maxUploadBytes =
    options.maxUploadBytes ?? Number(process.env.AGENT_IM_MAX_UPLOAD_BYTES ?? defaultMaxUploadBytes);
  const eventClients = new Set<EventClient>();

  async function readRuntimeState(): Promise<DemoState> {
    const state = await db.read();
    return matrixStore ? matrixStore.hydrateState(state) : state;
  }

  async function publishRuntimeState(): Promise<void> {
    publish(eventClients, 'state', await readRuntimeState());
  }

  const server = createServer(async (request, response) => {
    try {
      if (!applyCorsHeaders(request, response, allowedOrigins)) {
        return sendJson(response, { error: 'origin not allowed' }, 403);
      }

      if (request.method === 'OPTIONS') {
        response.writeHead(204, jsonHeaders);
        response.end();
        return;
      }

      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${options.port}`}`);

      if (!authorizeRequest(request, apiToken)) {
        return sendJson(response, { error: 'unauthorized' }, 401);
      }

      if (request.method === 'GET' && url.pathname === '/api/state') {
        return sendJson(response, await readRuntimeState());
      }

      if (request.method === 'GET' && url.pathname === '/api/agent/actions') {
        const state = await db.read();
        return sendJson(response, { actions: state.actionRequests });
      }

      if (request.method === 'GET' && url.pathname === '/api/memories') {
        const agentId = url.searchParams.get('agentId') ?? '';
        const query = url.searchParams.get('query') ?? '';
        const state = await db.read();
        return sendJson(response, { memories: listAgentMemories(state, agentId, query) });
      }

      const actionReviewMatch = url.pathname.match(/^\/api\/agent\/actions\/([^/]+)\/(confirm|reject)$/);
      if (request.method === 'POST' && actionReviewMatch) {
        const actionId = decodeURIComponent(actionReviewMatch[1]);
        const decision = actionReviewMatch[2] as 'confirm' | 'reject';
        const body = await readJson<{ reviewerId: string; reason: string }>(request);
        const state = await db.read();
        const resolved = await resolveAgentActionReview(state, actionId, decision, body, matrixStore);

        await db.write(resolved.state);
        await publishRuntimeState();
        return sendJson(response, { action: resolved.action, log: resolved.log });
      }

      const fileDownloadMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/download$/);
      if (request.method === 'GET' && fileDownloadMatch) {
        const state = await db.read();
        const file = state.files.find((candidate) => candidate.id === decodeURIComponent(fileDownloadMatch[1]));
        if (!file) {
          return sendJson(response, { error: 'file not found' }, 404);
        }
        if (!matrixStore || !file.mxcUri) {
          return sendJson(response, { error: 'Matrix media is not available for this file' }, 404);
        }

        const media = await matrixStore.downloadMedia(file.mxcUri, file.name);
        return sendBytes(response, media.bytes, {
          contentType: media.contentType || file.contentType || 'application/octet-stream',
          filename: file.name
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, {
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'content-type': 'text/event-stream; charset=utf-8'
        });
        response.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
        eventClients.add(response);
        request.on('close', () => eventClients.delete(response));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/state/reset') {
        const state = createDemoState();
        await db.write(state);
        await publishRuntimeState();
        return sendJson(response, await readRuntimeState());
      }

      if (request.method === 'POST' && url.pathname === '/api/matrix/sync-once') {
        const baseState = await db.read();
        if (!matrixStore) {
          return sendJson(response, { messagesAdded: 0, checkpoints: baseState.matrixObserverCheckpoints });
        }
        const synced = await matrixStore.syncStateOnce(baseState);
        await db.write(synced.state);
        await publishRuntimeState();
        return sendJson(response, {
          messagesAdded: synced.messagesAdded,
          checkpoints: synced.state.matrixObserverCheckpoints
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/messages') {
        const body = await readJson<{ roomId: string; senderId: string; body: string }>(request);
        const state = await readRuntimeState();
        const message = matrixStore
          ? await matrixStore.sendMessage(state, body)
          : createUserMessage(state, body);
        const baseState = await db.read();
        let nextState = { ...baseState, messages: appendMessage(baseState.messages, message) };
        let autoReplies: Message[] = [];
        let autoReplyJobs: DemoState['aiReplyJobs'] = [];
        if (enableAutoreplyRuntime) {
          const runtimeState = matrixStore ? await matrixStore.hydrateState(nextState) : nextState;
          const auto = await runAiAutoreplies({
            state: runtimeState,
            triggerMessage: message,
            aiProvider,
            sendMessage: async (sendState, reply) =>
              matrixStore ? matrixStore.sendMessage(sendState, reply) : createUserMessage(sendState, reply)
          });
          nextState = auto.state;
          autoReplies = auto.messages;
          autoReplyJobs = auto.jobs;
        }
        await db.write(nextState);
        await publishRuntimeState();
        return sendJson(response, { ...message, autoReplies, autoReplyJobs }, 201);
      }

      if (request.method === 'POST' && url.pathname === '/api/ai/human-reply') {
        const body = await readJson<{ roomId: string; userId: string; prompt?: string }>(request);
        const state = await readRuntimeState();
        const profile = getAiActorProfile(state, body.userId, body.roomId);
        const text = await aiProvider.generateText({
          actorRole: 'human_user',
          actorId: body.userId,
          instructions: buildHumanReplyInstructions(state, profile),
          input: [body.prompt ?? '请自然回复当前聊天。', buildShortTermContext(state, body.roomId)].join('\n\n'),
          maxOutputTokens: 160
        });
        const message = matrixStore
          ? await matrixStore.sendMessage(state, { roomId: body.roomId, senderId: body.userId, body: text })
          : createUserMessage(state, { roomId: body.roomId, senderId: body.userId, body: text });
        const log = createRuntimeLog({
          agentId: `actor-${body.userId}`,
          roomId: body.roomId,
          action: `ai_human_reply:${body.userId}`,
          status: 'executed',
          risk: {
            level: 'low',
            score: 0.16,
            reason: 'AI human actor generated one chat message and wrote it to the room event stream.',
            model: 'ai-human-runtime-v1'
          },
          contextIds: [message.id],
          toolCalls: ['deepseek.flash.chat.completions', 'matrix.send_event']
        });
        const baseState = await db.read();
        const nextState = {
          ...baseState,
          messages: appendMessage(baseState.messages, message),
          actionLogs: [log, ...baseState.actionLogs]
        };
        await db.write(nextState);
        await publishRuntimeState();
        return sendJson(response, { message, log }, 201);
      }

      if (request.method === 'POST' && url.pathname === '/api/files/upload') {
        const roomId = url.searchParams.get('roomId') ?? '';
        const senderId = url.searchParams.get('senderId') ?? '';
        const agentCanShare = url.searchParams.get('agentCanShare') === 'true';
        const filename = parseUploadFileName(request);
        const contentType = getContentType(request);
        const bytes = await readRawBody(request);
        const state = await readRuntimeState();
        validateFileUpload(state, { roomId, senderId, filename, bytes, contentType, maxUploadBytes });

        const baseState = await db.read();
        let file = createUploadedFile(baseState, {
          roomId,
          senderId,
          filename,
          contentType,
          size: bytes.byteLength,
          agentCanShare
        });
        let message: Message | undefined;

        if (matrixStore) {
          const media = await matrixStore.uploadMedia({
            senderId,
            filename: file.name,
            contentType,
            bytes
          });
          file = { ...file, mxcUri: media.mxcUri, size: media.size };
          message = await matrixStore.sendMessage(
            state,
            {
              roomId,
              senderId,
              body: file.name
            },
            {
              fileId: file.id,
              fileName: file.name,
              mxcUri: media.mxcUri,
              mimeType: contentType,
              size: media.size
            }
          );
          file = { ...file, matrixEventId: message.id };
        } else {
          message = createFileUploadMessage(state, file);
        }

        const log = createFileUploadLog(baseState, file, message, Boolean(matrixStore));

        const nextState = {
          ...baseState,
          files: [file, ...baseState.files],
          messages: appendMessage(baseState.messages, message),
          actionLogs: [log, ...baseState.actionLogs]
        };
        await db.write(nextState);
        await publishRuntimeState();
        return sendJson(response, file, 201);
      }

      if (request.method === 'POST' && url.pathname === '/api/demo/assets/generate') {
        const body = await readJson<{ roomId: string; senderId: string }>(request);
        const state = await readRuntimeState();
        validateFileUpload(state, {
          roomId: body.roomId,
          senderId: body.senderId,
          filename: 'demo-assets',
          bytes: Buffer.from('demo'),
          contentType: 'application/octet-stream',
          maxUploadBytes
        });
        const baseState = await db.read();
        const generated = await generateDemoAssetsForRoom(baseState, state, {
          roomId: body.roomId,
          senderId: body.senderId,
          matrixStore
        });
        await db.write(generated.state);
        await publishRuntimeState();
        return sendJson(response, { files: generated.files, messages: generated.messages }, 201);
      }

      if (request.method === 'POST' && url.pathname === '/api/agent/summary') {
        const body = await readJson<{ agentId: string; roomId: string }>(request);
        const state = await readRuntimeState();
        const result = await summarizeRoom(state, body.roomId, body.agentId);
        const log = createRuntimeLog({
          agentId: body.agentId,
          roomId: body.roomId,
          action: `总结 ${getRoomName(state, body.roomId)} 的授权上下文`,
          status: 'executed',
          risk: {
            level: 'low',
            score: 0.08,
            reason: '只读总结，不发送消息、不改动文件或日程。',
            model: 'risk-mini-v1'
          },
          contextIds: result.sources,
          toolCalls: ['room_search', 'task_extract']
        });
        const baseState = await db.read();
        const nextState = { ...baseState, actionLogs: [log, ...baseState.actionLogs] };
        await db.write(nextState);
        await publishRuntimeState();
        return sendJson(response, { result, log });
      }

      if (request.method === 'POST' && url.pathname === '/api/agent/deadline') {
        const body = await readJson<{ agentId: string; roomId: string; question: string }>(request);
        const state = await readRuntimeState();
        const result = await answerDeadlineQuestion(state, body);
        const log = createRuntimeLog({
          agentId: body.agentId,
          roomId: body.roomId,
          action: `回答问题：${body.question}`,
          status: 'executed',
          risk: {
            level: 'low',
            score: 0.06,
            reason: '只读检索群聊和文件，不代表用户发言。',
            model: 'risk-mini-v1'
          },
          contextIds: result.citations,
          toolCalls: ['room_search', 'file_library.search']
        });
        const baseState = await db.read();
        const nextState = { ...baseState, actionLogs: [log, ...baseState.actionLogs] };
        await db.write(nextState);
        await publishRuntimeState();
        return sendJson(response, { result, log });
      }

      if (request.method === 'POST' && url.pathname === '/api/agent/share-file') {
        const body = await readJson<{
          agentId: string;
          roomId: string;
          requesterId: string;
          requestText: string;
        }>(request);
        const state = await readRuntimeState();
        const runtime = await runFileShareAction(state, body);
        const result = runtime.result;
        let message = result.message;
        if (matrixStore && result.message) {
          message = await matrixStore.sendMessage(
            state,
            {
              roomId: result.message.roomId,
              senderId: result.message.senderId,
              body: result.message.body
            },
            {
              agentLabel: result.message.agentLabel,
              sourceAgentId: result.message.sourceAgentId,
              fileId: result.message.fileId,
              fileName: result.file?.name,
              mxcUri: result.file?.mxcUri,
              mimeType: result.file?.contentType,
              size: result.file?.size
            }
          );
          result.message = message;
        }
        const baseState = await db.read();
        const nextState = {
          ...baseState,
          messages: appendMessage(baseState.messages, message),
          actionLogs: runtime.state.actionLogs,
          actionRequests: runtime.state.actionRequests
        };
        await db.write(nextState);
        await publishRuntimeState();
        return sendJson(response, { result });
      }

      if (request.method === 'POST' && url.pathname === '/api/agent/run') {
        const body = await readJson<AgentRunRequest>(request);
        const runtimeState = await readRuntimeState();
        const runtime = await runAgentIntent(runtimeState, body, aiProvider);
        let message = runtime.response.message;
        if (matrixStore && message) {
          message = await matrixStore.sendMessage(
            runtimeState,
            {
              roomId: message.roomId,
              senderId: message.senderId,
              body: message.body
            },
            {
              agentLabel: message.agentLabel,
              sourceAgentId: message.sourceAgentId,
              fileId: message.fileId,
              fileName: runtime.response.result && 'file' in runtime.response.result ? runtime.response.result.file?.name : undefined,
              mxcUri: message.mxcUri,
              mimeType: message.contentType,
              size: message.size
            }
          );
          runtime.response.message = message;
        }
        const baseState = await db.read();
        const nextState = mergeRuntimeState(baseState, runtime.state, message);
        await db.write(nextState);
        await publishRuntimeState();
        return sendJson(response, runtime.response);
      }

      if (request.method === 'POST' && url.pathname === '/api/agent/coordinate') {
        const body = await readJson<{
          fromAgentId: string;
          toAgentId: string;
          roomId: string;
          proposal: string;
        }>(request);
        const state = await readRuntimeState();
        const result = await coordinateAgents(state, body);
        let message = createAgentCoordinationMessage(state, body.toAgentId, result.proposedPlan);
        if (matrixStore) {
          message = await matrixStore.sendMessage(
            state,
            {
              roomId: message.roomId,
              senderId: message.senderId,
              body: message.body
            },
            {
              agentLabel: message.agentLabel,
              sourceAgentId: message.sourceAgentId
            }
          );
        }
        const baseState = await db.read();
        const nextState = {
          ...baseState,
          messages: appendMessage(baseState.messages, message),
          actionLogs: [result.log, ...baseState.actionLogs]
        };
        await db.write(nextState);
        await publishRuntimeState();
        return sendJson(response, { result, message });
      }

      sendJson(response, { error: 'not found' }, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        return sendJson(response, { error: error.message }, error.status);
      }
      const message = error instanceof Error ? error.message : 'unknown error';
      sendJson(response, { error: message }, 500);
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, host, resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    url: `http://${host}:${port}`,
    close: () => closeServer(server)
  };
}

function createUploadedFile(
  state: DemoState,
  input: {
    roomId: string;
    senderId: string;
    filename: string;
    contentType: string;
    size: number;
    agentCanShare: boolean;
  }
): FileItem {
  const matchingVersions = state.files
    .filter(
      (file) =>
        file.roomId === input.roomId && file.uploaderId === input.senderId && file.name === input.filename
    )
    .map((file) => file.version);
  const version = matchingVersions.length > 0 ? Math.max(...matchingVersions) + 1 : 1;

  return {
    id: `file-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: input.filename,
    uploaderId: input.senderId,
    version,
    roomId: input.roomId,
    updatedAt: new Date().toISOString(),
    visibility: 'room',
    agentCanShare: input.agentCanShare,
    tags: ['upload'],
    summary: `Uploaded file ${input.filename}`,
    contentType: input.contentType,
    size: input.size
  };
}

function createFileUploadMessage(state: DemoState, file: FileItem): Message {
  const user = state.users.find((candidate) => candidate.id === file.uploaderId);
  if (!user) {
    throw new Error(`unknown sender: ${file.uploaderId}`);
  }

  return {
    id: `msg-file-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    roomId: file.roomId,
    senderId: user.id,
    senderName: user.name,
    body: file.name,
    sentAt: new Date().toISOString(),
    type: 'file',
    fileId: file.id,
    mxcUri: file.mxcUri,
    contentType: file.contentType,
    size: file.size
  };
}

function createFileUploadLog(
  state: DemoState,
  file: FileItem,
  message: Message | undefined,
  usedMatrix: boolean
): AgentActionLog {
  const uploader = state.users.find((candidate) => candidate.id === file.uploaderId);
  const contextIds = [file.id, file.matrixEventId, message?.id].filter(Boolean) as string[];
  return createRuntimeLog({
    agentId: uploader?.agentId ?? 'system',
    roomId: file.roomId,
    action: `upload_file:${file.name}`,
    status: 'executed',
    risk: {
      level: 'low',
      score: 0.12,
      reason: 'User-initiated room file upload with explicit Agent sharing permission captured in metadata.',
      model: 'risk-mini-v1'
    },
    contextIds,
    toolCalls: [
      'file_library.create',
      ...(usedMatrix ? ['matrix.media.upload', 'matrix.send_event'] : ['local.message.create'])
    ]
  });
}

async function generateDemoAssetsForRoom(
  baseState: DemoState,
  runtimeState: DemoState,
  input: { roomId: string; senderId: string; matrixStore: MatrixStore | null }
): Promise<{ state: DemoState; files: FileItem[]; messages: Message[] }> {
  let nextState = baseState;
  const files: FileItem[] = [];
  const messages: Message[] = [];

  for (const asset of createRuntimeDemoAssets()) {
    let file = createGeneratedAssetFile(nextState, asset, input);
    let message: Message | undefined;
    if (input.matrixStore) {
      const media = await input.matrixStore.uploadMedia({
        senderId: input.senderId,
        filename: asset.name,
        contentType: asset.contentType,
        bytes: asset.bytes
      });
      file = { ...file, mxcUri: media.mxcUri, size: media.size };
      message = await input.matrixStore.sendMessage(
        runtimeState,
        {
          roomId: input.roomId,
          senderId: input.senderId,
          body: file.name
        },
        {
          fileId: file.id,
          fileName: file.name,
          mxcUri: file.mxcUri,
          mimeType: file.contentType,
          size: file.size
        }
      );
      file = { ...file, matrixEventId: message.id };
    } else {
      message = createFileUploadMessage(runtimeState, file);
    }

    const log = createFileUploadLog(nextState, file, message, Boolean(input.matrixStore));
    files.push(file);
    if (message) {
      messages.push(message);
    }
    nextState = {
      ...nextState,
      files: [file, ...nextState.files],
      messages: appendMessage(nextState.messages, message),
      actionLogs: [log, ...nextState.actionLogs]
    };
  }

  return { state: nextState, files, messages };
}

function createGeneratedAssetFile(
  state: DemoState,
  asset: DemoAsset,
  input: { roomId: string; senderId: string }
): FileItem {
  const matchingVersions = state.files
    .filter((file) => file.roomId === input.roomId && file.uploaderId === input.senderId && file.name === asset.name)
    .map((file) => file.version);
  return {
    id: `file-demo-asset-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: asset.name,
    uploaderId: input.senderId,
    version: matchingVersions.length > 0 ? Math.max(...matchingVersions) + 1 : 1,
    roomId: input.roomId,
    updatedAt: new Date().toISOString(),
    visibility: 'room',
    agentCanShare: true,
    tags: asset.tags,
    summary: asset.summary,
    contentType: asset.contentType,
    size: asset.bytes.byteLength
  };
}

function mergeRuntimeState(
  baseState: DemoState,
  runtimeState: DemoState,
  message: Message | undefined
): DemoState {
  return {
    ...baseState,
    messages: appendMessage(baseState.messages, message),
    actionLogs: runtimeState.actionLogs,
    actionRequests: runtimeState.actionRequests,
    memories: runtimeState.memories,
    matrixObserverCheckpoints: runtimeState.matrixObserverCheckpoints
  };
}

function appendMessage(messages: Message[], message: Message | undefined): Message[] {
  if (!message) {
    return messages;
  }
  return [...messages.filter((candidate) => candidate.id !== message.id), message].sort((a, b) =>
    a.sentAt.localeCompare(b.sentAt)
  );
}

async function resolveAgentActionReview(
  state: DemoState,
  actionId: string,
  decision: 'confirm' | 'reject',
  input: { reviewerId: string; reason: string },
  matrixStore: MatrixStore | null
): Promise<{ state: DemoState; action: AgentActionRequest; log: AgentActionLog }> {
  const action = state.actionRequests.find((candidate) => candidate.id === actionId);
  if (!action) {
    throw new Error(`unknown action request: ${actionId}`);
  }
  if (!input.reviewerId) {
    throw new Error('reviewerId is required');
  }

  const log = createRuntimeLog({
    agentId: action.agentId,
    roomId: action.roomId,
    action: `${decision}_action:${action.id}`,
    status: decision === 'confirm' ? 'executed' : 'blocked',
    risk: {
      level: decision === 'confirm' ? 'low' : 'medium',
      score: decision === 'confirm' ? 0.2 : 0.64,
      reason: `Human review by ${input.reviewerId}: ${input.reason || 'no reason provided'}`,
      model: 'human-review-v1'
    },
    contextIds: [action.id, input.reviewerId],
    toolCalls: [`agent_action.${decision}`]
  });
  let nextState = {
    ...state,
    actionLogs: [log, ...state.actionLogs]
  };

  if (decision === 'confirm') {
    nextState = await executeConfirmedAgentAction(nextState, action, matrixStore);
  }

  const resolved =
    decision === 'confirm'
      ? completeAgentAction(nextState, action.id, {
          logId: log.id,
          risk: log.risk,
          updatedAt: log.createdAt
        })
      : rejectAgentAction(nextState, action.id, {
          logId: log.id,
          risk: log.risk,
          updatedAt: log.createdAt
        });

  return {
    state: resolved.state,
    action: resolved.request,
    log
  };
}

async function executeConfirmedAgentAction(
  state: DemoState,
  action: AgentActionRequest,
  matrixStore: MatrixStore | null
): Promise<DemoState> {
  if (action.kind !== 'share_file') {
    return state;
  }

  const result = await createFileShareAction(
    state,
    {
      agentId: action.agentId,
      roomId: action.roomId,
      requesterId: String(action.input.requesterId ?? ''),
      requestText: String(action.input.requestText ?? '')
    },
    { forceExecute: true }
  );

  if (result.status !== 'executed' || !result.message) {
    return state;
  }

  let message = result.message;
  if (matrixStore) {
    message = await matrixStore.sendMessage(
      state,
      {
        roomId: message.roomId,
        senderId: message.senderId,
        body: message.body
      },
      {
        agentLabel: message.agentLabel,
        sourceAgentId: message.sourceAgentId,
        fileId: message.fileId,
        fileName: result.file?.name,
        mxcUri: result.file?.mxcUri,
        mimeType: result.file?.contentType,
        size: result.file?.size
      }
    );
  }

  return {
    ...state,
    messages: [...state.messages.filter((candidate) => candidate.id !== message.id), message],
    actionLogs: [...state.actionLogs, result.log]
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return defaultAllowedOrigins;
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function applyCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: string[]
): boolean {
  const origin = getHeaderValue(request.headers.origin);
  if (!origin) {
    response.setHeader('access-control-allow-origin', '*');
    return true;
  }

  if (!allowedOrigins.includes(origin)) {
    return false;
  }

  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'origin');
  return true;
}

function authorizeRequest(request: IncomingMessage, apiToken: string | null | undefined): boolean {
  if (!apiToken || request.method === 'GET' || request.method === 'OPTIONS') {
    return true;
  }

  const token = getHeaderValue(request.headers['x-agent-im-token']) ?? parseBearerToken(request);
  return token === apiToken;
}

function parseBearerToken(request: IncomingMessage): string | undefined {
  const authorization = getHeaderValue(request.headers.authorization);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

const uploadPolicy = {
  allowedTypes: new Set([
    'application/json',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
    'text/markdown',
    'text/plain'
  ]),
  allowedExtensions: new Set(['.docx', '.jpeg', '.jpg', '.json', '.md', '.pdf', '.png', '.pptx', '.txt', '.xlsx'])
};

function validateFileUpload(
  state: DemoState,
  input: {
    roomId: string;
    senderId: string;
    filename: string;
    bytes: Uint8Array;
    contentType: string;
    maxUploadBytes: number;
  }
): void {
  if (!state.rooms.some((room) => room.id === input.roomId)) {
    throw new HttpError(400, `unknown room: ${input.roomId}`);
  }
  if (!state.users.some((user) => user.id === input.senderId)) {
    throw new HttpError(400, `unknown sender: ${input.senderId}`);
  }
  if (!input.filename.trim()) {
    throw new HttpError(400, 'file name is required');
  }
  if (input.bytes.byteLength === 0) {
    throw new HttpError(400, 'file body is required');
  }
  if (input.bytes.byteLength > input.maxUploadBytes) {
    throw new HttpError(413, 'file too large');
  }

  if (input.filename !== 'demo-assets') {
    const extension = input.filename.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (!uploadPolicy.allowedTypes.has(input.contentType) || !extension || !uploadPolicy.allowedExtensions.has(extension)) {
      throw new HttpError(400, 'unsupported file type');
    }
  }
}

function parseUploadFileName(request: IncomingMessage): string {
  const raw = getHeaderValue(request.headers['x-file-name']);
  if (!raw) {
    throw new Error('x-file-name header is required');
  }

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }

  return decoded.trim().replace(/[\\/]/g, '_');
}

function getContentType(request: IncomingMessage): string {
  return getHeaderValue(request.headers['content-type'])?.split(';')[0]?.trim() || 'application/octet-stream';
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function createUserMessage(state: DemoState, input: { roomId: string; senderId: string; body: string }): Message {
  const room = state.rooms.find((candidate) => candidate.id === input.roomId);
  const user = state.users.find((candidate) => candidate.id === input.senderId);
  if (!room) {
    throw new Error(`unknown room: ${input.roomId}`);
  }
  if (!user) {
    throw new Error(`unknown sender: ${input.senderId}`);
  }
  if (!input.body.trim()) {
    throw new Error('message body is required');
  }

  return {
    id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    roomId: room.id,
    senderId: user.id,
    senderName: user.name,
    body: input.body.trim(),
    sentAt: new Date().toISOString(),
    type: 'text'
  };
}

function createAgentCoordinationMessage(state: DemoState, agentId: string, body: string): Message {
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  const owner = state.users.find((candidate) => candidate.id === agent?.ownerId);
  if (!agent || !owner) {
    throw new Error(`unknown agent: ${agentId}`);
  }

  return {
    id: `msg-agent-coordinate-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    roomId: 'room-agent',
    senderId: owner.id,
    senderName: agent.displayName,
    body,
    sentAt: new Date().toISOString(),
    type: 'agent',
    agentLabel: `${owner.name}的 Agent 协调`,
    sourceAgentId: agent.id
  };
}

function createRuntimeLog(input: Omit<AgentActionLog, 'id' | 'createdAt'>): AgentActionLog {
  return {
    id: `log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    ...input
  };
}

function getRoomName(state: DemoState, roomId: string): string {
  return state.rooms.find((room) => room.id === roomId)?.name ?? roomId;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = (await readRawBody(request)).toString('utf8');
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, jsonHeaders);
  response.end(JSON.stringify(body));
}

function sendBytes(
  response: ServerResponse,
  bytes: Uint8Array,
  input: { contentType: string; filename: string }
): void {
  response.writeHead(200, {
    'content-disposition': contentDisposition(input.filename),
    'content-length': String(bytes.byteLength),
    'content-type': input.contentType
  });
  response.end(Buffer.from(bytes));
}

function contentDisposition(filename: string): string {
  const asciiName = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function publish(clients: Set<EventClient>, event: string, body: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
