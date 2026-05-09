import { buildAgentContextBundle, buildShortTermContext } from '../domain/memory';
import { sortMessagesChronologically } from '../domain/messages';
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
          buildAiHumanReplyContext(nextState, profile.userId, input.triggerMessage),
          '',
          '## Trigger message',
          `${input.triggerMessage.senderName}: ${input.triggerMessage.body}`,
          '',
          'Reply as this real user in the current chat. Continue the task handoff directly and do not explain that you are AI.'
        ].join('\n\n'),
        maxOutputTokens: 120
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

export function recordSkippedAiAutoreplies(input: {
  state: DemoState;
  triggerMessage: Message;
  reason: string;
}): {
  state: DemoState;
  jobs: AiReplyJob[];
} {
  const policies = selectAutoreplyPolicies(input.state, input.triggerMessage);
  const now = new Date().toISOString();
  const jobs = policies.slice(0, 1).map(
    (policy): AiReplyJob => ({
      id: `ai-reply-job-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      roomId: input.triggerMessage.roomId,
      targetUserId: policy.userId,
      triggeringMessageId: input.triggerMessage.id,
      status: 'skipped',
      reason: input.reason,
      createdAt: now,
      updatedAt: now
    })
  );

  if (jobs.length === 0) {
    return { state: input.state, jobs };
  }

  return {
    state: {
      ...input.state,
      aiReplyJobs: [...jobs, ...input.state.aiReplyJobs]
    },
    jobs
  };
}

function buildAiHumanReplyContext(state: DemoState, userId: string, triggerMessage: Message): string {
  const user = state.users.find((candidate) => candidate.id === userId);
  if (user?.agentId) {
    try {
      return buildAgentContextBundle(state, {
        roomId: triggerMessage.roomId,
        agentId: user.agentId,
        userText: triggerMessage.body,
        focus: 'chat'
      }).text;
    } catch {
      // Fallback keeps the reply available if an actor profile and agent permissions diverge.
    }
  }
  return buildShortTermContext(state, triggerMessage.roomId);
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
  return sortMessagesChronologically([...messages.filter((candidate) => candidate.id !== message.id), message]);
}
