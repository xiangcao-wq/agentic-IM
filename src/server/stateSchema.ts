import type { AiAutoreplyPolicy, DemoState } from '../domain/types';

export const STATE_COLLECTION_KEYS = [
  'users',
  'agents',
  'rooms',
  'messages',
  'files',
  'fileTextChunks',
  'tasks',
  'calendar',
  'actionLogs',
  'actionRequests',
  'a2aSessions',
  'agentAutopilotPolicies',
  'memories',
  'matrixObserverCheckpoints',
  'aiAutoreplyPolicies',
  'aiReplyJobs'
] as const;

export type StateCollectionKey = (typeof STATE_COLLECTION_KEYS)[number];
export type StateCollections = Pick<DemoState, StateCollectionKey>;

export function getStateCollections(state: DemoState): StateCollections {
  const normalized = validateDemoStateShape(state);
  return {
    users: normalized.users,
    agents: normalized.agents,
    rooms: normalized.rooms,
    messages: normalized.messages,
    files: normalized.files,
    fileTextChunks: normalized.fileTextChunks,
    tasks: normalized.tasks,
    calendar: normalized.calendar,
    actionLogs: normalized.actionLogs,
    actionRequests: normalized.actionRequests,
    a2aSessions: normalized.a2aSessions,
    agentAutopilotPolicies: normalized.agentAutopilotPolicies,
    memories: normalized.memories,
    matrixObserverCheckpoints: normalized.matrixObserverCheckpoints,
    aiAutoreplyPolicies: normalized.aiAutoreplyPolicies,
    aiReplyJobs: normalized.aiReplyJobs
  };
}

export function validateDemoStateShape(value: unknown): DemoState {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid DemoState: expected object');
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.actionRequests === undefined) {
    candidate.actionRequests = [];
  }
  if (candidate.a2aSessions === undefined) {
    candidate.a2aSessions = [];
  }
  if (candidate.agentAutopilotPolicies === undefined) {
    candidate.agentAutopilotPolicies = createDefaultAgentAutopilotPolicies();
  }
  if (candidate.fileTextChunks === undefined) {
    candidate.fileTextChunks = [];
  }
  if (candidate.memories === undefined) {
    candidate.memories = [];
  }
  if (candidate.matrixObserverCheckpoints === undefined) {
    candidate.matrixObserverCheckpoints = [];
  }
  if (candidate.aiAutoreplyPolicies === undefined) {
    candidate.aiAutoreplyPolicies = createDefaultAiAutoreplyPolicies();
  }
  if (candidate.aiReplyJobs === undefined) {
    candidate.aiReplyJobs = [];
  }

  for (const key of STATE_COLLECTION_KEYS) {
    if (!Array.isArray(candidate[key])) {
      throw new Error(`Invalid DemoState.${key}: expected array`);
    }
  }

  return value as DemoState;
}

function createDefaultAgentAutopilotPolicies(): DemoState['agentAutopilotPolicies'] {
  return [
    {
      agentId: 'agent-lin',
      enabled: true,
      allowedRoomIds: ['room-team'],
      autoExecuteMaxRisk: 'low',
      allowedActions: [
        'reply',
        'search_files',
        'share_low_risk_files',
        'suggest_task_updates',
        'coordinate_schedule',
        'a2a_negotiate'
      ],
      updatedAt: '2026-05-04T12:00:00+08:00'
    },
    {
      agentId: 'agent-chen',
      enabled: false,
      allowedRoomIds: ['room-team', 'room-agent'],
      autoExecuteMaxRisk: 'low',
      allowedActions: ['reply', 'search_files', 'a2a_negotiate'],
      updatedAt: '2026-05-04T12:00:00+08:00'
    },
    {
      agentId: 'agent-zhao',
      enabled: false,
      allowedRoomIds: ['room-team', 'room-agent'],
      autoExecuteMaxRisk: 'low',
      allowedActions: ['reply', 'search_files', 'coordinate_schedule', 'a2a_negotiate'],
      updatedAt: '2026-05-04T12:00:00+08:00'
    }
  ];
}

function createDefaultAiAutoreplyPolicies(): AiAutoreplyPolicy[] {
  return [
    {
      userId: 'user-chen',
      enabled: true,
      allowedRoomIds: ['room-team'],
      triggerMode: 'all_messages',
      cooldownMs: 0,
      priority: 10
    },
    {
      userId: 'user-zhao',
      enabled: true,
      allowedRoomIds: ['room-team'],
      triggerMode: 'mentions_only',
      cooldownMs: 0,
      priority: 20
    },
    {
      userId: 'user-teacher',
      enabled: true,
      allowedRoomIds: ['room-class'],
      triggerMode: 'mentions_only',
      cooldownMs: 0,
      priority: 30
    }
  ];
}
