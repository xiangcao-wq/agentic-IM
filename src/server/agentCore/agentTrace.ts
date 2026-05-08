import type { AgentEvent, AgentEventType } from './agentEvents';

export type AgentTraceStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentTrace {
  runId: string;
  sessionId?: string;
  tenantId?: string;
  agentId?: string;
  roomId?: string;
  status: AgentTraceStatus;
  startedAt?: string;
  finishedAt?: string;
  phases: string[];
  toolCalls: string[];
  events: AgentEvent[];
}

const TERMINAL_STATUS_BY_TYPE: Partial<Record<AgentEventType, AgentTraceStatus>> = {
  'agent.run.completed': 'completed',
  'agent.run.failed': 'failed',
  'agent.run.cancelled': 'cancelled'
};

export function buildAgentTrace(events: AgentEvent[]): AgentTrace {
  const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence);
  const firstEvent = orderedEvents[0];

  if (!firstEvent) {
    throw new Error('agent trace requires at least one event');
  }

  const phases = collectUnique(orderedEvents.flatMap((event) => (event.phase ? [event.phase] : [])));
  const toolCalls = collectUnique(orderedEvents.flatMap((event) => event.toolCalls));
  const terminalEvent = findLastTerminalEvent(orderedEvents);
  const status = terminalEvent ? TERMINAL_STATUS_BY_TYPE[terminalEvent.type] : 'running';

  return {
    runId: firstEvent.runId,
    sessionId: firstEvent.sessionId,
    tenantId: firstEvent.tenantId,
    agentId: firstEvent.agentId,
    roomId: firstEvent.roomId,
    status: status ?? 'running',
    startedAt: firstEvent.createdAt,
    finishedAt: terminalEvent?.createdAt,
    phases,
    toolCalls,
    events: orderedEvents
  };
}

function findLastTerminalEvent(events: AgentEvent[]): AgentEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event && TERMINAL_STATUS_BY_TYPE[event.type]) {
      return event;
    }
  }

  return undefined;
}

function collectUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const uniqueValues: string[] = [];

  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      uniqueValues.push(value);
    }
  }

  return uniqueValues;
}
