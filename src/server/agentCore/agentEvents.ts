import type { AgentToolInvocationSnapshot, RiskLevel } from '../../domain/types';

export type AgentEventVisibility = 'user' | 'internal' | 'audit';

export const AGENT_EVENT_TYPES = [
  'agent.run.created',
  'agent.run.started',
  'agent.progress',
  'agent.tool.requested',
  'agent.permission.allowed',
  'agent.permission.denied',
  'agent.permission.requested',
  'agent.tool.completed',
  'agent.tool.failed',
  'agent.run.completed',
  'agent.run.failed',
  'agent.run.cancelled'
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export type AgentEventPayload = Record<string, unknown>;
export type AgentRunEventType =
  | 'agent.run.created'
  | 'agent.run.started'
  | 'agent.run.completed'
  | 'agent.run.failed'
  | 'agent.run.cancelled';

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
  riskLevel?: RiskLevel;
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
  toolInvocations?: AgentToolInvocationSnapshot[];
  riskLevel?: RiskLevel;
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
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new RangeError('event sequence must be a non-negative integer');
  }

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
  if (progress.runId !== context.runId) {
    throw new Error('progress runId must match event context runId');
  }

  const toolCalls = progress.toolCalls ? [...progress.toolCalls] : [];
  const toolInvocations = (progress.toolInvocations ?? []).map(cloneToolInvocationSnapshot);

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
      ...(progress.toolInvocations !== undefined ? { toolInvocations } : {}),
      riskLevel: progress.riskLevel
    }
  };
}

function cloneToolInvocationSnapshot(snapshot: AgentToolInvocationSnapshot): AgentToolInvocationSnapshot {
  return {
    ...snapshot,
    requiredPermissions: [...snapshot.requiredPermissions],
    ...(snapshot.risk ? { risk: { ...snapshot.risk } } : {}),
    reviewerIds: [...snapshot.reviewerIds],
    reasons: [...snapshot.reasons],
    evidenceIds: [...snapshot.evidenceIds],
    inputSummary: cloneJsonRecord(snapshot.inputSummary),
    outputSummary: cloneJsonRecord(snapshot.outputSummary)
  };
}

function cloneJsonRecord(record: Record<string, unknown>): Record<string, unknown> {
  const value = sanitizeJsonValue(record, new WeakSet());
  return isPlainRecord(value) ? value : {};
}

function sanitizeJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value !== 'object') {
    return undefined;
  }

  if (seen.has(value)) {
    return undefined;
  }

  if (Array.isArray(value)) {
    seen.add(value);
    const sanitized = value.map((item) => {
      const sanitizedItem = sanitizeJsonValue(item, seen);
      return sanitizedItem === undefined ? null : sanitizedItem;
    });
    seen.delete(value);
    return sanitized;
  }

  if (!isPlainRecord(value)) {
    return undefined;
  }

  seen.add(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const sanitizedItem = sanitizeJsonValue(item, seen);
    if (sanitizedItem !== undefined) {
      sanitized[key] = sanitizedItem;
    }
  }
  seen.delete(value);
  return sanitized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeSequence(sequence: number): number {
  if (!Number.isFinite(sequence)) {
    return 0;
  }

  const normalized = Math.trunc(sequence);
  return normalized >= 0 ? normalized : 0;
}
