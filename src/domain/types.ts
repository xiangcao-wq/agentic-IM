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
export type AgentRunIntent =
  | 'summary'
  | 'deadline'
  | 'find_file'
  | 'share_file'
  | 'coordinate'
  | 'task_update_suggest'
  | 'chat';

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
  contentType?: string;
  size?: number;
  matrixEventId?: string;
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

export interface DemoState {
  users: User[];
  agents: PersonalAgent[];
  rooms: Room[];
  messages: Message[];
  files: FileItem[];
  tasks: TaskItem[];
  calendar: CalendarItem[];
  actionLogs: AgentActionLog[];
  actionRequests: AgentActionRequest[];
  memories: MemoryItem[];
  matrixObserverCheckpoints: MatrixObserverCheckpoint[];
  aiAutoreplyPolicies: AiAutoreplyPolicy[];
  aiReplyJobs: AiReplyJob[];
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
  intent: AgentRunIntent;
  userText: string;
  targetUserId?: string;
}

export interface ChatResult {
  reply: string;
}

export interface AgentRunResult {
  intent: AgentRunIntent;
  requiresHuman: boolean;
  reasoning?: string;
  result?: RoomSummary | DeadlineAnswer | FileShareAction | CoordinationResult | ChatResult;
  files?: FileItem[];
  message?: Message;
  memory?: MemoryItem;
  log: AgentActionLog;
  actionRequest?: AgentActionRequest;
}
