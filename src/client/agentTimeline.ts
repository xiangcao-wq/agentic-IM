import type {
  AgentEvent,
  AgentEventType,
  AgentPermissionOutcome,
  AgentToolName,
  AgentTrace,
  RiskLevel
} from '../domain/types';

export type AgentTimelineTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface AgentTimelineItem {
  id: string;
  type: AgentEventType;
  title: string;
  detail: string;
  timestamp: string;
  tone: AgentTimelineTone;
  toolName?: AgentToolName | string;
  riskLevel?: RiskLevel;
}

export interface PermissionCenterItem {
  id: string;
  invocationId: string;
  toolName: AgentToolName | string;
  outcome: AgentPermissionOutcome;
  label: string;
  requiredPermissions: string[];
  requiresHuman: boolean;
  reviewerIds: string[];
  reason: string;
  timestamp: string;
  riskLevel?: RiskLevel;
}

const SKIPPED_TIMELINE_EVENT_TYPES = new Set<AgentEventType>(['agent.progress']);

export function buildAgentTimelineItems(trace?: AgentTrace | null): AgentTimelineItem[] {
  if (!trace) {
    return [];
  }

  return trace.events
    .filter((event) => !SKIPPED_TIMELINE_EVENT_TYPES.has(event.type))
    .map((event) => {
      const toolName = readToolName(event);

      return {
        id: event.id,
        type: event.type,
        title: timelineTitle(event.type),
        detail: timelineDetail(event),
        timestamp: event.createdAt,
        tone: timelineTone(event.type),
        ...(toolName ? { toolName } : {}),
        ...(event.riskLevel ? { riskLevel: event.riskLevel } : {})
      };
    });
}

export function buildPermissionCenterItems(trace?: AgentTrace | null): PermissionCenterItem[] {
  if (!trace) {
    return [];
  }

  return trace.events
    .filter(isPermissionEvent)
    .map((event) => {
      const outcome = permissionOutcome(event);
      const invocationId = readString(event.payload.invocationId) ?? readInvocationString(event, 'id') ?? event.id;
      const requiredPermissions =
        readStringArray(event.payload.requiredPermissions) ?? readInvocationStringArray(event, 'requiredPermissions') ?? [];
      const reviewerIds = readStringArray(event.payload.reviewerIds) ?? readInvocationStringArray(event, 'reviewerIds') ?? [];
      const reason =
        readStringArray(event.payload.reasons)?.[0] ??
        readInvocationStringArray(event, 'reasons')?.[0] ??
        event.detail ??
        event.label ??
        outcome;

      return {
        id: event.id,
        invocationId,
        toolName: readToolName(event) ?? 'unknown.tool',
        outcome,
        label: permissionLabel(outcome),
        requiredPermissions,
        requiresHuman: readBoolean(event.payload.requiresHuman) ?? readInvocationBoolean(event, 'requiresHuman') ?? outcome === 'ask',
        reviewerIds,
        reason,
        timestamp: event.createdAt,
        ...(event.riskLevel ? { riskLevel: event.riskLevel } : {})
      };
    });
}

function isPermissionEvent(event: AgentEvent): boolean {
  return (
    event.type === 'agent.permission.allowed' ||
    event.type === 'agent.permission.denied' ||
    event.type === 'agent.permission.requested'
  );
}

function permissionOutcome(event: AgentEvent): AgentPermissionOutcome {
  if (event.type === 'agent.permission.allowed') {
    return 'allow';
  }
  if (event.type === 'agent.permission.denied') {
    return 'deny';
  }
  return 'ask';
}

function permissionLabel(outcome: AgentPermissionOutcome): string {
  if (outcome === 'allow') {
    return 'Allowed';
  }
  if (outcome === 'deny') {
    return 'Denied';
  }
  return 'Needs review';
}

function timelineTitle(type: AgentEventType): string {
  const titles: Record<AgentEventType, string> = {
    'agent.run.created': 'Run queued',
    'agent.run.started': 'Run started',
    'agent.progress': 'Progress',
    'agent.tool.requested': 'Tool requested',
    'agent.permission.allowed': 'Permission allowed',
    'agent.permission.denied': 'Permission denied',
    'agent.permission.requested': 'Permission needs review',
    'agent.tool.completed': 'Tool completed',
    'agent.tool.failed': 'Tool failed',
    'agent.run.completed': 'Run completed',
    'agent.run.failed': 'Run failed',
    'agent.run.cancelled': 'Run cancelled'
  };
  return titles[type];
}

function timelineTone(type: AgentEventType): AgentTimelineTone {
  if (type === 'agent.permission.denied' || type === 'agent.tool.failed' || type === 'agent.run.failed') {
    return 'danger';
  }
  if (type === 'agent.permission.requested') {
    return 'warning';
  }
  if (
    type === 'agent.permission.allowed' ||
    type === 'agent.tool.completed' ||
    type === 'agent.run.completed'
  ) {
    return 'success';
  }
  return 'neutral';
}

function timelineDetail(event: AgentEvent): string {
  const status = readString(event.payload.status);
  const invocationStatus = readInvocationString(event, 'status');
  const outcome = readString(event.payload.permissionOutcome);
  const invocationOutcome = readInvocationString(event, 'permissionOutcome');
  const reason = readStringArray(event.payload.reasons)?.[0];
  const invocationReason = readInvocationStringArray(event, 'reasons')?.[0];
  return event.detail ?? reason ?? invocationReason ?? status ?? invocationStatus ?? outcome ?? invocationOutcome ?? event.label ?? event.type;
}

function readToolName(event: AgentEvent): AgentToolName | string | undefined {
  return readString(event.payload.toolName) ?? event.toolCalls[0] ?? readInvocationString(event, 'toolName');
}

function readInvocationRecord(event: AgentEvent): Record<string, unknown> | undefined {
  const value = event.payload.invocation;
  return isRecord(value) ? value : undefined;
}

function readInvocationString(event: AgentEvent, key: string): string | undefined {
  return readString(readInvocationRecord(event)?.[key]);
}

function readInvocationBoolean(event: AgentEvent, key: string): boolean | undefined {
  return readBoolean(readInvocationRecord(event)?.[key]);
}

function readInvocationStringArray(event: AgentEvent, key: string): string[] | undefined {
  return readStringArray(readInvocationRecord(event)?.[key]);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
