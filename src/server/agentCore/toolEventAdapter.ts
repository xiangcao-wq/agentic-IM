import type { AgentToolInvocationSnapshot, RiskAssessment } from '../../domain/types';
import type { AgentEventDraft, AgentEventPayload, AgentEventType } from './agentEvents';

export interface ToolInvocationEventContext {
  tenantId: string;
  sessionId: string;
  runId: string;
}

export function toolInvocationToEventDrafts(
  context: ToolInvocationEventContext,
  invocation: AgentToolInvocationSnapshot
): AgentEventDraft[] {
  const snapshot = cloneInvocation(invocation);
  const drafts: AgentEventDraft[] = [createToolEventDraft(context, snapshot, 'agent.tool.requested')];
  const permissionType = permissionEventType(snapshot.permissionOutcome);

  if (permissionType) {
    drafts.push(createToolEventDraft(context, snapshot, permissionType));
  }

  const terminalType = terminalToolEventType(snapshot.status);

  if (terminalType) {
    drafts.push(createToolEventDraft(context, snapshot, terminalType));
  }

  return drafts;
}

function createToolEventDraft(
  context: ToolInvocationEventContext,
  invocation: AgentToolInvocationSnapshot,
  type: AgentEventType
): AgentEventDraft {
  return {
    type,
    tenantId: context.tenantId,
    sessionId: context.sessionId,
    runId: context.runId,
    agentId: invocation.agentId,
    roomId: invocation.roomId,
    visibility: 'audit',
    phase: 'executing',
    label: labelFor(type, invocation),
    detail: detailFor(type, invocation),
    toolCalls: [invocation.toolName],
    riskLevel: invocation.risk?.level,
    payload: createToolEventPayload(invocation, type)
  };
}

function permissionEventType(
  outcome: AgentToolInvocationSnapshot['permissionOutcome']
): AgentEventType | undefined {
  if (outcome === 'allow') {
    return 'agent.permission.allowed';
  }

  if (outcome === 'deny') {
    return 'agent.permission.denied';
  }

  if (outcome === 'ask') {
    return 'agent.permission.requested';
  }

  return undefined;
}

function terminalToolEventType(status: AgentToolInvocationSnapshot['status']): AgentEventType | undefined {
  if (status === 'completed') {
    return 'agent.tool.completed';
  }

  if (status === 'failed' || status === 'denied' || status === 'validation_failed') {
    return 'agent.tool.failed';
  }

  return undefined;
}

function createToolEventPayload(
  invocation: AgentToolInvocationSnapshot,
  eventKind: AgentEventType
): AgentEventPayload {
  return {
    invocation,
    invocationId: invocation.id,
    toolName: invocation.toolName,
    status: invocation.status,
    permissionOutcome: invocation.permissionOutcome,
    requiredPermissions: [...invocation.requiredPermissions],
    requiresHuman: invocation.requiresHuman,
    reviewerIds: [...invocation.reviewerIds],
    reasons: [...invocation.reasons],
    evidenceIds: [...invocation.evidenceIds],
    inputSummary: cloneJsonRecord(invocation.inputSummary),
    outputSummary: cloneJsonRecord(invocation.outputSummary),
    risk: invocation.risk ? cloneRisk(invocation.risk) : null,
    error: invocation.error,
    eventKind
  };
}

function labelFor(type: AgentEventType, invocation: AgentToolInvocationSnapshot): string {
  if (type === 'agent.tool.requested') {
    return `Tool requested: ${invocation.toolName}`;
  }

  if (type === 'agent.permission.allowed') {
    return `Permission allowed: ${invocation.toolName}`;
  }

  if (type === 'agent.permission.denied') {
    return `Permission denied: ${invocation.toolName}`;
  }

  if (type === 'agent.permission.requested') {
    return `Permission requested: ${invocation.toolName}`;
  }

  if (type === 'agent.tool.completed') {
    return `Tool completed: ${invocation.toolName}`;
  }

  if (type === 'agent.tool.failed') {
    return `Tool failed: ${invocation.toolName}`;
  }

  return invocation.toolName;
}

function detailFor(type: AgentEventType, invocation: AgentToolInvocationSnapshot): string {
  if (type === 'agent.tool.failed') {
    return invocation.error ?? invocation.reasons[0] ?? invocation.status;
  }

  if (type.startsWith('agent.permission.')) {
    return invocation.reasons[0] ?? invocation.permissionOutcome ?? invocation.id;
  }

  return invocation.id;
}

function cloneInvocation(invocation: AgentToolInvocationSnapshot): AgentToolInvocationSnapshot {
  return {
    ...invocation,
    requiredPermissions: [...invocation.requiredPermissions],
    ...(invocation.risk ? { risk: cloneRisk(invocation.risk) } : {}),
    reviewerIds: [...invocation.reviewerIds],
    reasons: [...invocation.reasons],
    evidenceIds: [...invocation.evidenceIds],
    inputSummary: cloneJsonRecord(invocation.inputSummary),
    outputSummary: cloneJsonRecord(invocation.outputSummary)
  };
}

function cloneRisk(risk: RiskAssessment): RiskAssessment {
  return {
    level: risk.level,
    score: Number.isFinite(risk.score) ? risk.score : 0,
    reason: risk.reason,
    model: risk.model
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
