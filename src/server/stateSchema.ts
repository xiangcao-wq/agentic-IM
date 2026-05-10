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
  'agentGoalPlans',
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
    agentGoalPlans: normalized.agentGoalPlans,
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
  if (candidate.agentGoalPlans === undefined) {
    candidate.agentGoalPlans = [];
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

  candidate.users = upgradeUserCollaborationProfiles(candidate.users as unknown[]);

  return value as DemoState;
}

function upgradeUserCollaborationProfiles(users: unknown[]): DemoState['users'] {
  return users.map((user) => {
    if (!user || typeof user !== 'object') {
      return user;
    }
    const candidate = user as DemoState['users'][number];
    const profile = defaultCollaborationProfiles[candidate.id];
    if (!profile || candidate.collaborationProfile) {
      return candidate;
    }
    return {
      ...candidate,
      collaborationProfile: profile
    };
  }) as DemoState['users'];
}

const defaultCollaborationProfiles: Record<string, NonNullable<DemoState['users'][number]['collaborationProfile']>> = {
  'user-lin': {
    responsibility: '演示稿结构、课堂展示和最终视觉表达',
    currentFocus: '等陈晨补齐访谈截图后更新演示稿第 5 页和结论页',
    availability: '今天 18:30 后离线，19:30-21:30 是演示稿专注时间',
    assistantScope: ['查找授权文件', '代发演示稿', '发起日程协商']
  },
  'user-chen': {
    responsibility: '访谈材料、引用来源和流程截图',
    currentFocus: '补齐访谈纪要、截图和引用一致性',
    availability: '当前在线，但 21:00 前需要集中补材料',
    assistantScope: ['回答材料进度', '查找访谈文件', '参与日程协商']
  },
  'user-zhao': {
    responsibility: '任务拆分、最终提交和报告结构收口',
    currentFocus: '核对行动计划与报告结构，准备最终 PDF',
    availability: '当前忙碌，16:00 后集中复核报告结构',
    assistantScope: ['检查任务状态', '提醒截止时间', '发起合稿协调']
  },
  'user-teacher': {
    responsibility: '课程要求、评分边界和答疑安排',
    currentFocus: '等待各组按要求提交调研报告和 8 分钟演示稿',
    availability: '课程答疑时间为 5月8日 10:00',
    assistantScope: ['检索课程要求', '回答截止时间', '提醒评分边界']
  }
};

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
