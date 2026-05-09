import type { AgentToolName, FileItem } from '../../domain/types';

export type AgentCoreToolName = Extract<AgentToolName, 'message.send' | 'file.share'>;
export type ToolSideEffect = 'read' | 'write' | 'external' | 'destructive';
export type ToolVisibility = 'model' | 'internal';
export type ToolCategory = 'communication' | 'file';
export type ToolAuditLevel = 'none' | 'summary' | 'full';

export interface ToolAuditPolicy {
  level: ToolAuditLevel;
}

export interface ToolPermissionPolicy {
  mode: 'none' | 'policy';
  requiredPermissions: string[];
  requiresApprovalOn: Array<'ask'>;
}

export interface ToolRiskPolicy {
  requiresPolicy: boolean;
}

export type ToolInputValidation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface MessageSendInput {
  targetRoomId: string;
  targetUserId?: string;
  messageBody: string;
}

export interface FileShareInput {
  fileId?: string;
  fileVersion?: number;
  file?: FileItem;
  requesterId?: string;
  targetRoomId?: string;
  requestText?: string;
}

export interface AgentCoreToolDefinition<Input> {
  name: AgentCoreToolName;
  version: number;
  displayName: string;
  description: string;
  category: ToolCategory;
  sideEffect: ToolSideEffect;
  visibility: ToolVisibility;
  audit: ToolAuditPolicy;
  permission: ToolPermissionPolicy;
  requiredPermissions: string[];
  riskPolicy: ToolRiskPolicy;
  validateInput(input: unknown): ToolInputValidation<Input>;
}

type CoreToolsRegistry = {
  'message.send': AgentCoreToolDefinition<MessageSendInput>;
  'file.share': AgentCoreToolDefinition<FileShareInput>;
};

const MESSAGE_SEND_REQUIRED_PERMISSIONS = ['message:send'] as const;
const FILE_SHARE_REQUIRED_PERMISSIONS = ['file:share'] as const;

const coreTools: CoreToolsRegistry = {
  'message.send': {
    name: 'message.send',
    version: 1,
    displayName: 'Send message',
    description: 'Send an Agent-authored delegated message to an authorized room or direct chat.',
    category: 'communication',
    sideEffect: 'write',
    visibility: 'model',
    audit: { level: 'full' },
    permission: createPolicyPermission(MESSAGE_SEND_REQUIRED_PERMISSIONS),
    requiredPermissions: createPermissions(MESSAGE_SEND_REQUIRED_PERMISSIONS),
    riskPolicy: { requiresPolicy: true },
    validateInput: validateMessageSendInput
  },
  'file.share': {
    name: 'file.share',
    version: 1,
    displayName: 'Share file',
    description: 'Share a real Matrix-backed authorized file or request confirmation.',
    category: 'file',
    sideEffect: 'external',
    visibility: 'model',
    audit: { level: 'full' },
    permission: createPolicyPermission(FILE_SHARE_REQUIRED_PERMISSIONS),
    requiredPermissions: createPermissions(FILE_SHARE_REQUIRED_PERMISSIONS),
    riskPolicy: { requiresPolicy: true },
    validateInput: validateFileShareInput
  }
};

export type AgentCoreTool = (typeof coreTools)[keyof typeof coreTools];

export function getCoreTool<Name extends AgentCoreToolName>(name: Name): (typeof coreTools)[Name] {
  return cloneCoreTool(coreTools[name]);
}

export function listCoreTools(): AgentCoreTool[] {
  return Object.values(coreTools).map(cloneCoreTool);
}

export function isCoreToolName(value: unknown): value is AgentCoreToolName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(coreTools, value);
}

function createPolicyPermission(requiredPermissions: readonly string[]): ToolPermissionPolicy {
  return {
    mode: 'policy',
    requiredPermissions: createPermissions(requiredPermissions),
    requiresApprovalOn: ['ask']
  };
}

function createPermissions(requiredPermissions: readonly string[]): string[] {
  return [...requiredPermissions];
}

function cloneCoreTool<T extends AgentCoreTool>(tool: T): T {
  return {
    ...tool,
    audit: { ...tool.audit },
    permission: {
      ...tool.permission,
      requiredPermissions: [...tool.permission.requiredPermissions],
      requiresApprovalOn: [...tool.permission.requiresApprovalOn]
    },
    requiredPermissions: [...tool.requiredPermissions],
    riskPolicy: { ...tool.riskPolicy }
  };
}

function validateMessageSendInput(input: unknown): ToolInputValidation<MessageSendInput> {
  if (!isRecord(input)) {
    return { ok: false, error: 'input must be an object' };
  }

  if (typeof input.targetRoomId !== 'string' || input.targetRoomId.trim().length === 0) {
    return { ok: false, error: 'targetRoomId must be a non-empty string' };
  }

  if (typeof input.messageBody !== 'string' || input.messageBody.trim().length === 0) {
    return { ok: false, error: 'messageBody must be a non-empty string' };
  }

  if (input.targetUserId !== undefined && typeof input.targetUserId !== 'string') {
    return { ok: false, error: 'targetUserId must be a string when provided' };
  }

  return {
    ok: true,
    value: {
      targetRoomId: input.targetRoomId.trim(),
      ...(input.targetUserId ? { targetUserId: input.targetUserId.trim() } : {}),
      messageBody: input.messageBody.trim()
    }
  };
}

function validateFileShareInput(input: unknown): ToolInputValidation<FileShareInput> {
  if (!isRecord(input)) {
    return { ok: false, error: 'input must be an object' };
  }

  for (const key of ['fileId', 'requesterId', 'targetRoomId', 'requestText'] as const) {
    const value = input[key];
    if (value !== undefined && typeof value !== 'string') {
      return { ok: false, error: `${key} must be a string when provided` };
    }
  }

  if (input.fileVersion !== undefined && typeof input.fileVersion !== 'number') {
    return { ok: false, error: 'fileVersion must be a number when provided' };
  }

  if (input.file !== undefined && !isRecord(input.file)) {
    return { ok: false, error: 'file must be an object when provided' };
  }

  if (typeof input.targetRoomId !== 'string' || input.targetRoomId.trim().length === 0) {
    return { ok: false, error: 'targetRoomId must be a non-empty string' };
  }

  if (typeof input.requesterId !== 'string' || input.requesterId.trim().length === 0) {
    return { ok: false, error: 'requesterId must be a non-empty string' };
  }

  if (typeof input.requestText !== 'string' || input.requestText.trim().length === 0) {
    return { ok: false, error: 'requestText must be a non-empty string' };
  }

  return {
    ok: true,
    value: {
      ...(typeof input.fileId === 'string' && input.fileId.trim() ? { fileId: input.fileId.trim() } : {}),
      ...(typeof input.fileVersion === 'number' ? { fileVersion: input.fileVersion } : {}),
      ...(isRecord(input.file) ? { file: input.file as unknown as FileItem } : {}),
      ...(typeof input.requesterId === 'string' && input.requesterId.trim()
        ? { requesterId: input.requesterId.trim() }
        : {}),
      ...(typeof input.targetRoomId === 'string' && input.targetRoomId.trim()
        ? { targetRoomId: input.targetRoomId.trim() }
        : {}),
      ...(typeof input.requestText === 'string' && input.requestText.trim()
        ? { requestText: input.requestText.trim() }
        : {})
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
