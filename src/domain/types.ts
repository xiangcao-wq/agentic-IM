export type RiskLevel = 'low' | 'medium' | 'high';
export type AgentActionStatus = 'pending' | 'executed' | 'needs_confirmation' | 'blocked' | 'rejected';
export type AgentActionKind =
  | 'summary'
  | 'deadline'
  | 'find_file'
  | 'share_file'
  | 'coordinate'
  | 'task_update'
  | 'calendar_update'
  | 'task_update_suggest';

export type AiActorRole = 'human_user' | 'personal_agent';
export type AiAutoreplyTriggerMode = 'all_messages' | 'mentions_only';
export type AiReplyJobStatus = 'pending' | 'completed' | 'skipped' | 'failed';
export type MemoryKind = 'summary' | 'deadline' | 'file' | 'coordination' | 'note';
export type AgentPlanMode = 'answer' | 'execute' | 'request_confirmation';
export type AgentAutopilotAction =
  | 'reply'
  | 'search_files'
  | 'share_low_risk_files'
  | 'suggest_task_updates'
  | 'coordinate_schedule'
  | 'a2a_negotiate';
export type A2ASessionStatus = 'active' | 'completed' | 'needs_confirmation' | 'blocked';
export type A2ATurnKind = 'observation' | 'proposal' | 'response' | 'tool_result';
export type AiRuntimeProvider = 'deepseek' | 'fallback';
export type AiRuntimeHealth = 'missing' | 'unknown' | 'connected' | 'failed';
export type AgentRunIntent =
  | 'summary'
  | 'deadline'
  | 'find_file'
  | 'share_file'
  | 'coordinate'
  | 'task_update_suggest'
  | 'web_search'
  | 'chat';
export type AgentToolName =
  | 'chat.answer'
  | 'room.summarize'
  | 'deadline.answer'
  | 'file.search'
  | 'file.share'
  | 'web.search'
  | 'agent.coordinate'
  | 'task.suggest_update';

export interface User {
  id: string;
  name: string;
  role: string;
  avatar: string;
  status: 'online' | 'offline' | 'busy';
  agentId: string;
  matrixUserId?: string;
}

export interface PersonalAgent {
  id: string;
  ownerId: string;
  displayName: string;
  autonomy: 'risk_evaluated';
  allowedRoomIds: string[];
  allowedToolIds: string[];
}

export interface Room {
  id: string;
  name: string;
  type: 'class' | 'team' | 'direct';
  memberIds: string[];
  unreadCount: number;
  matrixAlias: string;
  matrixRoomId?: string;
}

export interface Message {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  body: string;
  sentAt: string;
  type: 'text' | 'file' | 'agent';
  agentLabel?: string;
  sourceAgentId?: string;
  fileId?: string;
  mxcUri?: string;
  contentType?: string;
  size?: number;
}

export interface FileItem {
  id: string;
  name: string;
  uploaderId: string;
  version: number;
  roomId: string;
  updatedAt: string;
  visibility: 'room' | 'owner';
  agentCanShare: boolean;
  tags: string[];
  summary: string;
  mxcUri?: string;
  localPath?: string;
  contentType?: string;
  size?: number;
  matrixEventId?: string;
}

export interface FileTextChunk {
  id: string;
  fileId: string;
  roomId: string;
  uploaderId: string;
  index: number;
  text: string;
  createdAt: string;
}

export interface TaskItem {
  id: string;
  title: string;
  deadline: string;
  owners: string[];
  status: 'pending' | 'in_progress' | 'done';
  sourceMessageId: string;
}

export interface CalendarItem {
  id: string;
  title: string;
  startsAt: string;
  roomId: string;
  attendees: string[];
  sourceTaskId: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  score: number;
  reason: string;
  model: string;
}

export interface AgentToolCall {
  tool: AgentToolName;
  args: Record<string, unknown>;
}

export interface AgentPlan {
  mode: AgentPlanMode;
  intent: AgentRunIntent;
  userVisiblePlan: string;
  answer?: string;
  toolCalls: AgentToolCall[];
  risk: RiskAssessment;
  citations: string[];
  needsConfirmationReason?: string;
}

export interface AgentActionLog {
  id: string;
  agentId: string;
  roomId: string;
  action: string;
  status: 'executed' | 'needs_confirmation' | 'blocked';
  risk: RiskAssessment;
  contextIds: string[];
  toolCalls: string[];
  createdAt: string;
}

export interface AgentAutopilotPolicy {
  agentId: string;
  enabled: boolean;
  allowedRoomIds: string[];
  autoExecuteMaxRisk: RiskLevel;
  allowedActions: AgentAutopilotAction[];
  updatedAt: string;
}

export interface A2ATurn {
  id: string;
  agentId: string;
  kind: A2ATurnKind;
  message: string;
  toolCalls: string[];
  createdAt: string;
}

export interface A2ASession {
  id: string;
  roomId: string;
  initiatorAgentId: string;
  targetAgentIds: string[];
  goal: string;
  status: A2ASessionStatus;
  turns: A2ATurn[];
  proposedActionRequestIds: string[];
  contextIds: string[];
  risk: RiskAssessment;
  createdAt: string;
  updatedAt: string;
}

export type AgentProgressPhase = 'started' | 'planning' | 'executing' | 'completed' | 'failed';

export interface AgentProgressEvent {
  id: string;
  runId: string;
  sequence: number;
  agentId: string;
  roomId: string;
  phase: AgentProgressPhase;
  label: string;
  detail?: string;
  toolCalls: string[];
  riskLevel?: RiskLevel;
  createdAt: string;
}

export interface AgentActionRequest {
  id: string;
  agentId: string;
  roomId: string;
  kind: AgentActionKind;
  status: AgentActionStatus;
  input: Record<string, unknown>;
  risk?: RiskAssessment;
  createdAt: string;
  updatedAt: string;
  requiresHuman: boolean;
  logId?: string;
}

export interface AiActorProfile {
  userId: string;
  model: string;
  persona: string;
  allowedRoomIds: string[];
  replyStyle: string;
}

export interface AiAutoreplyPolicy {
  userId: string;
  enabled: boolean;
  allowedRoomIds: string[];
  triggerMode: AiAutoreplyTriggerMode;
  cooldownMs: number;
  priority: number;
}

export interface AiReplyJob {
  id: string;
  roomId: string;
  targetUserId: string;
  triggeringMessageId: string;
  status: AiReplyJobStatus;
  reason: string;
  replyMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryItem {
  id: string;
  ownerAgentId: string;
  scopeRoomIds: string[];
  kind: MemoryKind;
  content: string;
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MatrixObserverCheckpoint {
  roomId: string;
  lastEventId: string;
}

export interface AiRuntimeStatus {
  configured: boolean;
  provider: AiRuntimeProvider;
  health: AiRuntimeHealth;
  agentModel?: string;
  humanModel?: string;
  baseUrlHost?: string;
  cache?: {
    requestCount: number;
    promptCacheHitTokens: number;
    promptCacheMissTokens: number;
    promptCacheHitRate: number;
    lastUpdatedAt?: string;
    routes?: Array<{
      role: AiActorRole;
      provider: string;
      requestCount: number;
      promptCacheHitTokens: number;
      promptCacheMissTokens: number;
      promptCacheHitRate: number;
      lastUpdatedAt?: string;
    }>;
  };
  lastCheckedAt?: string;
  lastError?: string;
  lastLatencyMs?: number;
}

export interface DemoState {
  users: User[];
  agents: PersonalAgent[];
  rooms: Room[];
  messages: Message[];
  files: FileItem[];
  fileTextChunks: FileTextChunk[];
  tasks: TaskItem[];
  calendar: CalendarItem[];
  actionLogs: AgentActionLog[];
  actionRequests: AgentActionRequest[];
  a2aSessions: A2ASession[];
  agentAutopilotPolicies: AgentAutopilotPolicy[];
  memories: MemoryItem[];
  matrixObserverCheckpoints: MatrixObserverCheckpoint[];
  aiAutoreplyPolicies: AiAutoreplyPolicy[];
  aiReplyJobs: AiReplyJob[];
  aiStatus?: AiRuntimeStatus;
}

export interface RoomSummary {
  headline: string;
  deadlines: string[];
  todos: string[];
  sources: string[];
}

export interface DeadlineAnswer {
  answer: string;
  citations: string[];
}

export interface FileShareAction {
  status: 'executed' | 'needs_confirmation' | 'blocked';
  requiresHuman: boolean;
  risk: RiskAssessment;
  file?: FileItem;
  message?: Message;
  log: AgentActionLog;
}

export interface CoordinationResult {
  status: 'executed' | 'needs_confirmation' | 'blocked';
  requiresHuman: boolean;
  risk: RiskAssessment;
  proposedPlan: string;
  log: AgentActionLog;
}

export interface AgentRunRequest {
  agentId: string;
  roomId: string;
  intent?: AgentRunIntent;
  userText: string;
  targetUserId?: string;
}

export interface ChatResult {
  reply: string;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

export interface WebSearchAnswer {
  answer: string;
  results: WebSearchResultItem[];
  citations: string[];
  unavailableReason?: string;
}

export interface AgentRunResult {
  intent: AgentRunIntent;
  requiresHuman: boolean;
  plan?: string;
  reasoning?: string;
  result?: RoomSummary | DeadlineAnswer | FileShareAction | CoordinationResult | ChatResult | WebSearchAnswer;
  files?: FileItem[];
  message?: Message;
  memory?: MemoryItem;
  log: AgentActionLog;
  actionRequest?: AgentActionRequest;
}
