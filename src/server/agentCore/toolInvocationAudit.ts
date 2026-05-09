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
    reviewerIds: [...(input.permission?.reviewerIds ?? [])],
    reasons: [...(input.permission?.reasons ?? [])],
    evidenceIds: [...(input.evidenceIds ?? [])],
    inputSummary: { ...(input.inputSummary ?? {}) },
    outputSummary: { ...(input.outputSummary ?? {}) },
    error: input.error,
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}
