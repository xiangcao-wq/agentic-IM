import type { DemoState } from './types';

const interviewNotesText = [
  '校园服务数字化调研 - 访谈纪要 v1',
  '',
  '访谈对象：校园服务中心值班老师、两名学生志愿者。',
  '核心发现：学生最关心报修进度透明、服务入口分散、通知到达率。',
  '可引用观点：如果系统能把报修、预约、反馈集中在一个入口，会减少重复询问。',
  '引用一致性需要陈晨核对：访谈纪要里的服务入口描述，要和行动计划、报告正文、演示稿第 5 页保持一致。',
  '待补充：陈晨需要在 5月10日 21:00 前补一张流程截图。'
].join('\n');

const actionPlanText = [
  '# 第4组行动计划',
  '',
  '- 今天优先处理访谈材料：陈晨补齐访谈纪要、引用来源和流程截图。',
  '- 林雯根据访谈材料更新演示稿 v3 的“服务入口分散”页。',
  '- 赵一鸣负责最终报告 PDF 和 5月12日 23:59 前提交。',
  '- 文件代发规则：只有 room 可见、agentCanShare=true、且有真实媒体元数据的文件才能自动发送。',
  '- 日程或任务状态变更必须进入确认队列，确认前不改内部数据。'
].join('\n');

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
        unreadCount: 12,
        matrixAlias: '#is-class-2:demo.local'
      },
      {
        id: 'room-team',
        name: '调研报告第 4 组',
        type: 'team',
        memberIds: ['user-lin', 'user-chen', 'user-zhao'],
        unreadCount: 10,
        matrixAlias: '#research-team-4:demo.local'
      },
      {
        id: 'room-agent',
        name: 'Agent 协调记录',
        type: 'direct',
        memberIds: ['user-lin', 'user-chen'],
        unreadCount: 3,
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
        id: 'msg-class-rubric',
        roomId: 'room-class',
        senderId: 'user-teacher',
        senderName: '王老师',
        body: '报告要写清楚访谈对象、现状痛点、改进方案、风险边界和引用来源，演示稿只讲最关键的 8 分钟内容。',
        sentAt: '2026-05-04T09:18:00+08:00',
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
        id: 'msg-class-agent-boundary',
        roomId: 'room-class',
        senderId: 'user-teacher',
        senderName: '王老师',
        body: '如果你们用 Agent 辅助协作，只能处理授权群内的信息；个人备注、私聊和未授权文件不要让 Agent 代发。',
        sentAt: '2026-05-04T10:40:00+08:00',
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
        agentLabel: '陈晨的 Agent',
        sourceAgentId: 'agent-chen'
      },
      {
        id: 'msg-agent-file-gate',
        roomId: 'room-agent',
        senderId: 'user-lin',
        senderName: '林雯的 Agent',
        body: '已评估：陈晨是同组成员、演示稿 v3 已授权，但当前文件只有元数据，没有 Matrix media backing，不能自动代发。',
        sentAt: '2026-05-04T14:08:00+08:00',
        type: 'agent',
        agentLabel: '林雯的 Agent',
        sourceAgentId: 'agent-lin'
      },
      {
        id: 'msg-08',
        roomId: 'room-team',
        senderId: 'user-chen',
        senderName: '陈晨',
        body: '第4组-访谈纪要-v1.txt',
        sentAt: '2026-05-04T14:12:00+08:00',
        type: 'file',
        fileId: 'file-interview-notes-txt',
        contentType: 'text/plain; charset=utf-8',
        size: byteLength(interviewNotesText)
      },
      {
        id: 'msg-09',
        roomId: 'room-team',
        senderId: 'user-chen',
        senderName: '陈晨',
        body: '访谈纪要 v1 已经放进文件库，我标了“引用一致性”这一段，今晚会继续补流程截图。',
        sentAt: '2026-05-04T14:18:00+08:00',
        type: 'text'
      },
      {
        id: 'msg-10',
        roomId: 'room-team',
        senderId: 'user-zhao',
        senderName: '赵一鸣',
        body: '今天优先级：陈晨先补访谈材料和引用来源，林雯等材料稳定后再更新演示稿，我负责把报告结构收口。',
        sentAt: '2026-05-04T14:25:00+08:00',
        type: 'text'
      },
      {
        id: 'msg-11',
        roomId: 'room-team',
        senderId: 'user-chen',
        senderName: '陈晨',
        body: '我负责访谈材料和引用来源，目标是 5月10日 21:00 前把纪要、截图和引用对齐补完。',
        sentAt: '2026-05-04T14:36:00+08:00',
        type: 'text'
      },
      {
        id: 'msg-12',
        roomId: 'room-team',
        senderId: 'user-lin',
        senderName: '林雯',
        body: '收到。我会等陈晨的访谈截图稳定后，把演示稿 v3 的第 5 页和结论页一起更新。',
        sentAt: '2026-05-04T14:48:00+08:00',
        type: 'text'
      },
      {
        id: 'msg-13',
        roomId: 'room-team',
        senderId: 'user-zhao',
        senderName: '赵一鸣',
        body: '第4组-行动计划-工作清单.md',
        sentAt: '2026-05-04T15:18:00+08:00',
        type: 'file',
        fileId: 'file-action-plan-md',
        contentType: 'text/markdown; charset=utf-8',
        size: byteLength(actionPlanText)
      },
      {
        id: 'msg-14',
        roomId: 'room-team',
        senderId: 'user-zhao',
        senderName: '赵一鸣',
        body: '行动计划已经列出来：陈晨补访谈，林雯更新演示稿，我负责报告 PDF；周二 20:30 合稿检查不变。',
        sentAt: '2026-05-04T15:25:00+08:00',
        type: 'text'
      },
      {
        id: 'msg-agent-patch-gate',
        roomId: 'room-agent',
        senderId: 'user-zhao',
        senderName: '赵一鸣的 Agent',
        body: '记录：日程变更和任务状态更新只生成结构化 patch，必须人工确认后才会修改内部 calendar 或 tasks。',
        sentAt: '2026-05-04T15:30:00+08:00',
        type: 'agent',
        agentLabel: '赵一鸣的 Agent',
        sourceAgentId: 'agent-zhao'
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
        summary: '作业要求：5月12日 23:59 前提交调研报告 PDF 和课堂演示稿。',
        contentType: 'application/pdf',
        size: 184_000
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
        summary: '演示稿第二版，访谈部分仍需补充。',
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: 2_480_000
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
        summary: '林雯上传的最新演示稿，已授权 Agent 在本组范围内代发；当前种子态只有元数据，生成真实文件或上传后才能下载/自动发送。',
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: 2_860_000
      },
      {
        id: 'file-interview-notes-txt',
        name: '第4组-访谈纪要-v1.txt',
        uploaderId: 'user-chen',
        version: 1,
        roomId: 'room-team',
        updatedAt: '2026-05-04T14:12:00+08:00',
        visibility: 'room',
        agentCanShare: true,
        tags: ['访谈', '纪要', '引用一致性', 'text'],
        summary: '陈晨上传的访谈纪要文本，包含服务入口分散、报修进度透明和引用一致性备注。',
        contentType: 'text/plain; charset=utf-8',
        size: byteLength(interviewNotesText)
      },
      {
        id: 'file-action-plan-md',
        name: '第4组-行动计划-工作清单.md',
        uploaderId: 'user-zhao',
        version: 1,
        roomId: 'room-team',
        updatedAt: '2026-05-04T15:18:00+08:00',
        visibility: 'room',
        agentCanShare: true,
        tags: ['行动计划', '任务分工', 'markdown', 'text'],
        summary: '赵一鸣整理的工作清单：今天先补访谈材料，再更新演示稿，最后收口报告。',
        contentType: 'text/markdown; charset=utf-8',
        size: byteLength(actionPlanText)
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
        summary: '仅林雯可见的个人答辩备注，不允许 Agent 代发。',
        contentType: 'text/markdown; charset=utf-8',
        size: 920
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
        id: 'task-interview-materials',
        title: '补齐访谈材料和引用来源',
        deadline: '5月10日 21:00',
        owners: ['陈晨'],
        status: 'in_progress',
        sourceMessageId: 'msg-11'
      },
      {
        id: 'task-action-plan',
        title: '核对行动计划与报告结构',
        deadline: '5月6日 18:00',
        owners: ['赵一鸣', '陈晨'],
        status: 'pending',
        sourceMessageId: 'msg-14'
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
        id: 'cal-lin-focus-block',
        title: '林雯演示稿更新专注时间',
        startsAt: '2026-05-06T19:30:00+08:00',
        roomId: 'room-team',
        attendees: ['user-lin'],
        sourceTaskId: 'task-slides'
      },
      {
        id: 'cal-review',
        title: '第 4 组最后一次合稿检查',
        startsAt: '2026-05-05T20:30:00+08:00',
        roomId: 'room-team',
        attendees: ['user-lin', 'user-chen', 'user-zhao'],
        sourceTaskId: 'task-check'
      },
      {
        id: 'cal-interview-sync',
        title: '访谈材料截图同步',
        startsAt: '2026-05-10T21:00:00+08:00',
        roomId: 'room-team',
        attendees: ['user-chen', 'user-zhao'],
        sourceTaskId: 'task-interview-materials'
      },
      {
        id: 'cal-zhao-report-review',
        title: '赵一鸣报告结构复核',
        startsAt: '2026-05-07T16:00:00+08:00',
        roomId: 'room-team',
        attendees: ['user-zhao'],
        sourceTaskId: 'task-report'
      },
      {
        id: 'cal-teacher-office-hour',
        title: '王老师课程答疑',
        startsAt: '2026-05-08T10:00:00+08:00',
        roomId: 'room-class',
        attendees: ['user-teacher'],
        sourceTaskId: 'task-report'
      }
    ],
    fileTextChunks: [
      {
        id: 'chunk-interview-notes-txt-0',
        fileId: 'file-interview-notes-txt',
        roomId: 'room-team',
        uploaderId: 'user-chen',
        index: 0,
        text: interviewNotesText,
        createdAt: '2026-05-04T14:12:00+08:00'
      },
      {
        id: 'chunk-action-plan-md-0',
        fileId: 'file-action-plan-md',
        roomId: 'room-team',
        uploaderId: 'user-zhao',
        index: 0,
        text: actionPlanText,
        createdAt: '2026-05-04T15:18:00+08:00'
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
          reason: '请求来自同组成员，目标文件已被上传者授权在本组内由 Agent 代发；但种子文件缺少真实媒体元数据时不能自动发送。',
          model: 'risk-mini-v1'
        },
        contextIds: ['msg-05', 'msg-06', 'file-slides-v3'],
        toolCalls: ['room_search', 'file_library.lookup_latest'],
        createdAt: '2026-05-04T14:05:30+08:00'
      },
      {
        id: 'log-seed-02',
        agentId: 'agent-lin',
        roomId: 'room-team',
        action: '索引陈晨上传的访谈纪要文本片段',
        status: 'executed',
        risk: {
          level: 'low',
          score: 0.08,
          reason: '群内可见文本文件，仅进入授权上下文检索。',
          model: 'risk-mini-v1'
        },
        contextIds: ['file-interview-notes-txt', 'chunk-interview-notes-txt-0'],
        toolCalls: ['file_text.index'],
        createdAt: '2026-05-04T14:12:30+08:00'
      }
    ],
    actionRequests: [],
    a2aSessions: [],
    agentAutopilotPolicies: [
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
    ],
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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
