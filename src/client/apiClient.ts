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
  sessions: DemoState['a2aSessions'];
  messages: Message[];
  logs: AgentActionLog[];
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
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastError?: string;
}

export interface AutopilotWorkerRunResponse extends RunPendingAutopilotResponse {
  worker: AutopilotWorkerStatus;
  skippedReason?: 'disabled' | 'already_running';
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

export function fileDownloadUrl(baseUrl: string, fileId: string): string {
  return endpoint(baseUrl, `/api/files/${encodeURIComponent(fileId)}/download`);
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

export function createStateEventSource(baseUrl = ''): EventSource {
  return new EventSource(endpoint(baseUrl, '/api/events'));
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

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function withApiToken(headers: Record<string, string>): Record<string, string> {
  const token = import.meta.env.VITE_AGENT_API_TOKEN;
  return token ? { ...headers, 'x-agent-im-token': token } : headers;
}
