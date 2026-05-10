import type {
  AgentRunResult,
  ChatResult,
  CoordinationResult,
  DeadlineAnswer,
  FileShareAction,
  RoomSummary,
  SendMessageAction,
  WebSearchAnswer
} from './types';

export function isRoomSummary(value: AgentRunResult['result']): value is RoomSummary {
  return Boolean(value && 'headline' in value && 'todos' in value);
}

export function isDeadlineAnswer(value: AgentRunResult['result']): value is DeadlineAnswer {
  return Boolean(value && 'answer' in value && 'citations' in value && !('results' in value));
}

export function isWebSearchAnswer(value: AgentRunResult['result']): value is WebSearchAnswer {
  return Boolean(value && 'answer' in value && 'results' in value && 'citations' in value);
}

export function isFileShareAction(value: AgentRunResult['result']): value is FileShareAction {
  return Boolean(value && 'file' in value && 'risk' in value && !('proposedPlan' in value));
}

export function isSendMessageAction(value: AgentRunResult['result']): value is SendMessageAction {
  return Boolean(value && 'messageBody' in value && 'targetRoomId' in value && 'risk' in value);
}

export function isCoordinationResult(value: AgentRunResult['result']): value is CoordinationResult {
  return Boolean(value && 'proposedPlan' in value);
}

export function isChatResult(value: AgentRunResult['result']): value is ChatResult {
  return Boolean(value && 'reply' in value);
}
