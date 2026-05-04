import { buildShortTermContext } from '../domain/memory';
import type { AgentActionLog, AiAutoreplyPolicy, AiReplyJob, DemoState, Message } from '../domain/types';
import { buildHumanReplyInstructions, getAiActorProfile } from './aiActors';
import type { AiProvider } from './aiProvider';

interface RunAiAutorepliesInput {
  state: DemoState;
  triggerMessage: Message;
  aiProvider: AiProvider;
  sendMessage(state: DemoState, input: { roomId: string; senderId: string; body: string }): Promise<Message>;
}

export async function runAiAutoreplies(input: RunAiAutorepliesInput): Promise<{
  state: DemoState;
  messages: Message[];
  jobs: AiReplyJob[];
}> {
  const policies = selectAutoreplyPolicies(input.state, input.triggerMessage);
  let nextState = input.state;
  const messages: Message[] = [];
  const jobs: AiReplyJob[] = [];

  for (const policy of policies.slice(0, 1)) {
    const now = new Date().toISOString();
    const pendingJob: AiReplyJob = {
      id: `ai-reply-job-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      roomId: input.triggerMessage.roomId,
      targetUserId: policy.userId,
      triggeringMessageId: input.triggerMessage.id,
      status: 'pending',
      reason: policy.triggerMode === 'mentions_only' ? 'mentioned actor in room message' : 'room auto reply policy',
      createdAt: now,
      updatedAt: now
    };

    try {
      const profile = getAiActorProfile(nextState, policy.userId, input.triggerMessage.roomId);
      const text = await input.aiProvider.generateText({
        actorRole: 'human_user',
        actorId: policy.userId,
        instructions: buildHumanReplyInstructions(nextState, profile),
        input: [
          '你正在模拟真实聊天：对方不在线时，你作为这个用户继续完成任务对接。直接回复当前消息，不要解释自己是 AI。',
          `触发消息：${input.triggerMessage.senderName}：${input.triggerMessage.body}`,
          buildShortTermContext(nextState, input.triggerMessage.roomId)
        ].join('\n\n'),
        maxOutputTokens: 180
      });
      const reply = await input.sendMessage(nextState, {
        roomId: input.triggerMessage.roomId,
        senderId: policy.userId,
        body: text
      });
      const completedJob: AiReplyJob = {
        ...pendingJob,
        status: 'completed',
        replyMessageId: reply.id,
        updatedAt: new Date().toISOString()
      };
      const log = createAutoreplyLog(policy, input.triggerMessage, reply);

      nextState = {
        ...nextState,
        messages: appendMessage(nextState.messages, reply),
        aiReplyJobs: [completedJob, ...nextState.aiReplyJobs],
        actionLogs: [log, ...nextState.actionLogs]
      };
      messages.push(reply);
      jobs.push(completedJob);
    } catch (error) {
      const failedJob: AiReplyJob = {
        ...pendingJob,
        status: 'failed',
        reason: error instanceof Error ? error.message : 'unknown autoreply error',
        updatedAt: new Date().toISOString()
      };
      nextState = {
        ...nextState,
        aiReplyJobs: [failedJob, ...nextState.aiReplyJobs]
      };
      jobs.push(failedJob);
    }
  }

  return { state: nextState, messages, jobs };
}

function selectAutoreplyPolicies(state: DemoState, message: Message): AiAutoreplyPolicy[] {
  if (message.type !== 'text' || message.agentLabel || message.sourceAgentId) {
    return [];
  }

  const room = state.rooms.find((candidate) => candidate.id === message.roomId);
  if (!room) {
    return [];
  }

  const eligible = state.aiAutoreplyPolicies
    .filter((policy) => policy.enabled)
    .filter((policy) => policy.userId !== message.senderId)
    .filter((policy) => policy.allowedRoomIds.includes(message.roomId))
    .filter((policy) => room.memberIds.includes(policy.userId))
    .filter((policy) => !isCoolingDown(state, policy, message.roomId));

  const mentioned = eligible.filter((policy) => isMentioned(state, policy.userId, message.body));
  const candidates = mentioned.length > 0 ? mentioned : eligible.filter((policy) => policy.triggerMode === 'all_messages');
  return [...candidates].sort((a, b) => a.priority - b.priority);
}

function isMentioned(state: DemoState, userId: string, text: string): boolean {
  const user = state.users.find((candidate) => candidate.id === userId);
  if (!user) {
    return false;
  }
  return text.includes(user.name) || text.includes(`@${user.name}`) || text.includes(user.avatar);
}

function isCoolingDown(state: DemoState, policy: AiAutoreplyPolicy, roomId: string): boolean {
  if (policy.cooldownMs <= 0) {
    return false;
  }
  const latest = state.aiReplyJobs
    .filter((job) => job.targetUserId === policy.userId && job.roomId === roomId && job.status === 'completed')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!latest) {
    return false;
  }
  return Date.now() - new Date(latest.updatedAt).getTime() < policy.cooldownMs;
}

function createAutoreplyLog(policy: AiAutoreplyPolicy, trigger: Message, reply: Message): AgentActionLog {
  return {
    id: `log-ai-autoreply-${policy.userId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    agentId: `actor-${policy.userId}`,
    roomId: trigger.roomId,
    action: `ai_autoreply:${policy.userId}`,
    status: 'executed',
    risk: {
      level: 'low',
      score: 0.18,
      reason: 'AI human actor replied to a user message under room autoreply policy.',
      model: 'ai-autoreply-policy-v1'
    },
    contextIds: [trigger.id, reply.id],
    toolCalls: ['deepseek.flash.chat.completions', 'matrix.send_event'],
    createdAt: new Date().toISOString()
  };
}

function appendMessage(messages: Message[], message: Message): Message[] {
  return [...messages.filter((candidate) => candidate.id !== message.id), message].sort((a, b) =>
    a.sentAt.localeCompare(b.sentAt)
  );
}
