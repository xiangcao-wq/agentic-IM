import type { AgentRunIntent, AgentToolCall, AgentToolName } from '../domain/types';

export interface AgentToolDefinition {
  name: AgentToolName;
  sideEffect: 'read' | 'write';
  requiresRiskGate: boolean;
  description: string;
}

const toolDefinitions: Record<AgentToolName, AgentToolDefinition> = {
  'chat.answer': {
    name: 'chat.answer',
    sideEffect: 'read',
    requiresRiskGate: false,
    description: 'Answer directly from authorized context.'
  },
  'room.summarize': {
    name: 'room.summarize',
    sideEffect: 'read',
    requiresRiskGate: false,
    description: 'Summarize authorized room context.'
  },
  'deadline.answer': {
    name: 'deadline.answer',
    sideEffect: 'read',
    requiresRiskGate: false,
    description: 'Answer deadline questions from messages, tasks, files, and memory.'
  },
  'file.search': {
    name: 'file.search',
    sideEffect: 'read',
    requiresRiskGate: false,
    description: 'Search authorized room files without sending anything.'
  },
  'file.share': {
    name: 'file.share',
    sideEffect: 'write',
    requiresRiskGate: true,
    description: 'Share a real Matrix-backed authorized file or request confirmation.'
  },
  'web.search': {
    name: 'web.search',
    sideEffect: 'read',
    requiresRiskGate: false,
    description: 'Search public web information and return cited snippets without mutating internal state.'
  },
  'agent.coordinate': {
    name: 'agent.coordinate',
    sideEffect: 'write',
    requiresRiskGate: true,
    description: 'Coordinate schedule or task changes with another personal Agent.'
  },
  'task.suggest_update': {
    name: 'task.suggest_update',
    sideEffect: 'write',
    requiresRiskGate: true,
    description: 'Suggest a task update and require confirmation before mutation.'
  }
};

export function getAgentTool(name: AgentToolName): AgentToolDefinition {
  return toolDefinitions[name];
}

export function isAgentToolName(value: unknown): value is AgentToolName {
  return typeof value === 'string' && value in toolDefinitions;
}

export function defaultToolCallsForIntent(intent: AgentRunIntent, args: Record<string, unknown> = {}): AgentToolCall[] {
  const toolByIntent: Record<AgentRunIntent, AgentToolName> = {
    summary: 'room.summarize',
    deadline: 'deadline.answer',
    find_file: 'file.search',
    share_file: 'file.share',
    coordinate: 'agent.coordinate',
    task_update_suggest: 'task.suggest_update',
    web_search: 'web.search',
    chat: 'chat.answer'
  };
  return [{ tool: toolByIntent[intent], args }];
}

export function primaryToolNameForIntent(intent: AgentRunIntent): AgentToolName {
  return defaultToolCallsForIntent(intent)[0].tool;
}
