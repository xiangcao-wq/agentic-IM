export type AgentEventVisibility = 'user' | 'internal' | 'audit';

export type AgentEventType =
  | 'agent.run.created'
  | 'agent.run.started'
  | 'agent.progress'
  | 'agent.run.completed'
  | 'agent.run.failed'
  | 'agent.run.cancelled';

export type AgentEventPayload = Record<string, unknown>;
export type AgentRunEventType = Exclude<AgentEventType, 'agent.progress'>;

export interface AgentEventDraft {
  type: AgentEventType;
  tenantId: string;
  sessionId: string;
  runId: string;
  agentId?: string;
  roomId?: string;
  visibility: AgentEventVisibility;
  phase?: string;
  label?: string;
  detail?: string;
  toolCalls: string[];
  riskLevel?: string;
  payload: AgentEventPayload;
}

export interface AgentEvent extends AgentEventDraft {
  id: string;
  sequence: number;
  cursor: string;
  createdAt: string;
}

export interface AgentRunEventDraftInput {
  type: AgentRunEventType;
  tenantId: string;
  sessionId: string;
  runId: string;
  agentId?: string;
  roomId?: string;
  entrypoint: string;
  visibility?: AgentEventVisibility;
  toolCalls?: string[];
  payload?: AgentEventPayload;
}

export interface AgentProgressDraftContext {
  tenantId: string;
  sessionId: string;
  runId: string;
}

export interface LegacyAgentProgressEvent {
  runId: string;
  agentId?: string;
  roomId?: string;
  phase: string;
  label: string;
  detail?: string;
  toolCalls?: string[];
  riskLevel?: string;
}

export function encodeEventCursor(sequence: number): string {
  return `seq:${normalizeSequence(sequence)}`;
}

export function parseEventCursor(cursor?: string | null): number {
  if (!cursor) {
    return 0;
  }

  const match = /^seq:(\d+)$/.exec(cursor);
  if (!match) {
    return 0;
  }

  const sequence = Number(match[1]);
  return normalizeSequence(sequence);
}

export function createAgentEventId(runId: string, sequence: number): string {
  return `${runId}-event-${String(sequence).padStart(8, '0')}`;
}

export function createRunEventDraft(input: AgentRunEventDraftInput): AgentEventDraft {
  return {
    type: input.type,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    runId: input.runId,
    agentId: input.agentId,
    roomId: input.roomId,
    visibility: input.visibility ?? 'internal',
    toolCalls: input.toolCalls ? [...input.toolCalls] : [],
    payload: {
      ...(input.payload ?? {}),
      entrypoint: input.entrypoint
    }
  };
}

export function agentProgressToEventDraft(
  context: AgentProgressDraftContext,
  progress: LegacyAgentProgressEvent
): AgentEventDraft {
  const toolCalls = progress.toolCalls ? [...progress.toolCalls] : [];

  return {
    type: 'agent.progress',
    tenantId: context.tenantId,
    sessionId: context.sessionId,
    runId: context.runId,
    agentId: progress.agentId,
    roomId: progress.roomId,
    phase: progress.phase,
    label: progress.label,
    detail: progress.detail,
    visibility: 'user',
    toolCalls,
    riskLevel: progress.riskLevel,
    payload: {
      phase: progress.phase,
      label: progress.label,
      detail: progress.detail,
      toolCalls,
      riskLevel: progress.riskLevel
    }
  };
}

function normalizeSequence(sequence: number): number {
  if (!Number.isFinite(sequence)) {
    return 0;
  }

  const normalized = Math.trunc(sequence);
  return normalized >= 0 ? normalized : 0;
}
