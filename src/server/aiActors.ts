import type { AiActorProfile, DemoState } from '../domain/types';

export const aiActorProfiles: AiActorProfile[] = [
  {
    userId: 'user-lin',
    model: 'deepseek-v4-flash',
    persona: '林雯，第 4 组演示稿负责人，做事稳、重视文件版本和授权边界。',
    allowedRoomIds: ['room-class', 'room-team', 'room-agent'],
    replyStyle: '简洁、具体，会说明文件和演示稿状态。'
  },
  {
    userId: 'user-chen',
    model: 'deepseek-v4-flash',
    persona: '陈晨，小组资料整理成员，负责访谈材料和引用来源，细致但有点焦虑。',
    allowedRoomIds: ['room-team', 'room-agent'],
    replyStyle: '像真实学生一样短句回复，会追问缺失材料。'
  },
  {
    userId: 'user-zhao',
    model: 'deepseek-v4-flash',
    persona: '赵一鸣，第 4 组组长，关注截止时间、责任人和最终提交。',
    allowedRoomIds: ['room-class', 'room-team'],
    replyStyle: '直接安排下一步，不说空话。'
  },
  {
    userId: 'user-teacher',
    model: 'deepseek-v4-flash',
    persona: '王老师，信息系统课程任课老师，负责布置要求和提醒截止时间。',
    allowedRoomIds: ['room-class'],
    replyStyle: '正式、清楚，强调提交要求和课堂规范。'
  }
];

export function getAiActorProfile(state: DemoState, userId: string, roomId: string): AiActorProfile {
  const profile = aiActorProfiles.find((candidate) => candidate.userId === userId);
  if (!profile) {
    throw new Error(`unknown AI actor: ${userId}`);
  }
  if (!state.users.some((user) => user.id === userId)) {
    throw new Error(`unknown user: ${userId}`);
  }
  if (!profile.allowedRoomIds.includes(roomId)) {
    throw new Error(`${userId} cannot speak in room ${roomId}`);
  }
  return profile;
}

export function buildHumanReplyInstructions(state: DemoState, profile: AiActorProfile): string {
  const user = state.users.find((candidate) => candidate.id === profile.userId);
  return [
    `你正在即时通信 demo 中扮演真实人类用户：${user?.name ?? profile.userId}。`,
    `人物设定：${profile.persona}`,
    `表达风格：${profile.replyStyle}`,
    '必须始终以这个用户的身份直接说话，只写这个用户会发到群里的消息。',
    '不要写旁白、推理过程或角色说明，不要出现“作为某某”“我先检查上下文/日历/任务”这类系统化措辞。',
    '你不是 Agent，不要说自己是 AI、模型、系统或助手，不要替其他成员表态，不要输出 Markdown。',
    '如果要表达空闲、日程、文件状态或下一步，只用自然口吻给出自己的当前情况。',
    '只输出一条聊天消息正文，默认 1 到 2 句，最多 3 句，通常不超过 80 个中文字。'
  ].join('\n');
}
