import type {
  AgentActionLog,
  AgentActionRequest,
  AgentAutopilotPolicy,
  AgentRunRequest,
  AgentRunResult,
  AiRuntimeStatus,
  CoordinationResult,
  DeadlineAnswer,
  DemoState,
  FileItem,
  MemoryItem,
  FileShareAction,
  Message,
  RoomSummary
} from '../domain/types';

type Fetcher = typeof fetch;
export const eventStreamReconnectDelayMs = 1_000;

export interface SendMessageInput {
  roomId: string;
  senderId: string;
  body: string;
}

export interface UploadFileInput {
  roomId: string;
  senderId: string;
  file: File;
  agentCanShare: boolean;
}

export interface DeadlineInput {
  agentId: string;
  roomId: string;
  question: string;
}

export interface ShareFileInput {
  agentId: string;
  roomId: string;
  requesterId: string;
  requestText: string;
}

export interface CoordinateInput {
  fromAgentId: string;
  toAgentId: string;
  roomId: string;
  proposal: string;
}

export interface SummaryInput {
  agentId: string;
  roomId: string;
}

export interface ReviewAgentActionInput {
  actionId: string;
  reviewerId: string;
  reason: string;
}

export interface HumanReplyInput {
  roomId: string;
  userId: string;
  prompt?: string;
}

export interface GenerateDemoAssetsInput {
  roomId: string;
  senderId: string;
}

export interface UpdateAutopilotPolicyInput {
  agentId: string;
  enabled?: boolean;
  roomId?: string;
  roomEnabled?: boolean;
  allowedActions?: AgentAutopilotPolicy['allowedActions'];
  autoExecuteMaxRisk?: AgentAutopilotPolicy['autoExecuteMaxRisk'];
}

export interface RunPendingAutopilotInput {
  roomId?: string;
  limit?: number;
}

export interface RunPendingAutopilotResponse {
  processedMessageIds: string[];
  skippedMessageIds: string[];
  processedTaskIds?: string[];
  skippedTaskIds?: string[];
  sessions: DemoState['a2aSessions'];
  messages: Message[];
  logs: AgentActionLog[];
  actionRequests?: DemoState['actionRequests'];
}

export interface AutopilotWorkerStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  roomIds: string[];
  limit: number;
  runCount: number;
  lastProcessedCount: number;
  lastSkippedCount: number;
  lastProcessedTaskCount?: number;
  lastSkippedTaskCount?: number;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastError?: string;
}

export interface AutopilotWorkerRunResponse extends RunPendingAutopilotResponse {
  worker: AutopilotWorkerStatus;
  skippedReason?: 'disabled' | 'already_running';
}

export interface DownloadedFile {
  blob: Blob;
  filename: string;
  contentType: string;
}

export interface StateStreamMessageEvent {
  type: string;
  data: string;
}

export interface StateEventStream {
  ready: Promise<void>;
  addEventListener(type: string, listener: (event: StateStreamMessageEvent) => void): void;
  removeEventListener(type: string, listener: (event: StateStreamMessageEvent) => void): void;
  close(): void;
}

export function fetchState(baseUrl = '', fetcher: Fetcher = fetch): Promise<DemoState> {
  return requestJson<DemoState>(fetcher, endpoint(baseUrl, '/api/state'));
}

export function sendMessage(baseUrl: string, input: SendMessageInput, fetcher: Fetcher = fetch): Promise<Message> {
  return requestJson<Message>(fetcher, endpoint(baseUrl, '/api/messages'), post(input));
}

export function humanReply(
  baseUrl: string,
  input: HumanReplyInput,
  fetcher: Fetcher = fetch
): Promise<{ message: Message; log: AgentActionLog }> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/ai/human-reply'), post(input));
}

export function uploadFile(baseUrl: string, input: UploadFileInput, fetcher: Fetcher = fetch): Promise<FileItem> {
  const query = new URLSearchParams({
    roomId: input.roomId,
    senderId: input.senderId,
    agentCanShare: String(input.agentCanShare)
  });
  return requestJson<FileItem>(fetcher, endpoint(baseUrl, `/api/files/upload?${query.toString()}`), {
    method: 'POST',
    headers: withApiToken({
      'content-type': input.file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(input.file.name)
    }),
    body: input.file
  });
}

export async function downloadFile(
  baseUrl: string,
  fileId: string,
  fetcher: Fetcher = fetch
): Promise<DownloadedFile> {
  const response = await fetcher(endpoint(baseUrl, `/api/files/${encodeURIComponent(fileId)}/download`), {
    method: 'GET',
    headers: withApiToken({})
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const blob = await response.blob();
  return {
    blob,
    filename: parseDownloadFilename(response.headers.get('content-disposition')) ?? `${fileId}.bin`,
    contentType: response.headers.get('content-type') ?? 'application/octet-stream'
  };
}

export function summarize(
  baseUrl: string,
  input: SummaryInput,
  fetcher: Fetcher = fetch
): Promise<{ result: RoomSummary }> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/agent/summary'), post(input));
}

export function askDeadline(
  baseUrl: string,
  input: DeadlineInput,
  fetcher: Fetcher = fetch
): Promise<{ result: DeadlineAnswer }> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/agent/deadline'), post(input));
}

export function shareFile(
  baseUrl: string,
  input: ShareFileInput,
  fetcher: Fetcher = fetch
): Promise<{ result: FileShareAction }> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/agent/share-file'), post(input));
}

export function coordinate(
  baseUrl: string,
  input: CoordinateInput,
  fetcher: Fetcher = fetch
): Promise<{ result: CoordinationResult }> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/agent/coordinate'), post(input));
}

export function runAgent(
  baseUrl: string,
  input: AgentRunRequest,
  fetcher: Fetcher = fetch
): Promise<AgentRunResult> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/agent/run'), post(input));
}

export function updateAutopilotPolicy(
  baseUrl: string,
  input: UpdateAutopilotPolicyInput,
  fetcher: Fetcher = fetch
): Promise<{ policy: AgentAutopilotPolicy }> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/agent/autopilot-policy'), {
    method: 'PATCH',
    headers: withApiToken({ 'content-type': 'application/json' }),
    body: JSON.stringify(input)
  });
}

export function runPendingAutopilot(
  baseUrl: string,
  input: RunPendingAutopilotInput,
  fetcher: Fetcher = fetch
): Promise<RunPendingAutopilotResponse> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/agent/autopilot/run-pending'), post(input));
}

export function getAutopilotWorkerStatus(
  baseUrl: string,
  fetcher: Fetcher = fetch
): Promise<{ worker: AutopilotWorkerStatus }> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/agent/autopilot/worker'));
}

export function runAutopilotWorkerOnce(
  baseUrl: string,
  fetcher: Fetcher = fetch
): Promise<AutopilotWorkerRunResponse> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/agent/autopilot/worker/run'), post({}));
}

export function listMemories(
  baseUrl: string,
  agentId: string,
  fetcher: Fetcher = fetch,
  query?: string
): Promise<{ memories: MemoryItem[] }> {
  const params = new URLSearchParams({ agentId });
  if (query) {
    params.set('query', query);
  }
  return requestJson(fetcher, endpoint(baseUrl, `/api/memories?${params.toString()}`));
}

export function generateDemoAssets(
  baseUrl: string,
  input: GenerateDemoAssetsInput,
  fetcher: Fetcher = fetch
): Promise<{ files: FileItem[]; messages: Message[] }> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/demo/assets/generate'), post(input));
}

export function syncMatrixOnce(
  baseUrl: string,
  fetcher: Fetcher = fetch
): Promise<{ messagesAdded: number; checkpoints: DemoState['matrixObserverCheckpoints'] }> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/matrix/sync-once'), post({}));
}

export function checkAiStatus(
  baseUrl: string,
  fetcher: Fetcher = fetch
): Promise<{ aiStatus: AiRuntimeStatus }> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/ai/status/check'), post({}));
}

export function listAgentActions(
  baseUrl: string,
  fetcher: Fetcher = fetch
): Promise<{ actions: AgentActionRequest[] }> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/agent/actions'));
}

export function confirmAgentAction(
  baseUrl: string,
  input: ReviewAgentActionInput,
  fetcher: Fetcher = fetch
): Promise<{ action: AgentActionRequest; log: AgentActionLog }> {
  return requestJson(
    fetcher,
    endpoint(baseUrl, `/api/agent/actions/${encodeURIComponent(input.actionId)}/confirm`),
    post({
      reviewerId: input.reviewerId,
      reason: input.reason
    })
  );
}

export function rejectAgentAction(
  baseUrl: string,
  input: ReviewAgentActionInput,
  fetcher: Fetcher = fetch
): Promise<{ action: AgentActionRequest; log: AgentActionLog }> {
  return requestJson(
    fetcher,
    endpoint(baseUrl, `/api/agent/actions/${encodeURIComponent(input.actionId)}/reject`),
    post({
      reviewerId: input.reviewerId,
      reason: input.reason
    })
  );
}

export function createStateEventSource(baseUrl = '', fetcher: Fetcher = fetch): StateEventStream {
  return createFetchSseStream(endpoint(baseUrl, '/api/events'), fetcher);
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: withApiToken({ 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  };
}

async function requestJson<T>(fetcher: Fetcher, url: string, init?: RequestInit): Promise<T> {
  const response = await fetcher(url, {
    headers: withApiToken({ 'content-type': 'application/json' }),
    ...init
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return response.json() as Promise<T>;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error;
    }
  } catch {
    // Fall through to the generic status message.
  }
  return `Request failed: ${response.status}`;
}

function createFetchSseStream(url: string, fetcher: Fetcher): StateEventStream {
  const listeners = new Map<string, Set<(event: StateStreamMessageEvent) => void>>();
  let closed = false;
  let activeAbortController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      if (!readySettled) {
        readySettled = true;
        resolve();
      }
    };
    rejectReady = (error: unknown) => {
      if (!readySettled) {
        readySettled = true;
        reject(error);
      }
    };
  });

  const scheduleReconnect = () =>
    new Promise<void>((resolve) => {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        resolve();
      }, eventStreamReconnectDelayMs);
    });

  const connect = async () => {
    activeAbortController = new AbortController();
    try {
      const response = await fetcher(url, {
        method: 'GET',
        headers: withApiToken({ accept: 'text/event-stream' }),
        signal: activeAbortController.signal
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      if (!response.body) {
        throw new Error('Event stream response did not include a body');
      }
      await readSseBody(response.body, (frame) => {
        const event = parseSseFrame(frame);
        if (event) {
          if (event.type === 'ready') {
            resolveReady();
          }
          dispatchEvent(listeners, event);
        }
      });
      if (!closed) {
        dispatchEvent(listeners, {
          type: 'error',
          data: 'Event stream disconnected'
        });
      }
    } catch (error) {
      if (closed && isAbortError(error)) {
        resolveReady();
        return;
      }
      if (!readySettled) {
        rejectReady(error);
      }
      if (!closed) {
        dispatchEvent(listeners, {
          type: 'error',
          data: error instanceof Error ? error.message : 'Event stream disconnected'
        });
      }
    } finally {
      activeAbortController = null;
    }
  };

  void (async () => {
    while (!closed) {
      await connect();
      if (!closed) {
        await scheduleReconnect();
      }
    }
  })();

  return {
    ready,
    addEventListener(type, listener) {
      const typeListeners = listeners.get(type) ?? new Set<(event: StateStreamMessageEvent) => void>();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      activeAbortController?.abort();
      listeners.clear();
    }
  };
}

async function readSseBody(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: string) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        onFrame(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (buffer.trim()) {
      onFrame(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string): StateStreamMessageEvent | null {
  let type = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    let value = separator >= 0 ? line.slice(separator + 1) : '';
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'event') {
      type = value || 'message';
    } else if (field === 'data') {
      data.push(value);
    }
  }
  if (data.length === 0) {
    return null;
  }
  return { type, data: data.join('\n') };
}

function dispatchEvent(
  listeners: Map<string, Set<(event: StateStreamMessageEvent) => void>>,
  event: StateStreamMessageEvent
): void {
  for (const listener of Array.from(listeners.get(event.type) ?? [])) {
    try {
      listener(event);
    } catch (error) {
      console.error('Event stream listener failed', error);
    }
  }
}

function parseDownloadFilename(contentDisposition: string | null): string | null {
  if (!contentDisposition) {
    return null;
  }
  const encodedFilename = /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'')?("?)([^";]+)\1/i.exec(contentDisposition);
  if (encodedFilename?.[2]) {
    try {
      return decodeURIComponent(encodedFilename[2]);
    } catch {
      return encodedFilename[2];
    }
  }
  const quotedFilename = /(?:^|;)\s*filename\s*=\s*"([^"]+)"/i.exec(contentDisposition);
  if (quotedFilename?.[1]) {
    return quotedFilename[1].replace(/\\"/g, '"');
  }
  const filename = /(?:^|;)\s*filename\s*=\s*([^;]+)/i.exec(contentDisposition);
  return filename?.[1]?.trim() || null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function withApiToken(headers: Record<string, string>): Record<string, string> {
  const token = getApiToken();
  return token ? { ...headers, 'x-agent-im-token': token } : headers;
}

function getApiToken(): string {
  return import.meta.env.VITE_AGENT_API_TOKEN ?? '';
}
