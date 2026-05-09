import type { AgentToolInvocationSnapshot, RiskAssessment } from '../../domain/types';
import type { AgentCoreToolName } from './toolRegistry';
import type { ToolPermissionDecision } from './permissionBroker';

export type ToolInvocationStatus =
  | 'validation_failed'
  | 'denied'
  | 'awaiting_permission'
  | 'completed'
  | 'failed';

export interface ToolInvocationRecord {
  id: string;
  toolName: AgentCoreToolName;
  agentId: string;
  roomId: string;
  status: ToolInvocationStatus;
  permissionOutcome?: ToolPermissionDecision['outcome'];
  requiredPermissions: string[];
  requiresHuman: boolean;
  risk?: RiskAssessment;
  reviewerIds: string[];
  reasons: string[];
  evidenceIds: string[];
  inputSummary: Record<string, unknown>;
  outputSummary: Record<string, unknown>;
  error?: string;
  createdAt: string;
}

export interface CreateToolInvocationRecordInput {
  id?: string;
  toolName: AgentCoreToolName;
  agentId: string;
  roomId: string;
  status: ToolInvocationStatus;
  permission?: ToolPermissionDecision;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  evidenceIds?: string[];
  error?: string;
  createdAt?: string;
}

export function createToolInvocationRecord(input: CreateToolInvocationRecordInput): ToolInvocationRecord {
  return {
    id: input.id ?? `tool-invocation-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    toolName: input.toolName,
    agentId: input.agentId,
    roomId: input.roomId,
    status: input.status,
    permissionOutcome: input.permission?.outcome,
    requiredPermissions: [...(input.permission?.requiredPermissions ?? [])],
    requiresHuman: input.permission?.requiresHuman ?? false,
    risk: input.permission ? { ...input.permission.risk } : undefined,
    reviewerIds: [...(input.permission?.reviewerIds ?? [])],
    reasons: [...(input.permission?.reasons ?? [])],
    evidenceIds: [...(input.evidenceIds ?? [])],
    inputSummary: cloneSummary(input.inputSummary),
    outputSummary: cloneSummary(input.outputSummary),
    error: input.error,
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}

export function toolInvocationRecordToSnapshot(record: ToolInvocationRecord): AgentToolInvocationSnapshot {
  return {
    id: record.id,
    toolName: record.toolName,
    agentId: record.agentId,
    roomId: record.roomId,
    status: record.status,
    ...(record.permissionOutcome !== undefined ? { permissionOutcome: record.permissionOutcome } : {}),
    requiredPermissions: [...record.requiredPermissions],
    requiresHuman: record.requiresHuman,
    ...(record.risk ? { risk: { ...record.risk } } : {}),
    reviewerIds: [...record.reviewerIds],
    reasons: [...record.reasons],
    evidenceIds: [...record.evidenceIds],
    inputSummary: cloneSnapshotSummary(record.inputSummary),
    outputSummary: cloneSnapshotSummary(record.outputSummary),
    ...(record.error !== undefined ? { error: record.error } : {}),
    createdAt: record.createdAt
  };
}

function cloneSummary(summary?: Record<string, unknown>): Record<string, unknown> {
  const source = summary ?? {};

  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(source) as Record<string, unknown>;
    } catch {
      return cloneSummaryWithJson(source);
    }
  }

  return cloneSummaryWithJson(source);
}

function cloneSummaryWithJson(summary: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(summary)) as Record<string, unknown>;
}

function cloneSnapshotSummary(summary?: Record<string, unknown>): Record<string, unknown> {
  const value = sanitizeJsonValue(summary ?? {}, new WeakSet());
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
