import type { DemoState, FileItem, RiskAssessment } from '../../domain/types';

export type PolicyOutcome = 'allow' | 'deny' | 'require_confirmation';

export interface PolicyDecision {
  outcome: PolicyOutcome;
  risk: RiskAssessment;
  reasons: string[];
  requiredReviewerIds?: string[];
}

export interface MessageSendPolicyInput {
  agent: DemoState['agents'][number];
  targetRoomId: string;
  targetUserId?: string;
  messageBody: string;
}

export interface FileSharePolicyInput {
  agent: DemoState['agents'][number];
  sourceRoomId: string;
  targetRoomId: string;
  requesterId: string;
  requestText: string;
  file?: FileItem;
}

export function assessMessageSendPolicy(state: DemoState, input: MessageSendPolicyInput): PolicyDecision {
  const targetRoom = state.rooms.find((room) => room.id === input.targetRoomId);
  const targetUser = input.targetUserId
    ? state.users.find((user) => user.id === input.targetUserId)
    : undefined;
  const owner = state.users.find((user) => user.id === input.agent.ownerId);
  const reasons: string[] = [];

  if (!owner) {
    reasons.push('owner_not_found');
    return deny(reasons, 'Agent owner cannot be verified.');
  }

  if (!targetRoom) {
    reasons.push('target_room_missing');
    return deny(reasons, 'Target room does not exist, so the delegated message is blocked.');
  }

  if (!input.agent.allowedRoomIds.includes(input.targetRoomId)) {
    reasons.push('target_room_not_authorized');
    return deny(reasons, 'Target room is outside the agent authorization scope.');
  }

  if (!targetRoom.memberIds.includes(input.agent.ownerId)) {
    reasons.push('owner_not_room_member');
    return deny(reasons, 'Agent owner is not a member of the target room.');
  }

  if (input.targetUserId && !targetUser) {
    reasons.push('target_user_not_found');
    return deny(reasons, 'Target user cannot be verified.');
  }

  reasons.push('target_room_authorized');

  if (isSensitiveOrLongMessage(input.messageBody)) {
    reasons.push('sensitive_or_long_content');
    return {
      outcome: 'require_confirmation',
      risk: {
        level: 'medium',
        score: 0.56,
        reason: 'Delegated message content is sensitive or long and needs human confirmation.',
        model: 'policy-engine-v1'
      },
      reasons,
      requiredReviewerIds: [input.agent.ownerId]
    };
  }

  reasons.push('ordinary_collaboration_message');
  return {
    outcome: 'allow',
    risk: {
      level: 'low',
      score: 0.16,
      reason: 'Target room is authorized and the content is an ordinary collaboration message.',
      model: 'policy-engine-v1'
    },
    reasons
  };
}

export function assessFileSharePolicy(state: DemoState, input: FileSharePolicyInput): PolicyDecision {
  const sourceRoom = state.rooms.find((room) => room.id === input.sourceRoomId);
  const targetRoom = state.rooms.find((room) => room.id === input.targetRoomId);
  const requester = state.users.find((user) => user.id === input.requesterId);
  const owner = state.users.find((user) => user.id === input.agent.ownerId);
  const reasons: string[] = [];

  if (!owner) {
    reasons.push('owner_not_found');
    return deny(reasons, 'Agent owner cannot be verified.');
  }

  if (!sourceRoom || !input.agent.allowedRoomIds.includes(input.sourceRoomId)) {
    reasons.push('source_room_not_authorized');
    return deny(reasons, 'Source room is outside the agent authorization scope.');
  }

  if (!targetRoom || !input.agent.allowedRoomIds.includes(input.targetRoomId)) {
    reasons.push('target_room_not_authorized');
    return deny(reasons, 'Target room is outside the agent authorization scope.');
  }

  if (!targetRoom.memberIds.includes(input.agent.ownerId)) {
    reasons.push('owner_not_target_room_member');
    return deny(reasons, 'Agent owner is not a member of the target room.');
  }

  if (!requester) {
    reasons.push('requester_not_found');
    return requireConfirmation(reasons, 'Requester cannot be verified.', 'high', 0.86, input.agent.ownerId);
  }

  if (!input.file) {
    reasons.push('no_matching_authorized_file');
    return requireConfirmation(
      reasons,
      'No matching authorized file was found for this share request.',
      'high',
      0.86,
      input.agent.ownerId
    );
  }

  if (input.file.uploaderId !== input.agent.ownerId || input.file.roomId !== input.sourceRoomId) {
    reasons.push('file_outside_agent_owner_boundary');
    return deny(reasons, 'Selected file is outside the agent owner or source-room boundary.');
  }

  if (input.file.visibility !== 'room' || !input.file.agentCanShare) {
    reasons.push('file_not_agent_shareable');
    return deny(reasons, 'Selected file is not authorized for agent sharing.');
  }

  reasons.push('file_authorized_for_agent');

  if (!hasDownloadableFileBacking(input.file)) {
    reasons.push('missing_downloadable_file_backing');
    return requireConfirmation(
      reasons,
      'Selected file is authorized but lacks Matrix or local downloadable backing.',
      'medium',
      0.58,
      input.agent.ownerId
    );
  }

  reasons.push('downloadable_file_backing');

  if (!input.file.contentType || !input.file.size) {
    reasons.push('missing_media_metadata');
    return requireConfirmation(
      reasons,
      'Selected file has downloadable backing but is missing media metadata.',
      'medium',
      0.55,
      input.agent.ownerId
    );
  }

  if (input.targetRoomId !== input.sourceRoomId) {
    reasons.push('cross_room_file_share');
    return requireConfirmation(
      reasons,
      'Target room differs from the source room, so cross-room file sharing needs human confirmation.',
      'medium',
      0.58,
      input.agent.ownerId
    );
  }

  if (!looksLikeExplicitFileShareRequest(input.requestText)) {
    reasons.push('ambiguous_file_share_intent');
    return requireConfirmation(
      reasons,
      'The request does not clearly ask the agent to send or share the file.',
      'medium',
      0.48,
      input.agent.ownerId
    );
  }

  return {
    outcome: 'allow',
    risk: {
      level: 'low',
      score: 0.16,
      reason: 'File is room-visible, agent-shareable, downloadable, and stays inside the source room.',
      model: 'policy-engine-v1'
    },
    reasons
  };
}

function deny(reasons: string[], reason: string): PolicyDecision {
  return {
    outcome: 'deny',
    risk: {
      level: 'high',
      score: 0.9,
      reason,
      model: 'policy-engine-v1'
    },
    reasons
  };
}

function requireConfirmation(
  reasons: string[],
  reason: string,
  level: 'medium' | 'high',
  score: number,
  ownerId: string
): PolicyDecision {
  return {
    outcome: 'require_confirmation',
    risk: {
      level,
      score,
      reason,
      model: 'policy-engine-v1'
    },
    reasons,
    requiredReviewerIds: [ownerId]
  };
}

function hasDownloadableFileBacking(file: FileItem): boolean {
  return Boolean(file.mxcUri || file.localPath);
}

function looksLikeExplicitFileShareRequest(text: string): boolean {
  const lowered = text.toLowerCase();
  return (
    includesAny(text, ['发送', '发给', '发一下', '分享', '转发', '代发', '传给', '把', '最新']) ||
    includesAny(lowered, ['send', 'share', 'forward', 'latest'])
  );
}

function isSensitiveOrLongMessage(messageBody: string): boolean {
  return (
    messageBody.length > 500 ||
    includesAny(messageBody.toLowerCase(), [
      'password',
      'token',
      'secret',
      'api key',
      'private key',
      'credential'
    ])
  );
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}
