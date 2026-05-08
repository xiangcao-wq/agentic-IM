import { constants } from 'node:fs';
import { access, appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentEvent, AgentEventDraft } from './agentEvents';
import { createAgentEventId, encodeEventCursor, parseEventCursor } from './agentEvents';

export interface AgentEventPage {
  events: AgentEvent[];
  nextCursor?: string;
}

export interface AgentEventStoreHealth {
  readable: boolean;
  writable: boolean;
  valid: boolean;
}

export interface AgentEventListOptions {
  runId?: string;
  sessionId?: string;
  after?: string | null;
  limit?: number;
}

export interface AgentEventStore {
  init(): Promise<void>;
  append(draft: AgentEventDraft): Promise<AgentEvent>;
  appendMany(drafts: AgentEventDraft[]): Promise<AgentEvent[]>;
  list(options?: AgentEventListOptions): Promise<AgentEventPage>;
  health(): Promise<AgentEventStoreHealth>;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const AGENT_EVENT_TYPES = new Set([
  'agent.run.created',
  'agent.run.started',
  'agent.progress',
  'agent.run.completed',
  'agent.run.failed',
  'agent.run.cancelled'
]);

const AGENT_EVENT_VISIBILITIES = new Set(['user', 'internal', 'audit']);
const RISK_LEVELS = new Set(['low', 'medium', 'high']);

export class MemoryAgentEventStore implements AgentEventStore {
  private events: AgentEvent[] = [];
  private nextSequence = 1;
  private appendQueue: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    return Promise.resolve();
  }

  async append(draft: AgentEventDraft): Promise<AgentEvent> {
    const [event] = await this.appendMany([draft]);
    return event;
  }

  async appendMany(drafts: AgentEventDraft[]): Promise<AgentEvent[]> {
    return this.enqueueAppend(async () => {
      const events = drafts.map((draft, index) => materializeEvent(draft, this.nextSequence + index));
      this.nextSequence += events.length;
      this.events.push(...events.map(cloneEvent));
      return events.map(cloneEvent);
    });
  }

  async list(options: AgentEventListOptions = {}): Promise<AgentEventPage> {
    return Promise.resolve(pageEvents(this.events, options));
  }

  async health(): Promise<AgentEventStoreHealth> {
    return Promise.resolve({
      readable: true,
      writable: true,
      valid: true
    });
  }

  private enqueueAppend<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.appendQueue.then(operation, operation);
    this.appendQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export class JsonlAgentEventStore implements AgentEventStore {
  private initialized = false;
  private nextSequence = 1;
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const file = await open(this.path, 'a');
    await file.close();

    const { events } = await readEventFile(this.path);
    this.nextSequence = maxSequence(events) + 1;
    this.initialized = true;
  }

  async append(draft: AgentEventDraft): Promise<AgentEvent> {
    const [event] = await this.appendMany([draft]);
    return event;
  }

  async appendMany(drafts: AgentEventDraft[]): Promise<AgentEvent[]> {
    return this.enqueueAppend(async () => {
      await this.ensureInitialized();

      if (drafts.length === 0) {
        return [];
      }

      const startSequence = this.nextSequence;
      const events = drafts.map((draft, index) => materializeEvent(draft, startSequence + index));
      const lines = events.map((event) => JSON.stringify(event)).join('\n');
      await appendFile(this.path, `${lines}\n`, 'utf8');
      this.nextSequence = startSequence + events.length;
      return events.map(cloneEvent);
    });
  }

  async list(options: AgentEventListOptions = {}): Promise<AgentEventPage> {
    await this.ensureInitialized();
    const { events } = await readEventFile(this.path);
    return pageEvents(events, options);
  }

  async health(): Promise<AgentEventStoreHealth> {
    await this.ensureInitialized();

    const readable = await canAccess(this.path, constants.R_OK);
    const writable = await canAccess(this.path, constants.W_OK);
    const valid = readable ? (await readEventFile(this.path)).valid : false;

    return {
      readable,
      writable,
      valid
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  private enqueueAppend<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.appendQueue.then(operation, operation);
    this.appendQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function materializeEvent(draft: AgentEventDraft, sequence: number): AgentEvent {
  const payload = { ...draft.payload };

  return {
    ...draft,
    toolCalls: Array.isArray(draft.toolCalls) ? [...draft.toolCalls] : [],
    payload,
    id: createAgentEventId(draft.runId, sequence),
    sequence,
    cursor: encodeEventCursor(sequence),
    createdAt: new Date().toISOString()
  };
}

function pageEvents(events: AgentEvent[], options: AgentEventListOptions): AgentEventPage {
  const afterSequence = parseEventCursor(options.after);
  const limit = normalizeLimit(options.limit);
  const page = events
    .filter((event) => !options.runId || event.runId === options.runId)
    .filter((event) => !options.sessionId || event.sessionId === options.sessionId)
    .filter((event) => event.sequence > afterSequence)
    .sort((left, right) => left.sequence - right.sequence)
    .slice(0, limit)
    .map(cloneEvent);
  const lastEvent = page.at(-1);

  return {
    events: page,
    nextCursor: lastEvent?.cursor
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

async function readEventFile(path: string): Promise<{ events: AgentEvent[]; valid: boolean }> {
  const raw = await readFile(path, 'utf8');
  const events: AgentEvent[] = [];
  let lastSequence = 0;
  let valid = true;

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    try {
      const value = JSON.parse(line) as unknown;
      if (isAgentEvent(value)) {
        if (value.sequence > lastSequence) {
          events.push(cloneEvent(value));
          lastSequence = value.sequence;
        } else {
          valid = false;
        }
      } else {
        valid = false;
      }
    } catch {
      valid = false;
    }
  }

  return {
    events,
    valid
  };
}

async function canAccess(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isRecord(value)) {
    return false;
  }

  const sequence = value.sequence;

  if (
    isKnownEventType(value.type) &&
    isString(value.tenantId) &&
    isString(value.sessionId) &&
    isString(value.runId) &&
    isKnownVisibility(value.visibility) &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.every(isString) &&
    isRecord(value.payload) &&
    isString(value.id) &&
    typeof sequence === 'number' &&
    Number.isFinite(sequence) &&
    Number.isInteger(sequence) &&
    sequence >= 1 &&
    isString(value.cursor) &&
    isString(value.createdAt) &&
    optionalString(value.agentId) &&
    optionalString(value.roomId) &&
    optionalString(value.phase) &&
    optionalString(value.label) &&
    optionalString(value.detail) &&
    optionalRiskLevel(value.riskLevel)
  ) {
    return (
      value.cursor === encodeEventCursor(sequence) &&
      value.id === createAgentEventId(value.runId, sequence) &&
      isValidTimestamp(value.createdAt)
    );
  }

  return false;
}

function isKnownEventType(value: unknown): boolean {
  return isString(value) && AGENT_EVENT_TYPES.has(value);
}

function isKnownVisibility(value: unknown): boolean {
  return isString(value) && AGENT_EVENT_VISIBILITIES.has(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function optionalRiskLevel(value: unknown): boolean {
  return value === undefined || (isString(value) && RISK_LEVELS.has(value));
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneEvent(event: AgentEvent): AgentEvent {
  return {
    ...event,
    toolCalls: [...event.toolCalls],
    payload: { ...event.payload }
  };
}

function maxSequence(events: AgentEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.sequence), 0);
}
