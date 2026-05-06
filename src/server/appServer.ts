import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { blockAgentAction, completeAgentAction, rejectAgentAction } from '../domain/actionQueue';
import {
  answerDeadlineQuestion,
  coordinateAgents,
  summarizeRoom
} from '../domain/agentEngine';
import { createDemoState } from '../domain/demoState';
import { buildShortTermContext, listAgentMemories } from '../domain/memory';
import type {
  AgentActionLog,
  AgentActionRequest,
  AgentAutopilotAction,
  AgentAutopilotPolicy,
  AgentProgressEvent,
  AgentRunRequest,
  AiRuntimeStatus,
  DemoState,
  FileItem,
  Message,
  RiskLevel
} from '../domain/types';
import { sortMessagesChronologically } from '../domain/messages';
import { getAiActorProfile, buildHumanReplyInstructions } from './aiActors';
import { recordSkippedAiAutoreplies, runAiAutoreplies } from './aiAutoreply';
import { getAiUsageSnapshot, type AiProvider } from './aiProvider';
import {
  runAgentAutopilotForMessage,
  runPendingAgentAutopilot,
  runPendingTaskFollowUps,
  type PendingAgentAutopilotResult,
  type PendingTaskFollowUpResult
} from './agentAutopilotRuntime';
import { runAgentIntent } from './agentRunRuntime';
import { runFileShareAction } from './agentRuntime';
import { createAiDemoSeedProvider } from './aiDemoSeed';
import { createRuntimeDemoAssets, type DemoAsset } from './demoAssets';
import { extractTextChunks } from './fileTextIndex';
import { MatrixStore } from './matrixClient';
import { JsonStateStore, type StateStore } from './stateStore';
import { createConfiguredWebSearchProvider, type WebSearchProvider } from './webSearch';

interface ServerOptions {
  dbPath: string;
  port: number;
  host?: string;
  matrixBootstrapPath?: string | null;
  stateStore?: StateStore;
  aiProvider?: AiProvider | null;
  apiToken?: string | null;
  allowedOrigins?: string[];
  maxUploadBytes?: number;
  mediaDir?: string;
  webSearchProvider?: WebSearchProvider | null;
  autopilotWorker?: AutopilotWorkerOptions;
}

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

interface AutopilotWorkerOptions {
  enabled?: boolean;
  intervalMs?: number;
  roomIds?: string[];
  limit?: number;
  runOnStart?: boolean;
}

interface AutopilotWorkerConfig {
  enabled: boolean;
  intervalMs: number;
  roomIds: string[];
  limit: number;
  runOnStart: boolean;
}

interface AutopilotWorkerStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  roomIds: string[];
  limit: number;
  runCount: number;
  lastProcessedCount: number;
  lastSkippedCount: number;
  lastProcessedTaskCount: number;
  lastSkippedTaskCount: number;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastError?: string;
}

interface AutopilotWorkerRunPayload {
  worker: AutopilotWorkerStatus;
  processedMessageIds: string[];
  skippedMessageIds: string[];
  processedTaskIds: string[];
  skippedTaskIds: string[];
  sessions: PendingAgentAutopilotResult['sessions'];
  messages: PendingAgentAutopilotResult['messages'];
  logs: PendingAgentAutopilotResult['logs'];
  actionRequests: PendingTaskFollowUpResult['actionRequests'];
  skippedReason?: 'disabled' | 'already_running';
}

type EventClient = ServerResponse<IncomingMessage>;

interface AutopilotPolicyPatchInput {
  agentId: string;
  enabled?: boolean;
  roomId?: string;
  roomEnabled?: boolean;
  allowedActions?: AgentAutopilotAction[];
  autoExecuteMaxRisk?: RiskLevel;
}

const jsonHeaders = {
  'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
  'access-control-allow-headers': 'content-type,x-file-name,x-agent-im-token,authorization',
  'content-type': 'application/json; charset=utf-8'
};

const defaultAllowedOrigins = [5175, 5176, 5177, 5178, 5179].flatMap((port) => [
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`
]);
const defaultMaxUploadBytes = 10 * 1024 * 1024;
const defaultAutopilotWorkerIntervalMs = 60_000;

export async function createAppServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const db = options.stateStore ?? new JsonStateStore(options.dbPath);
  await db.init();
  const matrixPath =
    options.matrixBootstrapPath === undefined
      ? normalizeMatrixBootstrapPath(process.env.MATRIX_BOOTSTRAP_PATH)
      : options.matrixBootstrapPath;
  const matrixStore = matrixPath ? await MatrixStore.fromFile(matrixPath) : null;
  const aiProvider =
    options.aiProvider === null
      ? undefined
      : options.aiProvider ?? (process.env.DEEPSEEK_API_KEY?.trim() ? createAiDemoSeedProvider(process.env) : undefined);
  const webSearchProvider =
    options.webSearchProvider === null
      ? undefined
      : options.webSearchProvider ?? createConfiguredWebSearchProvider(process.env);
  const apiToken = options.apiToken === undefined ? process.env.AGENT_IM_API_TOKEN?.trim() : options.apiToken;
  const allowedOrigins = options.allowedOrigins ?? parseAllowedOrigins(process.env.AGENT_IM_ALLOWED_ORIGINS);
  const maxUploadBytes =
    options.maxUploadBytes ?? Number(process.env.AGENT_IM_MAX_UPLOAD_BYTES ?? defaultMaxUploadBytes);
  const mediaDir = options.mediaDir ?? process.env.AGENT_IM_MEDIA_DIR ?? join(process.cwd(), 'data', 'media');
  const eventClients = new Set<EventClient>();
  let aiStatusProbe: Partial<AiRuntimeStatus> | undefined;
  const autopilotWorkerConfig = normalizeAutopilotWorkerOptions(options.autopilotWorker);
  let autopilotWorkerTimer: ReturnType<typeof setInterval> | undefined;
  let activeAutopilotWorkerRun: Promise<AutopilotWorkerRunPayload> | undefined;
  let autopilotWorkerStatus: AutopilotWorkerStatus = {
    enabled: autopilotWorkerConfig.enabled,
    running: false,
    intervalMs: autopilotWorkerConfig.enabled ? autopilotWorkerConfig.intervalMs : 0,
    roomIds: autopilotWorkerConfig.roomIds,
    limit: autopilotWorkerConfig.limit,
    runCount: 0,
    lastProcessedCount: 0,
    lastSkippedCount: 0,
    lastProcessedTaskCount: 0,
    lastSkippedTaskCount: 0
  };

  async function readRuntimeState(): Promise<DemoState> {
    const state = await db.read();
    const runtimeState = matrixStore ? await matrixStore.hydrateState(state) : state;
    return {
      ...runtimeState,
      aiStatus: createAiRuntimeStatus(aiProvider, aiStatusProbe)
    };
  }

  async function publishRuntimeState(): Promise<void> {
    publish(eventClients, 'state', await readRuntimeState());
  }

  async function updateStoredState(
    updater: (state: DemoState) => DemoState | Promise<DemoState>
  ): Promise<DemoState> {
    if (db.update) {
      return db.update(updater);
    }
    const current = await db.read();
    const next = await updater(current);
    await db.write(next);
    return next;
  }

  async function sendAutopilotMessage(sendState: DemoState, outbound: Message): Promise<Message> {
    return matrixStore
      ? matrixStore.sendMessage(
          sendState,
          {
            roomId: outbound.roomId,
            senderId: outbound.senderId,
            body: outbound.body
          },
          {
            agentLabel: outbound.agentLabel,
            sourceAgentId: outbound.sourceAgentId,
            fileId: outbound.fileId,
            fileName: outbound.fileId
              ? sendState.files.find((file) => file.id === outbound.fileId)?.name
              : undefined,
            mxcUri: outbound.mxcUri,
            mimeType: outbound.contentType,
            size: outbound.size
          }
        )
      : outbound;
  }

  async function runAutopilotWorkerOnce(): Promise<AutopilotWorkerRunPayload> {
    if (!autopilotWorkerConfig.enabled) {
      return {
        worker: { ...autopilotWorkerStatus },
        processedMessageIds: [],
        skippedMessageIds: [],
        processedTaskIds: [],
        skippedTaskIds: [],
        sessions: [],
        messages: [],
        logs: [],
        actionRequests: [],
        skippedReason: 'disabled'
      };
    }
    if (activeAutopilotWorkerRun) {
      return {
        worker: { ...autopilotWorkerStatus },
        processedMessageIds: [],
        skippedMessageIds: [],
        processedTaskIds: [],
        skippedTaskIds: [],
        sessions: [],
        messages: [],
        logs: [],
        actionRequests: [],
        skippedReason: 'already_running'
      };
    }

    activeAutopilotWorkerRun = runAutopilotWorkerOnceUnlocked().finally(() => {
      activeAutopilotWorkerRun = undefined;
    });
    return activeAutopilotWorkerRun;
  }

  async function runAutopilotWorkerOnceUnlocked(): Promise<AutopilotWorkerRunPayload> {
    autopilotWorkerStatus = {
      ...autopilotWorkerStatus,
      running: true,
      lastStartedAt: new Date().toISOString(),
      lastError: undefined
    };

    const processedMessageIds: string[] = [];
    const skippedMessageIds: string[] = [];
    const processedTaskIds: string[] = [];
    const skippedTaskIds: string[] = [];
    const sessions: AutopilotWorkerRunPayload['sessions'] = [];
    const messages: AutopilotWorkerRunPayload['messages'] = [];
    const logs: AutopilotWorkerRunPayload['logs'] = [];
    const actionRequests: AutopilotWorkerRunPayload['actionRequests'] = [];

    try {
      let state = await readRuntimeState();
      const roomIds = autopilotWorkerConfig.roomIds.length
        ? autopilotWorkerConfig.roomIds
        : selectAutopilotWorkerRoomIds(state);

      for (const roomId of roomIds) {
        const sweep = await runPendingAgentAutopilot({
          state,
          roomId,
          limit: autopilotWorkerConfig.limit,
          aiProvider,
          webSearchProvider,
          sendMessage: sendAutopilotMessage
        });
        state = sweep.state;
        processedMessageIds.push(...sweep.processedMessageIds);
        skippedMessageIds.push(...sweep.skippedMessageIds);
        sessions.push(...sweep.sessions);
        messages.push(...sweep.messages);
        logs.push(...sweep.logs);

        const followUps = runPendingTaskFollowUps({
          state,
          roomId,
          limit: autopilotWorkerConfig.limit
        });
        state = followUps.state;
        processedTaskIds.push(...followUps.processedTaskIds);
        skippedTaskIds.push(...followUps.skippedTaskIds);
        sessions.push(...followUps.sessions);
        logs.push(...followUps.logs);
        actionRequests.push(...followUps.actionRequests);
      }

      if (processedMessageIds.length > 0 || processedTaskIds.length > 0 || logs.length > 0 || messages.length > 0) {
        await updateStoredState((baseState) => mergePersistedRuntimeState(baseState, state));
        await publishRuntimeState();
      }

      autopilotWorkerStatus = {
        ...autopilotWorkerStatus,
        running: false,
        runCount: autopilotWorkerStatus.runCount + 1,
        lastProcessedCount: processedMessageIds.length + processedTaskIds.length,
        lastSkippedCount: skippedMessageIds.length,
        lastProcessedTaskCount: processedTaskIds.length,
        lastSkippedTaskCount: skippedTaskIds.length,
        lastFinishedAt: new Date().toISOString(),
        lastError: undefined
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      autopilotWorkerStatus = {
        ...autopilotWorkerStatus,
        running: false,
        runCount: autopilotWorkerStatus.runCount + 1,
        lastProcessedCount: processedMessageIds.length + processedTaskIds.length,
        lastSkippedCount: skippedMessageIds.length,
        lastProcessedTaskCount: processedTaskIds.length,
        lastSkippedTaskCount: skippedTaskIds.length,
        lastFinishedAt: new Date().toISOString(),
        lastError: message
      };
    }

    return {
      worker: { ...autopilotWorkerStatus },
      processedMessageIds,
      skippedMessageIds,
      processedTaskIds,
      skippedTaskIds,
      sessions,
      messages,
      logs,
      actionRequests
    };
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

      if (!authorizeRequest(request, url, apiToken)) {
        return sendJson(response, { error: 'unauthorized' }, 401);
      }

      if (request.method === 'GET' && url.pathname === '/api/state') {
        return sendJson(response, await readRuntimeState());
      }

      if (request.method === 'POST' && url.pathname === '/api/ai/status/check') {
        aiStatusProbe = await checkAiRuntimeHealth(aiProvider);
        return sendJson(response, { aiStatus: createAiRuntimeStatus(aiProvider, aiStatusProbe) });
      }

      if (request.method === 'GET' && url.pathname === '/api/agent/actions') {
        const state = await db.read();
        return sendJson(response, { actions: state.actionRequests });
      }

      if (request.method === 'PATCH' && url.pathname === '/api/agent/autopilot-policy') {
        const body = await readJson<AutopilotPolicyPatchInput>(request);
        let updated: ReturnType<typeof updateAutopilotPolicy> | undefined;
        await updateStoredState((state) => {
          updated = updateAutopilotPolicy(state, body);
          return updated.state;
        });
        await publishRuntimeState();
        return sendJson(response, { policy: updated!.policy });
      }

      if (request.method === 'POST' && url.pathname === '/api/agent/autopilot/run-pending') {
        const body = await readJson<{ roomId?: string; limit?: number }>(request);
        const state = await readRuntimeState();
        const sweep = await runPendingAgentAutopilot({
          state,
          roomId: body.roomId,
          limit: body.limit,
          aiProvider,
          webSearchProvider,
          sendMessage: sendAutopilotMessage
        });
        await updateStoredState((baseState) => mergePersistedRuntimeState(baseState, sweep.state));
        await publishRuntimeState();
        return sendJson(response, {
          processedMessageIds: sweep.processedMessageIds,
          skippedMessageIds: sweep.skippedMessageIds,
          sessions: sweep.sessions,
          messages: sweep.messages,
          logs: sweep.logs
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/agent/autopilot/worker') {
        return sendJson(response, { worker: autopilotWorkerStatus });
      }

      if (request.method === 'POST' && url.pathname === '/api/agent/autopilot/worker/run') {
        return sendJson(response, await runAutopilotWorkerOnce());
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
        const action = state.actionRequests.find((candidate) => candidate.id === actionId);
        const runId = createRuntimeId('agent-action');
        let progressSequence = 0;
        const publishActionProgress = (
          event: Omit<AgentProgressEvent, 'id' | 'createdAt' | 'sequence' | 'runId' | 'agentId' | 'roomId'>
        ) => {
          if (!action) {
            return;
          }
          publish(
            eventClients,
            'agent-progress',
            createAgentProgressEvent({
              ...event,
              runId,
              agentId: action.agentId,
              roomId: action.roomId,
              sequence: progressSequence
            })
          );
          progressSequence += 1;
        };

        publishActionProgress({
          phase: 'started',
          label: decision === 'confirm' ? '收到确认请求' : '收到拒绝请求',
          detail: `${action?.kind ?? actionId}: ${body.reason || 'no reason provided'}`,
          toolCalls: [`agent_action.${decision}`],
          riskLevel: action?.risk?.level
        });
        publishActionProgress({
          phase: 'executing',
          label: '校验确认动作',
          detail: actionId,
          toolCalls: [`agent_action.${decision}`],
          riskLevel: action?.risk?.level
        });

        let resolved: Awaited<ReturnType<typeof resolveAgentActionReview>> | undefined;
        try {
          await updateStoredState(async (currentState) => {
            resolved = await resolveAgentActionReview(currentState, actionId, decision, body, matrixStore);
            return resolved.state;
          });
        } catch (error) {
          publishActionProgress({
            phase: 'failed',
            label: decision === 'confirm' ? '确认动作失败' : '拒绝动作失败',
            detail: error instanceof Error ? error.message : 'unknown action review error',
            toolCalls: [`agent_action.${decision}`],
            riskLevel: action?.risk?.level
          });
          throw error;
        }
        if (!resolved) {
          throw new Error('action review did not resolve');
        }

        publishActionProgress({
          phase: 'executing',
          label: actionReviewMutationLabel(resolved.action, decision),
          detail: actionReviewMutationDetail(resolved.action),
          toolCalls: actionReviewMutationToolCalls(resolved.action, resolved.log, decision),
          riskLevel: resolved.log.risk.level
        });
        publishActionProgress({
          phase: 'executing',
          label: '写入审计日志',
          detail: resolved.log.action,
          toolCalls: resolved.log.toolCalls,
          riskLevel: resolved.log.risk.level
        });
        await publishRuntimeState();
        publishActionProgress({
          phase: resolved.action.status === 'blocked' ? 'failed' : 'completed',
          label:
            resolved.action.status === 'blocked'
              ? '确认被阻止'
              : decision === 'confirm'
                ? '完成确认动作'
                : '完成拒绝动作',
          detail: resolved.log.risk.reason,
          toolCalls: resolved.log.toolCalls,
          riskLevel: resolved.log.risk.level
        });
        return sendJson(response, { action: resolved.action, log: resolved.log });
      }

      const fileDownloadMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/download$/);
      if (request.method === 'GET' && fileDownloadMatch) {
        const state = await db.read();
        const file = state.files.find((candidate) => candidate.id === decodeURIComponent(fileDownloadMatch[1]));
        if (!file) {
          return sendJson(response, { error: 'file not found' }, 404);
        }
        if (matrixStore && file.mxcUri) {
          const media = await matrixStore.downloadMedia(file.mxcUri, file.name);
          return sendBytes(response, media.bytes, {
            contentType: media.contentType || file.contentType || 'application/octet-stream',
            filename: file.name
          });
        }
        if (!file.localPath) {
          return sendJson(response, { error: 'media is not available for this file' }, 404);
        }

        const media = await readLocalMediaFile(mediaDir, file.localPath);
        return sendBytes(response, media.bytes, {
          contentType: file.contentType || 'application/octet-stream',
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
        let synced: Awaited<ReturnType<MatrixStore['syncStateOnce']>> | undefined;
        await updateStoredState(async (currentState) => {
          synced = await matrixStore.syncStateOnce(currentState);
          return mergePersistedRuntimeState(currentState, synced.state);
        });
        await publishRuntimeState();
        return sendJson(response, {
          messagesAdded: synced!.messagesAdded,
          checkpoints: synced!.state.matrixObserverCheckpoints
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
        const directCalendarAdd = addCalendarEventFromChatConfirmation(nextState, message);
        if (directCalendarAdd) {
          nextState = directCalendarAdd.state;
        }
        let autoReplies: Message[] = [];
        let autoReplyJobs: DemoState['aiReplyJobs'] = [];
        if (aiProvider) {
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
        } else {
          const skipped = recordSkippedAiAutoreplies({
            state: nextState,
            triggerMessage: message,
            reason: 'AI provider is not configured; no simulated human reply was generated.'
          });
          nextState = skipped.state;
          autoReplyJobs = skipped.jobs;
        }
        const autopilot = await runAgentAutopilotForMessage({
          state: matrixStore ? await matrixStore.hydrateState(nextState) : nextState,
          triggerMessage: message,
          aiProvider,
          webSearchProvider,
          sendMessage: sendAutopilotMessage
        });
        nextState = autopilot.state;
        await updateStoredState((baseState) => mergePersistedRuntimeState(baseState, nextState));
        await publishRuntimeState();
        return sendJson(response, {
          ...message,
          calendarEvents: directCalendarAdd?.events ?? [],
          autoReplies,
          autoReplyJobs,
          autopilotSessions: autopilot.sessions,
          autopilotMessages: autopilot.messages
        }, 201);
      }

      if (request.method === 'POST' && url.pathname === '/api/ai/human-reply') {
        if (!aiProvider) {
          throw new HttpError(503, 'AI provider is not configured');
        }
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
        await updateStoredState((baseState) => ({
          ...baseState,
          messages: appendMessage(baseState.messages, message),
          actionLogs: [log, ...baseState.actionLogs]
        }));
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
          const localPath = await writeLocalMediaFile(mediaDir, file.id, file.name, bytes);
          file = { ...file, localPath, size: bytes.byteLength };
          message = createFileUploadMessage(state, file);
        }

        const log = createFileUploadLog(baseState, file, message, Boolean(matrixStore));
        const chunks = extractTextChunks(file, bytes);

        const nextState = {
          ...baseState,
          files: [file, ...baseState.files],
          fileTextChunks: [...chunks, ...(baseState.fileTextChunks ?? [])],
          messages: appendMessage(baseState.messages, message),
          actionLogs: [log, ...baseState.actionLogs]
        };
        await updateStoredState((currentState) => mergePersistedRuntimeState(currentState, nextState));
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
          matrixStore,
          mediaDir
        });
        await updateStoredState((currentState) => mergePersistedRuntimeState(currentState, generated.state));
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
        await updateStoredState((baseState) => ({ ...baseState, actionLogs: [log, ...baseState.actionLogs] }));
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
        await updateStoredState((baseState) => ({ ...baseState, actionLogs: [log, ...baseState.actionLogs] }));
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
        await updateStoredState((baseState) => mergeRuntimeState(baseState, runtime.state, message));
        await publishRuntimeState();
        return sendJson(response, { result });
      }

      if (request.method === 'POST' && url.pathname === '/api/agent/run') {
        const body = await readJson<AgentRunRequest>(request);
        const runtimeState = await readRuntimeState();
        const runId = createRuntimeId('agent-run');
        let progressSequence = 0;
        const publishProgress = (event: Omit<AgentProgressEvent, 'id' | 'createdAt' | 'sequence'>) => {
          publish(eventClients, 'agent-progress', createAgentProgressEvent({ ...event, sequence: progressSequence }));
          progressSequence += 1;
        };
        publishProgress({
          runId,
          agentId: body.agentId,
          roomId: body.roomId,
          phase: 'started',
          label: '收到 Agent 请求',
          detail: body.userText,
          toolCalls: []
        });

        let runtime: Awaited<ReturnType<typeof runAgentIntent>>;
        try {
          runtime = await runAgentIntent(runtimeState, body, aiProvider, {
            runId,
            onProgress: publishProgress
          }, { webSearchProvider });
        } catch (error) {
          publishProgress({
            runId,
            agentId: body.agentId,
            roomId: body.roomId,
            phase: 'failed',
            label: 'Agent 执行失败',
            detail: error instanceof Error ? error.message : 'unknown Agent runtime error',
            toolCalls: []
          });
          throw error;
        }
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
        await updateStoredState((baseState) => mergeRuntimeState(baseState, runtime.state, message));
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
        let message = result.requiresHuman
          ? undefined
          : createAgentCoordinationMessage(state, body.toAgentId, result.proposedPlan);
        if (matrixStore && message) {
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
        await updateStoredState((baseState) => ({
          ...baseState,
          messages: appendMessage(baseState.messages, message),
          actionLogs: [result.log, ...baseState.actionLogs]
        }));
        await publishRuntimeState();
        return sendJson(response, { result, message });
      }

      sendJson(response, { error: 'not found' }, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        return sendJson(response, { error: error.message }, error.status);
      }
      const message = error instanceof Error ? error.message : 'unknown error';
      sendJson(response, { error: message }, statusForUnhandledError(message));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, host, resolve);
  });

  if (autopilotWorkerConfig.enabled) {
    autopilotWorkerTimer = setInterval(() => {
      void runAutopilotWorkerOnce();
    }, autopilotWorkerConfig.intervalMs);
    autopilotWorkerTimer.unref?.();
    if (autopilotWorkerConfig.runOnStart) {
      void runAutopilotWorkerOnce();
    }
  }

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    url: `http://${host}:${port}`,
    close: async () => {
      if (autopilotWorkerTimer) {
        clearInterval(autopilotWorkerTimer);
      }
      if (activeAutopilotWorkerRun) {
        await activeAutopilotWorkerRun.catch(() => undefined);
      }
      await closeServer(server);
    }
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

function normalizeAutopilotWorkerOptions(options: AutopilotWorkerOptions | undefined): AutopilotWorkerConfig {
  const enabled = options?.enabled ?? false;
  return {
    enabled,
    intervalMs: normalizePositiveInteger(
      options?.intervalMs,
      defaultAutopilotWorkerIntervalMs,
      5_000,
      15 * 60_000
    ),
    roomIds: uniqueStrings(options?.roomIds ?? []),
    limit: normalizePositiveInteger(options?.limit, 20, 1, 50),
    runOnStart: options?.runOnStart ?? false
  };
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(Math.trunc(value as number), maximum));
}

function selectAutopilotWorkerRoomIds(state: DemoState): string[] {
  const allowedRoomIds = new Set(
    (state.agentAutopilotPolicies ?? [])
      .filter((policy) => policy.enabled)
      .flatMap((policy) => policy.allowedRoomIds)
  );
  return state.rooms.filter((room) => allowedRoomIds.has(room.id)).map((room) => room.id);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
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
      ...(usedMatrix ? ['matrix.media.upload', 'matrix.send_event'] : ['local.media.write', 'local.message.create'])
    ]
  });
}

async function generateDemoAssetsForRoom(
  baseState: DemoState,
  runtimeState: DemoState,
  input: { roomId: string; senderId: string; matrixStore: MatrixStore | null; mediaDir: string }
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
      const localPath = await writeLocalMediaFile(input.mediaDir, file.id, file.name, asset.bytes);
      file = { ...file, localPath, size: asset.bytes.byteLength };
      message = createFileUploadMessage(runtimeState, file);
    }

    const log = createFileUploadLog(nextState, file, message, Boolean(input.matrixStore));
    const chunks = extractTextChunks(file, asset.bytes);
    files.push(file);
    if (message) {
      messages.push(message);
    }
    nextState = {
      ...nextState,
      files: [file, ...nextState.files],
      fileTextChunks: [...chunks, ...(nextState.fileTextChunks ?? [])],
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
  const merged = mergePersistedRuntimeState(baseState, runtimeState);
  return {
    ...merged,
    messages: appendMessage(baseState.messages, message),
  };
}

function mergePersistedRuntimeState(baseState: DemoState, runtimeState: DemoState): DemoState {
  return {
    ...baseState,
    messages: mergeMessages(runtimeState.messages, baseState.messages),
    files: mergeUpdatedItems(runtimeState.files, baseState.files),
    fileTextChunks: mergeByKey(runtimeState.fileTextChunks, baseState.fileTextChunks, (chunk) => chunk.id),
    calendar: mergeByKey(runtimeState.calendar, baseState.calendar, (item) => item.id),
    actionLogs: mergeByKey(runtimeState.actionLogs, baseState.actionLogs, (log) => log.id),
    actionRequests: mergeActionRequests(runtimeState.actionRequests, baseState.actionRequests),
    a2aSessions: mergeUpdatedItems(runtimeState.a2aSessions, baseState.a2aSessions),
    memories: mergeByKey(runtimeState.memories, baseState.memories, (memory) => memory.id),
    matrixObserverCheckpoints: mergeByKey(
      runtimeState.matrixObserverCheckpoints,
      baseState.matrixObserverCheckpoints,
      (checkpoint) => checkpoint.roomId
    ),
    aiReplyJobs: mergeUpdatedItems(runtimeState.aiReplyJobs, baseState.aiReplyJobs)
  };
}

function mergeMessages(preferred: Message[], existing: Message[]): Message[] {
  return sortMessagesChronologically(mergeByKey(preferred, existing, (message) => message.id));
}

function mergeByKey<T>(preferred: T[], existing: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of [...preferred, ...existing]) {
    const key = keyFor(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function mergeUpdatedItems<T extends { id: string; updatedAt: string }>(preferred: T[], existing: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of [...existing, ...preferred]) {
    const current = byId.get(item.id);
    if (!current || item.updatedAt >= current.updatedAt) {
      byId.set(item.id, item);
    }
  }
  const order = mergeByKey(preferred, existing, (item) => item.id).map((item) => item.id);
  return order.map((id) => byId.get(id)).filter(Boolean) as T[];
}

function mergeActionRequests(
  preferred: AgentActionRequest[],
  existing: AgentActionRequest[]
): AgentActionRequest[] {
  const byId = new Map<string, AgentActionRequest>();
  for (const request of [...existing, ...preferred]) {
    const current = byId.get(request.id);
    if (!current || request.updatedAt >= current.updatedAt) {
      byId.set(request.id, request);
    }
  }
  const order = mergeByKey(preferred, existing, (request) => request.id).map((request) => request.id);
  return order.map((id) => byId.get(id)).filter(Boolean) as AgentActionRequest[];
}

function appendMessage(messages: Message[], message: Message | undefined): Message[] {
  if (!message) {
    return messages;
  }
  return sortMessagesChronologically([...messages.filter((candidate) => candidate.id !== message.id), message]);
}

async function writeLocalMediaFile(
  mediaDir: string,
  fileId: string,
  filename: string,
  bytes: Uint8Array
): Promise<string> {
  await mkdir(mediaDir, { recursive: true });
  const relativePath = `${safePathSegment(fileId)}-${safePathSegment(filename)}`;
  const targetPath = resolveMediaPath(mediaDir, relativePath);
  await writeFile(targetPath, bytes);
  return relativePath;
}

async function readLocalMediaFile(mediaDir: string, localPath: string): Promise<{ bytes: Uint8Array }> {
  const targetPath = resolveMediaPath(mediaDir, localPath);
  return { bytes: await readFile(targetPath) };
}

function resolveMediaPath(mediaDir: string, relativePath: string): string {
  const root = resolve(mediaDir);
  const target = resolve(root, basename(relativePath));
  if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
    throw new HttpError(400, 'invalid media path');
  }
  return target;
}

function safePathSegment(value: string): string {
  return basename(value)
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'file';
}

function createAiRuntimeStatus(aiProvider: AiProvider | undefined, probe?: Partial<AiRuntimeStatus>): AiRuntimeStatus {
  if (!aiProvider) {
    return {
      configured: false,
      provider: 'fallback',
      health: 'missing'
    };
  }

  const cache = createAiRuntimeCacheStatus(aiProvider);
  return {
    configured: true,
    provider: 'deepseek',
    health: probe?.health ?? (cache && cache.requestCount > 0 ? 'connected' : 'unknown'),
    agentModel: process.env.DEEPSEEK_AGENT_MODEL?.trim() || 'deepseek-v4-pro',
    humanModel: process.env.DEEPSEEK_HUMAN_MODEL?.trim() || 'deepseek-v4-flash',
    baseUrlHost: hostFromUrl(process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'),
    cache,
    lastCheckedAt: probe?.lastCheckedAt,
    lastError: probe?.lastError,
    lastLatencyMs: probe?.lastLatencyMs
  };
}

function createAiRuntimeCacheStatus(aiProvider: AiProvider | undefined): AiRuntimeStatus['cache'] {
  const usage = getAiUsageSnapshot(aiProvider);
  if (!usage) {
    return undefined;
  }
  return {
    requestCount: usage.requestCount,
    promptCacheHitTokens: usage.promptCacheHitTokens,
    promptCacheMissTokens: usage.promptCacheMissTokens,
    promptCacheHitRate: usage.promptCacheHitRate,
    lastUpdatedAt: usage.lastUpdatedAt,
    routes: usage.routes?.map((route) => ({
      role: route.role,
      provider: route.provider,
      requestCount: route.requestCount,
      promptCacheHitTokens: route.promptCacheHitTokens,
      promptCacheMissTokens: route.promptCacheMissTokens,
      promptCacheHitRate: route.promptCacheHitRate,
      lastUpdatedAt: route.lastUpdatedAt
    }))
  };
}

async function checkAiRuntimeHealth(aiProvider: AiProvider | undefined): Promise<Partial<AiRuntimeStatus>> {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  if (!aiProvider) {
    return {
      health: 'missing',
      lastCheckedAt: checkedAt,
      lastLatencyMs: 0
    };
  }

  try {
    await aiProvider.generateText({
      actorRole: 'human_user',
      actorId: 'health-check-human',
      instructions: 'You are checking whether the human-simulation model is reachable. Reply only ok.',
      input: 'Reply ok.',
      maxOutputTokens: 8
    });
    await aiProvider.generateText({
      actorRole: 'personal_agent',
      actorId: 'health-check-agent',
      instructions: 'You are checking whether the personal-agent model is reachable. Reply only ok.',
      input: 'Reply ok.',
      maxOutputTokens: 8
    });
    return {
      health: 'connected',
      lastCheckedAt: checkedAt,
      lastLatencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      health: 'failed',
      lastCheckedAt: checkedAt,
      lastLatencyMs: Date.now() - startedAt,
      lastError: error instanceof Error ? error.message : 'unknown AI provider error'
    };
  }
}

function hostFromUrl(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function normalizeMatrixBootstrapPath(value: string | undefined): string | null {
  if (value !== undefined) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === 'none' || normalized === 'false' || normalized === 'off' || normalized === 'local') {
      return null;
    }
    return value;
  }
  return 'data/matrix-bootstrap.json';
}

function updateAutopilotPolicy(
  state: DemoState,
  input: AutopilotPolicyPatchInput
): { state: DemoState; policy: AgentAutopilotPolicy } {
  if (!input.agentId) {
    throw new HttpError(400, 'agentId is required');
  }
  const agent = state.agents.find((candidate) => candidate.id === input.agentId);
  if (!agent) {
    throw new HttpError(400, `unknown agent: ${input.agentId}`);
  }
  if (input.roomId && !agent.allowedRoomIds.includes(input.roomId)) {
    throw new HttpError(403, `${agent.displayName} cannot be delegated in ${input.roomId}`);
  }

  const existing = state.agentAutopilotPolicies.find((policy) => policy.agentId === input.agentId);
  const base: AgentAutopilotPolicy = existing ?? {
    agentId: input.agentId,
    enabled: false,
    allowedRoomIds: [],
    autoExecuteMaxRisk: 'low',
    allowedActions: ['reply', 'search_files'],
    updatedAt: new Date().toISOString()
  };

  let allowedRoomIds = base.allowedRoomIds;
  if (input.roomId) {
    allowedRoomIds = input.roomEnabled === false
      ? allowedRoomIds.filter((roomId) => roomId !== input.roomId)
      : uniqueStringList([...allowedRoomIds, input.roomId]);
  }

  const policy: AgentAutopilotPolicy = {
    ...base,
    enabled: input.enabled ?? (input.roomEnabled === false && allowedRoomIds.length === 0 ? false : base.enabled),
    allowedRoomIds,
    allowedActions: input.allowedActions ? normalizeAutopilotActions(input.allowedActions) : base.allowedActions,
    autoExecuteMaxRisk: input.autoExecuteMaxRisk ?? base.autoExecuteMaxRisk,
    updatedAt: new Date().toISOString()
  };

  return {
    state: {
      ...state,
      agentAutopilotPolicies: [
        policy,
        ...state.agentAutopilotPolicies.filter((candidate) => candidate.agentId !== input.agentId)
      ]
    },
    policy
  };
}

function normalizeAutopilotActions(actions: AgentAutopilotAction[]): AgentAutopilotAction[] {
  const allowed = new Set<AgentAutopilotAction>([
    'reply',
    'search_files',
    'share_low_risk_files',
    'suggest_task_updates',
    'coordinate_schedule',
    'a2a_negotiate'
  ]);
  return uniqueStringList(actions.filter((action) => allowed.has(action))) as AgentAutopilotAction[];
}

function uniqueStringList(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
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
  if (action.status !== 'needs_confirmation' || !action.requiresHuman) {
    throw new HttpError(409, `action request ${action.id} is not awaiting human confirmation`);
  }
  assertReviewerCanReviewAction(state, action, input.reviewerId);

  let nextState = state;
  let blockedRisk: AgentActionLog['risk'] | undefined;
  if (decision === 'confirm') {
    const executed = await executeConfirmedAgentAction(nextState, action, matrixStore);
    nextState = executed.state;
    blockedRisk = executed.blockedRisk;
  }

  const log = createRuntimeLog({
    agentId: action.agentId,
    roomId: action.roomId,
    action: `${decision}_action:${action.id}`,
    status: decision === 'confirm' && !blockedRisk ? 'executed' : 'blocked',
    risk: blockedRisk ?? {
      level: decision === 'confirm' ? 'low' : 'medium',
      score: decision === 'confirm' ? 0.2 : 0.64,
      reason: `Human review by ${input.reviewerId}: ${input.reason || 'no reason provided'}`,
      model: 'human-review-v1'
    },
    contextIds: [action.id, input.reviewerId],
    toolCalls: [`agent_action.${decision}`, ...confirmedActionToolCalls(action.kind, blockedRisk)]
  });
  nextState = {
    ...nextState,
    actionLogs: [log, ...nextState.actionLogs]
  };

  const resolved =
    decision === 'confirm' && !blockedRisk
      ? completeAgentAction(nextState, action.id, {
          logId: log.id,
          risk: log.risk,
          updatedAt: log.createdAt
        })
      : decision === 'confirm'
        ? blockAgentAction(nextState, action.id, {
            logId: log.id,
            risk: log.risk,
            updatedAt: log.createdAt
          })
      : rejectAgentAction(nextState, action.id, {
          logId: log.id,
          risk: log.risk,
          updatedAt: log.createdAt
        });
  const resolvedState = updateLinkedA2ASessions(resolved.state, action.id, resolved.request.status, log.createdAt);

  return {
    state: resolvedState,
    action: resolved.request,
    log
  };
}

async function executeConfirmedAgentAction(
  state: DemoState,
  action: AgentActionRequest,
  matrixStore: MatrixStore | null
): Promise<{ state: DemoState; blockedRisk?: AgentActionLog['risk'] }> {
  if (action.kind === 'coordinate') {
    const patch = parseCalendarPatch(action.input.calendarPatch);
    if (!patch) {
      return { state, blockedRisk: missingPatchRisk('coordinate', 'calendarPatch') };
    }
    const current = state.calendar.find((item) => item.id === patch.itemId);
    if (!current || current.startsAt !== patch.oldStartsAt) {
      return { state, blockedRisk: stalePatchRisk('coordinate calendar patch') };
    }
    return {
      state: {
        ...state,
        calendar: state.calendar.map((item) =>
          item.id === patch.itemId ? { ...item, startsAt: patch.newStartsAt } : item
        )
      }
    };
  }

  if (action.kind === 'task_update_suggest') {
    const patch = parseTaskPatch(action.input.taskPatch);
    if (!patch) {
      return { state, blockedRisk: missingPatchRisk('task_update_suggest', 'taskPatch') };
    }
    const current = state.tasks.find((task) => task.id === patch.taskId);
    if (!current || current.status !== patch.oldStatus) {
      return { state, blockedRisk: stalePatchRisk('task status patch') };
    }
    return {
      state: {
        ...state,
        tasks: state.tasks.map((task) =>
          task.id === patch.taskId ? { ...task, status: patch.newStatus } : task
        )
      }
    };
  }

  if (action.kind !== 'share_file') {
    return { state };
  }

  const boundFile = getConfirmedFileBinding(state, action);
  if (!boundFile.file) {
    return { state, blockedRisk: boundFile.risk };
  }

  let message = createConfirmedFileShareMessage(state, action, boundFile.file);
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
        fileName: boundFile.file.name,
        mxcUri: boundFile.file.mxcUri,
        mimeType: boundFile.file.contentType,
        size: boundFile.file.size
      }
    );
  }

  return {
    state: {
      ...state,
      messages: appendMessage(state.messages, message)
    }
  };
}

function assertReviewerCanReviewAction(state: DemoState, action: AgentActionRequest, reviewerId: string): void {
  const reviewer = state.users.find((user) => user.id === reviewerId);
  if (!reviewer) {
    throw new HttpError(403, `reviewer ${reviewerId} cannot review action ${action.id}`);
  }
  const room = state.rooms.find((candidate) => candidate.id === action.roomId);
  if (!room) {
    throw new HttpError(400, `unknown room: ${action.roomId}`);
  }
  if (!room.memberIds.includes(reviewer.id)) {
    throw new HttpError(403, `reviewer ${reviewerId} cannot review actions in ${action.roomId}`);
  }
}

function updateLinkedA2ASessions(
  state: DemoState,
  actionId: string,
  actionStatus: AgentActionRequest['status'],
  updatedAt: string
): DemoState {
  const sessionStatus: DemoState['a2aSessions'][number]['status'] =
    actionStatus === 'executed' ? 'completed' : 'blocked';
  let changed = false;
  const a2aSessions = (state.a2aSessions ?? []).map((session) => {
    if (!session.proposedActionRequestIds.includes(actionId)) {
      return session;
    }
    changed = true;
    return {
      ...session,
      status: sessionStatus,
      updatedAt
    };
  });

  return changed
    ? {
        ...state,
        a2aSessions
      }
    : state;
}

function getConfirmedFileBinding(
  state: DemoState,
  action: AgentActionRequest
): { file?: FileItem; risk?: AgentActionLog['risk'] } {
  const fileId = typeof action.input.fileId === 'string' ? action.input.fileId : undefined;
  const fileVersion = typeof action.input.fileVersion === 'number' ? action.input.fileVersion : undefined;
  if (!fileId || fileVersion === undefined) {
    return { risk: fileShareBoundaryRisk('missing a downloadable file binding') };
  }

  const file = state.files.find((candidate) => candidate.id === fileId);
  if (!file || file.version !== fileVersion || !hasDownloadableBacking(file)) {
    return { risk: fileShareBoundaryRisk('the bound file id/version is no longer downloadable') };
  }
  if (file.roomId !== action.roomId || !file.agentCanShare || file.visibility !== 'room') {
    return { risk: fileShareBoundaryRisk('the bound file is no longer authorized for room sharing') };
  }

  return { file };
}

function createConfirmedFileShareMessage(state: DemoState, action: AgentActionRequest, file: FileItem): Message {
  const agent = state.agents.find((candidate) => candidate.id === action.agentId);
  const owner = state.users.find((candidate) => candidate.id === agent?.ownerId);
  if (!agent || !owner) {
    throw new Error(`unknown agent: ${action.agentId}`);
  }

  return {
    id: `msg-agent-share-${file.id}`,
    roomId: action.roomId,
    senderId: agent.ownerId,
    senderName: agent.displayName,
    body: `我代表${owner.name}发送最新文件：${file.name}`,
    sentAt: '2026-05-04T14:06:12+08:00',
    type: 'file',
    agentLabel: `${owner.name}的 Agent 代发`,
    sourceAgentId: agent.id,
    fileId: file.id,
    mxcUri: file.mxcUri,
    contentType: file.contentType,
    size: file.size
  };
}

function hasDownloadableBacking(file: FileItem | undefined): boolean {
  return Boolean(file?.mxcUri || file?.localPath);
}

function confirmedActionToolCalls(kind: AgentActionRequest['kind'], blockedRisk?: AgentActionLog['risk']): string[] {
  if (blockedRisk) {
    return ['agent_action.blocked'];
  }
  if (kind === 'coordinate') {
    return ['calendar.update'];
  }
  if (kind === 'task_update_suggest') {
    return ['task.update'];
  }
  if (kind === 'share_file') {
    return ['file.share'];
  }
  return [];
}

function actionReviewMutationLabel(
  action: AgentActionRequest,
  decision: 'confirm' | 'reject'
): string {
  if (decision === 'reject') {
    return '记录拒绝决定';
  }
  if (action.status === 'blocked') {
    if (action.kind === 'coordinate') {
      return '日程变更被阻止';
    }
    if (action.kind === 'task_update_suggest') {
      return '任务更新被阻止';
    }
    if (action.kind === 'share_file') {
      return '文件代发被阻止';
    }
    return '确认动作被阻止';
  }
  if (action.kind === 'coordinate') {
    return '应用日程变更';
  }
  if (action.kind === 'task_update_suggest') {
    return '更新任务状态';
  }
  if (action.kind === 'share_file') {
    return '执行文件代发';
  }
  return '执行确认动作';
}

function actionReviewMutationDetail(action: AgentActionRequest): string | undefined {
  if (action.kind === 'coordinate') {
    const patch = parseCalendarPatch(action.input.calendarPatch);
    return patch ? `${patch.title ?? patch.itemId}: ${patch.oldStartsAt} -> ${patch.newStartsAt}` : undefined;
  }
  if (action.kind === 'task_update_suggest') {
    const patch = parseTaskPatch(action.input.taskPatch);
    return patch ? `${patch.taskId}: ${patch.oldStatus} -> ${patch.newStatus}` : undefined;
  }
  if (action.kind === 'share_file') {
    const fileName = action.input.fileName ?? action.input.requestText;
    return typeof fileName === 'string' ? fileName : undefined;
  }
  return undefined;
}

function actionReviewMutationToolCalls(
  action: AgentActionRequest,
  log: AgentActionLog,
  decision: 'confirm' | 'reject'
): string[] {
  if (decision === 'reject') {
    return ['agent_action.reject'];
  }
  if (action.status === 'blocked') {
    return ['agent_action.blocked'];
  }
  return confirmedActionToolCalls(action.kind).length > 0 ? confirmedActionToolCalls(action.kind) : log.toolCalls;
}

function parseCalendarPatch(value: unknown):
  | { itemId: string; oldStartsAt: string; newStartsAt: string; title?: string }
  | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const patch = value as Record<string, unknown>;
  if (
    typeof patch.itemId !== 'string' ||
    typeof patch.oldStartsAt !== 'string' ||
    typeof patch.newStartsAt !== 'string'
  ) {
    return undefined;
  }
  return {
    itemId: patch.itemId,
    oldStartsAt: patch.oldStartsAt,
    newStartsAt: patch.newStartsAt,
    title: typeof patch.title === 'string' ? patch.title : undefined
  };
}

function parseTaskPatch(value: unknown):
  | { taskId: string; oldStatus: DemoState['tasks'][number]['status']; newStatus: DemoState['tasks'][number]['status'] }
  | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const patch = value as Record<string, unknown>;
  if (
    typeof patch.taskId !== 'string' ||
    !isTaskStatus(patch.oldStatus) ||
    !isTaskStatus(patch.newStatus)
  ) {
    return undefined;
  }
  return {
    taskId: patch.taskId,
    oldStatus: patch.oldStatus,
    newStatus: patch.newStatus
  };
}

function isTaskStatus(value: unknown): value is DemoState['tasks'][number]['status'] {
  return value === 'pending' || value === 'in_progress' || value === 'done';
}

function missingPatchRisk(kind: string, patchName: string): AgentActionLog['risk'] {
  return {
    level: 'high',
    score: 0.91,
    reason: `Cannot confirm ${kind}: missing explicit ${patchName}; no internal data was changed.`,
    model: 'runtime-confirmation-gate-v1'
  };
}

function stalePatchRisk(label: string): AgentActionLog['risk'] {
  return {
    level: 'high',
    score: 0.88,
    reason: `Cannot confirm ${label}: current state no longer matches the queued patch; no internal data was changed.`,
    model: 'runtime-confirmation-gate-v1'
  };
}

function fileShareBoundaryRisk(reason: string): AgentActionLog['risk'] {
  return {
    level: 'high',
    score: 0.9,
    reason: `Cannot confirm file share: ${reason}; no file message was sent.`,
    model: 'runtime-confirmation-gate-v1'
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

function statusForUnhandledError(message: string): number {
  if (message.includes('cannot read')) {
    return 403;
  }
  if (message.startsWith('unknown agent') || message.startsWith('unknown user') || message.startsWith('unknown room')) {
    return 400;
  }
  return 500;
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

function authorizeRequest(request: IncomingMessage, url: URL, apiToken: string | null | undefined): boolean {
  if (!apiToken || request.method === 'OPTIONS') {
    return true;
  }

  const token =
    getHeaderValue(request.headers['x-agent-im-token']) ??
    parseBearerToken(request) ??
    url.searchParams.get('agent_im_token') ??
    undefined;
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
    'image/svg+xml',
    'text/markdown',
    'text/plain'
  ]),
  allowedExtensions: new Set(['.docx', '.jpeg', '.jpg', '.json', '.md', '.pdf', '.png', '.pptx', '.svg', '.txt', '.xlsx'])
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

function addCalendarEventFromChatConfirmation(
  state: DemoState,
  message: Message
): { state: DemoState; events: DemoState['calendar'] } | undefined {
  if (!looksLikeCalendarAddConfirmation(message.body)) {
    return undefined;
  }
  const room = state.rooms.find((candidate) => candidate.id === message.roomId);
  const sender = state.users.find((candidate) => candidate.id === message.senderId);
  if (!room || !sender) {
    return undefined;
  }

  const recentMessages = sortMessagesChronologically(
    state.messages
      .filter((candidate) => candidate.roomId === message.roomId && candidate.id !== message.id)
      .slice(-10)
  );
  const startsAt = inferCalendarStartFromChat([...recentMessages, message], message.sentAt);
  if (!startsAt) {
    return undefined;
  }

  const attendees = inferCalendarAttendees(state, room.memberIds, sender.id, [...recentMessages, message]);
  const event: DemoState['calendar'][number] = {
    id: createRuntimeId('cal-chat'),
    title: inferCalendarTitleFromChat([...recentMessages, message]),
    startsAt,
    roomId: room.id,
    attendees,
    sourceTaskId: message.id
  };
  const log = createRuntimeLog({
    agentId: sender.agentId,
    roomId: room.id,
    action: `calendar_add_from_chat:${event.title}`,
    status: 'executed',
    risk: {
      level: 'low',
      score: 0.16,
      reason: 'The sender explicitly confirmed adding the recently discussed schedule to the internal calendar.',
      model: 'chat-calendar-confirmation-v1'
    },
    contextIds: [message.id, ...recentMessages.slice(-4).map((candidate) => candidate.id), event.id],
    toolCalls: ['calendar.add_from_chat', 'calendar.availability.inspect']
  });

  return {
    state: {
      ...state,
      calendar: [event, ...state.calendar],
      actionLogs: [log, ...state.actionLogs]
    },
    events: [event]
  };
}

function looksLikeCalendarAddConfirmation(text: string): boolean {
  const lowered = text.toLowerCase();
  return (
    /加入日程|加到日程|添加日程|加进日程|记到日程|写进日程|放进日程|加入到日程|加日历|加入日历/.test(text) ||
    (/(记一下|记下来|安排上|就这么定|就这样定)/.test(text) && /日程|日历|时间|周|星期|晚上|下午|上午/.test(text)) ||
    lowered.includes('add to calendar') ||
    lowered.includes('put it on the calendar')
  );
}

function inferCalendarStartFromChat(messages: Message[], fallbackSentAt: string): string | undefined {
  const base = new Date(fallbackSentAt);
  const fallbackBase = Number.isNaN(base.getTime()) ? new Date() : base;
  for (const message of [...messages].reverse()) {
    const startsAt = inferCalendarStartFromText(message.body, fallbackBase);
    if (startsAt) {
      return startsAt;
    }
  }
  return undefined;
}

function inferCalendarStartFromText(text: string, baseDate: Date): string | undefined {
  const explicitDate = text.match(/(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  const weekday = inferCalendarWeekday(text);
  const time = inferCalendarTime(text);
  if (!explicitDate && weekday === undefined) {
    return undefined;
  }

  const target = explicitDate
    ? new Date(Date.UTC(Number(explicitDate[1] ?? baseDate.getFullYear()), Number(explicitDate[2]) - 1, Number(explicitDate[3]), 12))
    : nextWeekdayDate(baseDate, weekday!, time);
  const month = String(target.getUTCMonth() + 1).padStart(2, '0');
  const day = String(target.getUTCDate()).padStart(2, '0');
  return `${target.getUTCFullYear()}-${month}-${day}T${time.hour}:${time.minute}:00+08:00`;
}

function inferCalendarTime(text: string): { hour: string; minute: string } {
  const numeric = text.match(/(\d{1,2})\s*[:：点]\s*(\d{0,2})/);
  if (numeric) {
    return {
      hour: String(Number(numeric[1])).padStart(2, '0'),
      minute: (numeric[2] || '00').padEnd(2, '0').slice(0, 2)
    };
  }
  if (/晚上|晚间|夜里/.test(text)) {
    return { hour: '20', minute: '30' };
  }
  if (/下午/.test(text)) {
    return { hour: '15', minute: '00' };
  }
  if (/上午|早上/.test(text)) {
    return { hour: '10', minute: '00' };
  }
  if (/中午/.test(text)) {
    return { hour: '12', minute: '00' };
  }
  return { hour: '09', minute: '00' };
}

function inferCalendarWeekday(text: string): number | undefined {
  const aliases: Array<[number, RegExp]> = [
    [1, /周一|星期一|monday/i],
    [2, /周二|星期二|tuesday/i],
    [3, /周三|星期三|wednesday/i],
    [4, /周四|星期四|thursday/i],
    [5, /周五|星期五|friday/i],
    [6, /周六|星期六|saturday/i],
    [0, /周日|周天|星期日|星期天|sunday/i]
  ];
  return aliases.find(([, pattern]) => pattern.test(text))?.[0];
}

function nextWeekdayDate(baseDate: Date, weekday: number, time: { hour: string; minute: string }): Date {
  const currentWeekday = baseDate.getDay();
  let deltaDays = (weekday - currentWeekday + 7) % 7;
  const targetMinutes = Number(time.hour) * 60 + Number(time.minute);
  const baseMinutes = baseDate.getHours() * 60 + baseDate.getMinutes();
  if (deltaDays === 0 && targetMinutes <= baseMinutes) {
    deltaDays = 7;
  }
  return new Date(Date.UTC(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + deltaDays, 12));
}

function inferCalendarAttendees(
  state: DemoState,
  roomMemberIds: string[],
  senderId: string,
  messages: Message[]
): string[] {
  const text = messages.map((message) => `${message.senderName} ${message.body}`).join('\n');
  if (/大家|全员|所有人|全组/.test(text)) {
    return [...roomMemberIds];
  }
  const attendees = new Set<string>([senderId]);
  for (const message of messages) {
    if (roomMemberIds.includes(message.senderId)) {
      attendees.add(message.senderId);
    }
  }
  for (const user of state.users) {
    if (roomMemberIds.includes(user.id) && text.includes(user.name)) {
      attendees.add(user.id);
    }
  }
  return [...attendees];
}

function inferCalendarTitleFromChat(messages: Message[]): string {
  const text = messages.map((message) => message.body).join('\n');
  if (/合稿|检查/.test(text)) {
    return '合稿检查';
  }
  if (/访谈/.test(text)) {
    return '访谈材料同步';
  }
  if (/答疑|课程/.test(text)) {
    return '课程答疑';
  }
  return '协作日程';
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
    id: createRuntimeId('log'),
    createdAt: new Date().toISOString(),
    ...input
  };
}

function createAgentProgressEvent(input: Omit<AgentProgressEvent, 'id' | 'createdAt'>): AgentProgressEvent {
  return {
    id: createRuntimeId('progress'),
    createdAt: new Date().toISOString(),
    ...input
  };
}

function createRuntimeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
