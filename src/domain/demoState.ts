import type { DemoState } from './types';

export function createDemoState(): DemoState {
  return {
    users: [
      {
        id: 'user-lin',
        name: '林雯',
        role: '演示稿负责人',
        avatar: 'LW',
        status: 'offline',
        agentId: 'agent-lin',
        matrixUserId: '@lin:localhost'
      },
      {
        id: 'user-chen',
        name: '陈晨',
        role: '资料整理',
        avatar: 'CC',
        status: 'online',
        agentId: 'agent-chen',
        matrixUserId: '@chen:localhost'
      },
      {
        id: 'user-zhao',
        name: '赵一鸣',
        role: '组长',
        avatar: 'ZY',
        status: 'busy',
        agentId: 'agent-zhao',
        matrixUserId: '@zhao:localhost'
      },
      {
        id: 'user-teacher',
        name: '王老师',
        role: '任课老师',
        avatar: 'WR',
        status: 'online',
        agentId: 'agent-teacher',
        matrixUserId: '@teacher:localhost'
      }
    ],
    agents: [
      {
        id: 'agent-lin',
        ownerId: 'user-lin',
        displayName: '林雯的 Agent',
        autonomy: 'risk_evaluated',
        allowedRoomIds: ['room-class', 'room-team'],
        allowedToolIds: ['room_search', 'file_share', 'task_update', 'calendar_suggest']
      },
      {
        id: 'agent-chen',
        ownerId: 'user-chen',
        displayName: '陈晨的 Agent',
        autonomy: 'risk_evaluated',
        allowedRoomIds: ['room-team'],
        allowedToolIds: ['room_search', 'calendar_suggest']
      },
      {
        id: 'agent-zhao',
        ownerId: 'user-zhao',
        displayName: '赵一鸣的 Agent',
        autonomy: 'risk_evaluated',
        allowedRoomIds: ['room-class', 'room-team'],
        allowedToolIds: ['room_search', 'task_update']
      },
      {
        id: 'agent-teacher',
        ownerId: 'user-teacher',
        displayName: '王老师的 Agent',
        autonomy: 'risk_evaluated',
        allowedRoomIds: ['room-class'],
        allowedToolIds: ['room_search']
      }
    ],
    rooms: [
      {
        id: 'room-class',
        name: '信息系统 2 班',
        type: 'class',
        memberIds: ['user-lin', 'user-chen', 'user-zhao', 'user-teacher'],
        unreadCount: 36,
        matrixAlias: '#is-class-2:demo.local'
      },
      {
        id: 'room-team',
        name: '调研报告第 4 组',
        type: 'team',
        memberIds: ['user-lin', 'user-chen', 'user-zhao'],
        unreadCount: 8,
        matrixAlias: '#research-team-4:demo.local'
      },
      {
        id: 'room-agent',
        name: 'Agent 协调记录',
        type: 'direct',
        memberIds: ['user-lin', 'user-chen'],
        unreadCount: 2,
        matrixAlias: '#agent-handshake:demo.local'
      }
    ],
    messages: [
      {
        id: 'msg-01',
        roomId: 'room-class',
        senderId: 'user-teacher',
        senderName: '王老师',
        body: '这次信息系统课程作业以小组为单位提交，主题是“校园服务数字化调研”。',
        sentAt: '2026-05-04T09:12:00+08:00',
        type: 'text'
      },
      {
        id: 'msg-02',
        roomId: 'room-class',
        senderId: 'user-teacher',
        senderName: '王老师',
        body: '截止时间是 5月12日 23:59，需要提交调研报告 PDF 和 8 分钟课堂演示稿。',
        sentAt: '2026-05-04T09:15:00+08:00',
        type: 'text'
      },
      {
        id: 'msg-03',
        roomId: 'room-class',
        senderId: 'user-zhao',
        senderName: '赵一鸣',
        body: '我们组按老师要求做调研报告，我来负责最终提交，林雯整理演示稿，陈晨补充访谈材料。',
        sentAt: '2026-05-04T10:24:00+08:00',
        type: 'text'
      },
      {
        id: 'msg-04',
        roomId: 'room-team',
        senderId: 'user-zhao',
        senderName: '赵一鸣',
        body: '今晚先不改结构了，周二 20:30 前我们做最后一次合稿检查。',
        sentAt: '2026-05-04T13:20:00+08:00',
        type: 'text'
      },
      {
        id: 'msg-05',
        roomId: 'room-team',
        senderId: 'user-lin',
        senderName: '林雯',
        body: '我已经把演示稿 v3 上传到文件库，允许我的 Agent 在我离线时发给本组成员。',
        sentAt: '2026-05-04T13:42:00+08:00',
        type: 'text'
      },
      {
        id: 'msg-06',
        roomId: 'room-team',
        senderId: 'user-chen',
        senderName: '陈晨',
        body: '我晚点补访谈材料。林雯不在线的话，能把最新演示稿发一下吗？',
        sentAt: '2026-05-04T14:05:00+08:00',
        type: 'text'
      },
      {
        id: 'msg-07',
        roomId: 'room-agent',
        senderId: 'user-chen',
        senderName: '陈晨的 Agent',
        body: '请求林雯的 Agent 确认：演示稿最新版是否可以发给陈晨？',
        sentAt: '2026-05-04T14:06:00+08:00',
        type: 'agent',
        agentLabel: '陈晨的 Agent'
      }
    ],
    files: [
      {
        id: 'file-brief',
        name: '信息系统课程作业要求.pdf',
        uploaderId: 'user-teacher',
        version: 1,
        roomId: 'room-class',
        updatedAt: '2026-05-04T09:16:00+08:00',
        visibility: 'room',
        agentCanShare: true,
        tags: ['作业要求', '截止日期', '调研报告'],
        summary: '作业要求：5月12日 23:59 前提交调研报告 PDF 和课堂演示稿。'
      },
      {
        id: 'file-slides-v2',
        name: '第4组-校园服务数字化调研-演示稿-v2.pptx',
        uploaderId: 'user-lin',
        version: 2,
        roomId: 'room-team',
        updatedAt: '2026-05-03T22:10:00+08:00',
        visibility: 'room',
        agentCanShare: true,
        tags: ['演示稿', '旧版本'],
        summary: '演示稿第二版，访谈部分仍需补充。'
      },
      {
        id: 'file-slides-v3',
        name: '第4组-校园服务数字化调研-演示稿-v3.pptx',
        uploaderId: 'user-lin',
        version: 3,
        roomId: 'room-team',
        updatedAt: '2026-05-04T13:40:00+08:00',
        visibility: 'room',
        agentCanShare: true,
        tags: ['演示稿', '最新版本', '可代发'],
        summary: '林雯上传的最新演示稿，已授权 Agent 在本组范围内代发。'
      },
      {
        id: 'file-private-notes',
        name: '林雯个人答辩备注.md',
        uploaderId: 'user-lin',
        version: 1,
        roomId: 'room-team',
        updatedAt: '2026-05-04T13:48:00+08:00',
        visibility: 'owner',
        agentCanShare: false,
        tags: ['个人备注'],
        summary: '仅林雯可见的个人答辩备注，不允许 Agent 代发。'
      }
    ],
    tasks: [
      {
        id: 'task-report',
        title: '提交调研报告 PDF',
        deadline: '5月12日 23:59',
        owners: ['赵一鸣'],
        status: 'in_progress',
        sourceMessageId: 'msg-02'
      },
      {
        id: 'task-slides',
        title: '整理并确认课堂演示稿',
        deadline: '5月12日 23:59',
        owners: ['林雯'],
        status: 'in_progress',
        sourceMessageId: 'msg-03'
      },
      {
        id: 'task-check',
        title: '最后一次合稿检查',
        deadline: '周二 20:30',
        owners: ['林雯', '陈晨', '赵一鸣'],
        status: 'pending',
        sourceMessageId: 'msg-04'
      }
    ],
    calendar: [
      {
        id: 'cal-review',
        title: '第 4 组最后一次合稿检查',
        startsAt: '2026-05-05T20:30:00+08:00',
        roomId: 'room-team',
        attendees: ['user-lin', 'user-chen', 'user-zhao'],
        sourceTaskId: 'task-check'
      }
    ],
    actionLogs: [
      {
        id: 'log-seed-01',
        agentId: 'agent-lin',
        roomId: 'room-team',
        action: '监听到组员请求最新演示稿，等待风险评估',
        status: 'executed',
        risk: {
          level: 'low',
          score: 0.18,
          reason: '请求来自同组成员，目标文件已被上传者授权在本组内由 Agent 代发。',
          model: 'risk-mini-v1'
        },
        contextIds: ['msg-05', 'msg-06', 'file-slides-v3'],
        toolCalls: ['room_search'],
        createdAt: '2026-05-04T14:05:30+08:00'
      }
    ],
    actionRequests: [],
    memories: [],
    matrixObserverCheckpoints: [],
    aiAutoreplyPolicies: [
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
    ],
    aiReplyJobs: []
  };
}
