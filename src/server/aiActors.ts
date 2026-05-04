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
    '你不是 Agent，不要说自己是 AI，不要输出 Markdown。',
    '只输出一条聊天消息正文，长度 1 到 3 句。'
  ].join('\n');
}
