# AgentBridge Product Kernel EventLog Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first v0.2 Product Kernel slice: a durable Agent EventLog, Product Harness wrapper, trace replay API, and readiness signal around the existing Agent runtime.

**Architecture:** Keep the existing `runAgentIntent` runtime working, then wrap it with a Product Harness that records canonical Agent events. Store events behind an `AgentEventStore` interface with a local JSONL adapter now and a clean boundary for a future Postgres adapter.

**Tech Stack:** TypeScript, Node HTTP server, Vitest, current Vite app, existing `JsonStateStore`, existing `runAgentIntent`, no new package dependency in this slice.

---

## Scope Check

The approved Agent OS spec covers EventLog, Product Harness, Tool Platform v2, Permission Broker, A2A, Worker leases, UI, eval, and release gates. That is too large for one implementation pass.

This plan implements only the first independently testable slice:

- Canonical AgentEvent model.
- Durable local EventLog adapter.
- Product Harness around existing runtime.
- API endpoints for run event replay and trace replay.
- Readiness signal for event log health.

The next plans should cover Tool Platform v2, Permission Broker, Workbench Timeline UI, Worker leases, and A2A session model.

## File Structure

- Create: `src/server/agentCore/agentEvents.ts`
  - Owns canonical event types, cursor helpers, progress-to-event mapping, and event draft helpers.
- Create: `src/server/agentCore/agentEvents.test.ts`
  - Verifies event cursor parsing and legacy progress mapping.
- Create: `src/server/agentCore/eventLogStore.ts`
  - Owns `AgentEventStore`, `MemoryAgentEventStore`, and `JsonlAgentEventStore`.
- Create: `src/server/agentCore/eventLogStore.test.ts`
  - Verifies append, cursor replay, run filtering, corruption tolerance, and health checks.
- Create: `src/server/agentCore/productHarness.ts`
  - Wraps `runAgentIntent`, emits Product Kernel events, and preserves existing runtime behavior.
- Create: `src/server/agentCore/productHarness.test.ts`
  - Verifies success and failure events around the existing runtime.
- Create: `src/server/agentCore/agentTrace.ts`
  - Builds trace replay payloads from stored Agent events.
- Create: `src/server/agentCore/agentTrace.test.ts`
  - Verifies trace status, phase list, and event ordering.
- Modify: `src/server/appServer.ts`
  - Adds an event store option, initializes default JSONL event log, uses Product Harness for `/api/agent/run`, and exposes replay APIs.
- Modify: `src/server/appServer.test.ts`
  - Adds HTTP integration tests for `/api/agent-runs/:runId/events`, `/api/traces/:runId`, and readiness event log health.
- Modify: `src/server/readiness/productReadiness.ts`
  - Adds event log readiness check.
- Modify: `src/server/readiness/productReadiness.test.ts`
  - Verifies event log readiness states.

---

### Task 1: Canonical Agent Event Model

**Files:**
- Create: `src/server/agentCore/agentEvents.ts`
- Create: `src/server/agentCore/agentEvents.test.ts`

- [ ] **Step 1: Write failing tests for event cursors and progress mapping**

Create `src/server/agentCore/agentEvents.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  agentProgressToEventDraft,
  createRunEventDraft,
  encodeEventCursor,
  parseEventCursor
} from './agentEvents';

describe('agent event helpers', () => {
  it('encodes and parses sequence cursors', () => {
    expect(encodeEventCursor(42)).toBe('seq:42');
    expect(parseEventCursor('seq:42')).toBe(42);
    expect(parseEventCursor(undefined)).toBe(0);
    expect(parseEventCursor('bad-cursor')).toBe(0);
  });

  it('creates a run event draft with product identity context', () => {
    const draft = createRunEventDraft({
      type: 'agent.run.created',
      tenantId: 'local',
      sessionId: 'session-1',
      runId: 'run-1',
      agentId: 'agent-lin',
      roomId: 'room-team',
      entrypoint: 'chat',
      visibility: 'internal',
      payload: { userText: 'summarize this room' }
    });

    expect(draft).toMatchObject({
      type: 'agent.run.created',
      tenantId: 'local',
      sessionId: 'session-1',
      runId: 'run-1',
      agentId: 'agent-lin',
      roomId: 'room-team',
      visibility: 'internal'
    });
    expect(draft.payload).toMatchObject({ entrypoint: 'chat', userText: 'summarize this room' });
  });

  it('maps legacy progress events into canonical agent progress drafts', () => {
    const draft = agentProgressToEventDraft(
      {
        tenantId: 'local',
        sessionId: 'session-1',
        runId: 'run-1'
      },
      {
        runId: 'run-1',
        agentId: 'agent-lin',
        roomId: 'room-team',
        phase: 'executing',
        label: 'Execute file search',
        detail: 'looking for slides',
        toolCalls: ['file.search'],
        riskLevel: 'low'
      }
    );

    expect(draft).toMatchObject({
      type: 'agent.progress',
      tenantId: 'local',
      sessionId: 'session-1',
      runId: 'run-1',
      agentId: 'agent-lin',
      roomId: 'room-team',
      phase: 'executing',
      label: 'Execute file search',
      visibility: 'user'
    });
    expect(draft.toolCalls).toEqual(['file.search']);
    expect(draft.payload).toMatchObject({ detail: 'looking for slides' });
  });
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
npm run test -- src/server/agentCore/agentEvents.test.ts
```

Expected: FAIL because `src/server/agentCore/agentEvents.ts` does not exist.

- [ ] **Step 3: Add `agentEvents.ts`**

Create `src/server/agentCore/agentEvents.ts`:

```ts
import type { AgentProgressPhase, RiskLevel } from '../../domain/types';

export type AgentEventVisibility = 'user' | 'internal' | 'audit';

export type AgentEventType =
  | 'agent.run.created'
  | 'agent.run.started'
  | 'agent.progress'
  | 'agent.run.completed'
  | 'agent.run.failed'
  | 'agent.run.cancelled';

export interface AgentEventDraft {
  type: AgentEventType;
  tenantId: string;
  sessionId: string;
  runId: string;
  agentId?: string;
  roomId?: string;
  taskId?: string;
  phase?: AgentProgressPhase;
  label?: string;
  detail?: string;
  toolCalls: string[];
  riskLevel?: RiskLevel;
  visibility: AgentEventVisibility;
  payload: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
}

export interface AgentEvent extends AgentEventDraft {
  id: string;
  sequence: number;
  cursor: string;
  createdAt: string;
}

export interface AgentRunEventDraftInput {
  type: AgentEventType;
  tenantId: string;
  sessionId: string;
  runId: string;
  agentId?: string;
  roomId?: string;
  taskId?: string;
  entrypoint?: string;
  visibility?: AgentEventVisibility;
  label?: string;
  detail?: string;
  toolCalls?: string[];
  riskLevel?: RiskLevel;
  payload?: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
}

export interface AgentProgressDraftContext {
  tenantId: string;
  sessionId: string;
  runId: string;
}

export interface LegacyAgentProgressEvent {
  runId: string;
  agentId: string;
  roomId: string;
  phase: AgentProgressPhase;
  label: string;
  detail?: string;
  toolCalls: string[];
  riskLevel?: RiskLevel;
}

export function encodeEventCursor(sequence: number): string {
  return `seq:${Math.max(0, Math.trunc(sequence))}`;
}

export function parseEventCursor(cursor: string | null | undefined): number {
  if (!cursor) {
    return 0;
  }

  const match = cursor.match(/^seq:(\d+)$/);
  return match ? Number(match[1]) : 0;
}

export function createAgentEventId(runId: string, sequence: number): string {
  return `${runId}-event-${String(sequence).padStart(8, '0')}`;
}

export function createRunEventDraft(input: AgentRunEventDraftInput): AgentEventDraft {
  return {
    type: input.type,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    runId: input.runId,
    agentId: input.agentId,
    roomId: input.roomId,
    taskId: input.taskId,
    label: input.label,
    detail: input.detail,
    toolCalls: input.toolCalls ?? [],
    riskLevel: input.riskLevel,
    visibility: input.visibility ?? 'internal',
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: {
      ...(input.entrypoint ? { entrypoint: input.entrypoint } : {}),
      ...(input.payload ?? {})
    }
  };
}

export function agentProgressToEventDraft(
  context: AgentProgressDraftContext,
  progress: LegacyAgentProgressEvent
): AgentEventDraft {
  return {
    type: 'agent.progress',
    tenantId: context.tenantId,
    sessionId: context.sessionId,
    runId: context.runId,
    agentId: progress.agentId,
    roomId: progress.roomId,
    phase: progress.phase,
    label: progress.label,
    detail: progress.detail,
    toolCalls: [...progress.toolCalls],
    riskLevel: progress.riskLevel,
    visibility: 'user',
    payload: {
      phase: progress.phase,
      label: progress.label,
      ...(progress.detail ? { detail: progress.detail } : {}),
      toolCalls: [...progress.toolCalls],
      ...(progress.riskLevel ? { riskLevel: progress.riskLevel } : {})
    }
  };
}
```

- [ ] **Step 4: Run the event helper test**

Run:

```bash
npm run test -- src/server/agentCore/agentEvents.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/server/agentCore/agentEvents.ts src/server/agentCore/agentEvents.test.ts
git commit -m "feat: add canonical agent event model"
```

---

### Task 2: Durable Agent EventLog Store

**Files:**
- Create: `src/server/agentCore/eventLogStore.ts`
- Create: `src/server/agentCore/eventLogStore.test.ts`

- [ ] **Step 1: Write failing tests for memory and JSONL event stores**

Create `src/server/agentCore/eventLogStore.test.ts`:

```ts
// @vitest-environment node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunEventDraft } from './agentEvents';
import { JsonlAgentEventStore, MemoryAgentEventStore } from './eventLogStore';

function draft(runId: string, label: string) {
  return createRunEventDraft({
    type: 'agent.progress',
    tenantId: 'local',
    sessionId: `${runId}-session`,
    runId,
    agentId: 'agent-lin',
    roomId: 'room-team',
    visibility: 'user',
    label,
    payload: { label }
  });
}

describe('MemoryAgentEventStore', () => {
  it('appends events with increasing sequence and cursor replay', async () => {
    const store = new MemoryAgentEventStore();
    await store.init();

    const first = await store.append(draft('run-1', 'first'));
    const second = await store.append(draft('run-1', 'second'));
    await store.append(draft('run-2', 'third'));

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);

    const page = await store.list({ runId: 'run-1', after: first.cursor });
    expect(page.events.map((event) => event.label)).toEqual(['second']);
    expect(page.nextCursor).toBe(second.cursor);
  });
});

describe('JsonlAgentEventStore', () => {
  it('persists events to jsonl and reloads them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-events-'));
    const path = join(dir, 'events.jsonl');
    const store = new JsonlAgentEventStore(path);
    await store.init();

    const event = await store.append(draft('run-jsonl', 'persisted'));
    const reloaded = new JsonlAgentEventStore(path);
    await reloaded.init();

    const page = await reloaded.list({ runId: 'run-jsonl' });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      id: event.id,
      cursor: event.cursor,
      label: 'persisted'
    });
  });

  it('reports degraded health when the jsonl file has invalid lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-events-'));
    const path = join(dir, 'events.jsonl');
    await writeFile(path, '{"ok":true}\nnot-json\n', 'utf8');

    const store = new JsonlAgentEventStore(path);
    await store.init();

    const health = await store.health();
    expect(health.readable).toBe(true);
    expect(health.writable).toBe(true);
    expect(health.valid).toBe(false);

    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('not-json');
  });
});
```

- [ ] **Step 2: Run the store test and verify it fails**

Run:

```bash
npm run test -- src/server/agentCore/eventLogStore.test.ts
```

Expected: FAIL because `eventLogStore.ts` does not exist.

- [ ] **Step 3: Add `eventLogStore.ts`**

Create `src/server/agentCore/eventLogStore.ts`:

```ts
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type AgentEvent,
  type AgentEventDraft,
  createAgentEventId,
  encodeEventCursor,
  parseEventCursor
} from './agentEvents';

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

export class MemoryAgentEventStore implements AgentEventStore {
  private events: AgentEvent[] = [];

  async init(): Promise<void> {}

  async append(draft: AgentEventDraft): Promise<AgentEvent> {
    const event = materializeEvent(draft, this.events.length + 1);
    this.events.push(event);
    return event;
  }

  async appendMany(drafts: AgentEventDraft[]): Promise<AgentEvent[]> {
    const appended: AgentEvent[] = [];
    for (const draft of drafts) {
      appended.push(await this.append(draft));
    }
    return appended;
  }

  async list(options: AgentEventListOptions = {}): Promise<AgentEventPage> {
    return pageEvents(this.events, options);
  }

  async health(): Promise<AgentEventStoreHealth> {
    return { readable: true, writable: true, valid: true };
  }
}

export class JsonlAgentEventStore implements AgentEventStore {
  private initialized = false;

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await readFile(this.path, 'utf8');
    } catch {
      await writeFile(this.path, '', 'utf8');
    }
    this.initialized = true;
  }

  async append(draft: AgentEventDraft): Promise<AgentEvent> {
    await this.ensureInitialized();
    const events = await this.readAll();
    const event = materializeEvent(draft, maxSequence(events) + 1);
    await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  async appendMany(drafts: AgentEventDraft[]): Promise<AgentEvent[]> {
    await this.ensureInitialized();
    const events = await this.readAll();
    let sequence = maxSequence(events);
    const appended = drafts.map((draft) => materializeEvent(draft, ++sequence));
    if (appended.length > 0) {
      await appendFile(this.path, appended.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
    }
    return appended;
  }

  async list(options: AgentEventListOptions = {}): Promise<AgentEventPage> {
    await this.ensureInitialized();
    return pageEvents(await this.readAll(), options);
  }

  async health(): Promise<AgentEventStoreHealth> {
    await this.ensureInitialized();
    let readable = false;
    let writable = false;
    let valid = true;

    try {
      const raw = await readFile(this.path, 'utf8');
      readable = true;
      valid = raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .every((line) => isAgentEventRecord(safeJsonParse(line)));
    } catch {
      readable = false;
      valid = false;
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.path, 'a');
      writable = true;
    } catch {
      writable = false;
    } finally {
      await handle?.close();
    }

    return { readable, writable, valid };
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  private async readAll(): Promise<AgentEvent[]> {
    const raw = await readFile(this.path, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => safeJsonParse(line))
      .filter(isAgentEventRecord);
  }
}

function materializeEvent(draft: AgentEventDraft, sequence: number): AgentEvent {
  return {
    ...draft,
    id: createAgentEventId(draft.runId, sequence),
    sequence,
    cursor: encodeEventCursor(sequence),
    createdAt: new Date().toISOString()
  };
}

function pageEvents(events: AgentEvent[], options: AgentEventListOptions): AgentEventPage {
  const afterSequence = parseEventCursor(options.after);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const filtered = events
    .filter((event) => !options.runId || event.runId === options.runId)
    .filter((event) => !options.sessionId || event.sessionId === options.sessionId)
    .filter((event) => event.sequence > afterSequence)
    .sort((a, b) => a.sequence - b.sequence)
    .slice(0, limit);

  return {
    events: filtered,
    nextCursor: filtered.at(-1)?.cursor
  };
}

function maxSequence(events: AgentEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.sequence), 0);
}

function safeJsonParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isAgentEventRecord(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.sequence === 'number' &&
    typeof record.cursor === 'string' &&
    typeof record.type === 'string' &&
    typeof record.tenantId === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.runId === 'string' &&
    typeof record.createdAt === 'string'
  );
}
```

- [ ] **Step 4: Run the event store tests**

Run:

```bash
npm run test -- src/server/agentCore/eventLogStore.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/server/agentCore/eventLogStore.ts src/server/agentCore/eventLogStore.test.ts
git commit -m "feat: add agent event log store"
```

---

### Task 3: Product Harness Around Existing Runtime

**Files:**
- Create: `src/server/agentCore/productHarness.ts`
- Create: `src/server/agentCore/productHarness.test.ts`

- [ ] **Step 1: Write failing Product Harness tests**

Create `src/server/agentCore/productHarness.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../../domain/demoState';
import type { DemoState } from '../../domain/types';
import { MemoryAgentEventStore } from './eventLogStore';
import { runProductAgentSession } from './productHarness';

describe('runProductAgentSession', () => {
  it('wraps a successful existing agent run with product events', async () => {
    const store = new MemoryAgentEventStore();
    await store.init();

    const runtime = await runProductAgentSession({
      state: createDemoState(),
      input: {
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'chat',
        userText: 'Who owns the interview materials?'
      },
      eventStore: store,
      runId: 'agent-run-test',
      sessionId: 'agent-session-test',
      aiProvider: undefined,
      tools: {}
    });

    expect(runtime.runId).toBe('agent-run-test');
    expect(runtime.sessionId).toBe('agent-session-test');
    expect(runtime.response.intent).toBe('chat');

    const page = await store.list({ runId: 'agent-run-test' });
    expect(page.events.map((event) => event.type)).toContain('agent.run.created');
    expect(page.events.map((event) => event.type)).toContain('agent.progress');
    expect(page.events.at(-1)).toMatchObject({ type: 'agent.run.completed' });
  });

  it('records failed product events before rethrowing runtime errors', async () => {
    const store = new MemoryAgentEventStore();
    await store.init();
    const state: DemoState = createDemoState();

    await expect(
      runProductAgentSession({
        state,
        input: {
          agentId: 'missing-agent',
          roomId: 'room-team',
          intent: 'chat',
          userText: 'hello'
        },
        eventStore: store,
        runId: 'agent-run-failed',
        sessionId: 'agent-session-failed',
        aiProvider: undefined,
        tools: {}
      })
    ).rejects.toThrow('unknown agent');

    const page = await store.list({ runId: 'agent-run-failed' });
    expect(page.events.map((event) => event.type)).toEqual(['agent.run.created', 'agent.run.failed']);
    expect(page.events.at(-1)?.payload).toMatchObject({ error: 'unknown agent: missing-agent' });
  });
});
```

- [ ] **Step 2: Run the Product Harness test and verify it fails**

Run:

```bash
npm run test -- src/server/agentCore/productHarness.test.ts
```

Expected: FAIL because `productHarness.ts` does not exist.

- [ ] **Step 3: Add `productHarness.ts`**

Create `src/server/agentCore/productHarness.ts`:

```ts
import type { AgentProgressEvent, AgentRunRequest, AgentRunResult, DemoState } from '../../domain/types';
import type { AiProvider } from '../aiProvider';
import { runAgentIntent } from '../agentRunRuntime';
import type { WebSearchProvider } from '../webSearch';
import { agentProgressToEventDraft, createRunEventDraft, type AgentEvent, type AgentEventDraft } from './agentEvents';
import type { AgentEventStore } from './eventLogStore';

export interface ProductHarnessToolOptions {
  webSearchProvider?: WebSearchProvider;
}

export interface ProductHarnessInput {
  state: DemoState;
  input: AgentRunRequest;
  eventStore: AgentEventStore;
  aiProvider?: AiProvider;
  tools?: ProductHarnessToolOptions;
  tenantId?: string;
  runId?: string;
  sessionId?: string;
  entrypoint?: 'chat' | 'task' | 'file' | 'schedule' | 'connector' | 'eval';
  onProgress?: (event: Omit<AgentProgressEvent, 'id' | 'createdAt' | 'sequence'>) => void;
}

export interface ProductHarnessResult {
  tenantId: string;
  sessionId: string;
  runId: string;
  state: DemoState;
  response: AgentRunResult;
  events: AgentEvent[];
}

export async function runProductAgentSession(input: ProductHarnessInput): Promise<ProductHarnessResult> {
  const tenantId = input.tenantId ?? 'local';
  const runId = input.runId ?? createHarnessId('agent-run');
  const sessionId = input.sessionId ?? createHarnessId('agent-session');
  const eventDrafts: AgentEventDraft[] = [
    createRunEventDraft({
      type: 'agent.run.created',
      tenantId,
      sessionId,
      runId,
      agentId: input.input.agentId,
      roomId: input.input.roomId,
      entrypoint: input.entrypoint ?? 'chat',
      visibility: 'internal',
      payload: {
        intent: input.input.intent,
        userText: input.input.userText
      }
    })
  ];

  try {
    const runtime = await runAgentIntent(
      input.state,
      input.input,
      input.aiProvider,
      {
        runId,
        onProgress: (progress) => {
          input.onProgress?.(progress);
          eventDrafts.push(agentProgressToEventDraft({ tenantId, sessionId, runId }, progress));
        }
      },
      input.tools ?? {}
    );

    eventDrafts.push(
      createRunEventDraft({
        type: 'agent.run.completed',
        tenantId,
        sessionId,
        runId,
        agentId: input.input.agentId,
        roomId: input.input.roomId,
        visibility: 'internal',
        label: `completed:${runtime.response.intent}`,
        toolCalls: runtime.response.log.toolCalls,
        riskLevel: runtime.response.log.risk.level,
        payload: {
          intent: runtime.response.intent,
          requiresHuman: runtime.response.requiresHuman,
          logId: runtime.response.log.id
        }
      })
    );

    const events = await input.eventStore.appendMany(eventDrafts);
    return {
      tenantId,
      sessionId,
      runId,
      state: runtime.state,
      response: runtime.response,
      events
    };
  } catch (error) {
    eventDrafts.push(
      createRunEventDraft({
        type: 'agent.run.failed',
        tenantId,
        sessionId,
        runId,
        agentId: input.input.agentId,
        roomId: input.input.roomId,
        visibility: 'audit',
        label: 'Agent run failed',
        payload: {
          error: error instanceof Error ? error.message : 'unknown Agent runtime error'
        }
      })
    );
    await input.eventStore.appendMany(eventDrafts);
    throw error;
  }
}

function createHarnessId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
```

- [ ] **Step 4: Run the Product Harness tests**

Run:

```bash
npm run test -- src/server/agentCore/productHarness.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/server/agentCore/productHarness.ts src/server/agentCore/productHarness.test.ts
git commit -m "feat: wrap agent runs with product harness"
```

---

### Task 4: Trace Builder

**Files:**
- Create: `src/server/agentCore/agentTrace.ts`
- Create: `src/server/agentCore/agentTrace.test.ts`

- [ ] **Step 1: Write failing trace builder tests**

Create `src/server/agentCore/agentTrace.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createRunEventDraft } from './agentEvents';
import { MemoryAgentEventStore } from './eventLogStore';
import { buildAgentTrace } from './agentTrace';

describe('buildAgentTrace', () => {
  it('summarizes ordered events into a replayable trace', async () => {
    const store = new MemoryAgentEventStore();
    await store.init();
    await store.appendMany([
      createRunEventDraft({
        type: 'agent.run.created',
        tenantId: 'local',
        sessionId: 'session-1',
        runId: 'run-1',
        agentId: 'agent-lin',
        roomId: 'room-team',
        visibility: 'internal',
        payload: { userText: 'hello' }
      }),
      createRunEventDraft({
        type: 'agent.progress',
        tenantId: 'local',
        sessionId: 'session-1',
        runId: 'run-1',
        agentId: 'agent-lin',
        roomId: 'room-team',
        phase: 'executing',
        label: 'Execute tool',
        toolCalls: ['file.search'],
        visibility: 'user',
        payload: { phase: 'executing' }
      }),
      createRunEventDraft({
        type: 'agent.run.completed',
        tenantId: 'local',
        sessionId: 'session-1',
        runId: 'run-1',
        agentId: 'agent-lin',
        roomId: 'room-team',
        visibility: 'internal',
        toolCalls: ['file.search'],
        payload: { intent: 'find_file' }
      })
    ]);

    const page = await store.list({ runId: 'run-1' });
    const trace = buildAgentTrace(page.events);

    expect(trace).toMatchObject({
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'completed',
      agentId: 'agent-lin',
      roomId: 'room-team'
    });
    expect(trace.phases).toEqual(['executing']);
    expect(trace.toolCalls).toEqual(['file.search']);
    expect(trace.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run the trace test and verify it fails**

Run:

```bash
npm run test -- src/server/agentCore/agentTrace.test.ts
```

Expected: FAIL because `agentTrace.ts` does not exist.

- [ ] **Step 3: Add `agentTrace.ts`**

Create `src/server/agentCore/agentTrace.ts`:

```ts
import type { AgentProgressPhase } from '../../domain/types';
import type { AgentEvent } from './agentEvents';

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
  phases: AgentProgressPhase[];
  toolCalls: string[];
  events: AgentEvent[];
}

export function buildAgentTrace(events: AgentEvent[]): AgentTrace {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const first = ordered[0];
  const last = ordered.at(-1);

  return {
    runId: first?.runId ?? '',
    sessionId: first?.sessionId,
    tenantId: first?.tenantId,
    agentId: first?.agentId,
    roomId: first?.roomId,
    status: resolveTraceStatus(ordered),
    startedAt: first?.createdAt,
    finishedAt: isTerminalEvent(last) ? last?.createdAt : undefined,
    phases: uniqueOrdered(ordered.map((event) => event.phase).filter(Boolean) as AgentProgressPhase[]),
    toolCalls: uniqueOrdered(ordered.flatMap((event) => event.toolCalls)),
    events: ordered
  };
}

function resolveTraceStatus(events: AgentEvent[]): AgentTraceStatus {
  const terminal = [...events].reverse().find(isTerminalEvent);
  if (terminal?.type === 'agent.run.completed') {
    return 'completed';
  }
  if (terminal?.type === 'agent.run.failed') {
    return 'failed';
  }
  if (terminal?.type === 'agent.run.cancelled') {
    return 'cancelled';
  }
  return 'running';
}

function isTerminalEvent(event: AgentEvent | undefined): boolean {
  return Boolean(
    event &&
      (event.type === 'agent.run.completed' || event.type === 'agent.run.failed' || event.type === 'agent.run.cancelled')
  );
}

function uniqueOrdered<T>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}
```

- [ ] **Step 4: Run the trace tests**

Run:

```bash
npm run test -- src/server/agentCore/agentTrace.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/server/agentCore/agentTrace.ts src/server/agentCore/agentTrace.test.ts
git commit -m "feat: build agent trace replay payloads"
```

---

### Task 5: Integrate Product Harness and Trace APIs into App Server

**Files:**
- Modify: `src/server/appServer.ts`
- Modify: `src/server/appServer.test.ts`

- [ ] **Step 1: Write failing HTTP integration tests**

Append these tests near the existing `/api/agent/run` tests in `src/server/appServer.test.ts`:

```ts
  it('records replayable product events for /api/agent/run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const result = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'chat',
        userText: 'Who owns the interview materials?'
      })
    });

    expect(result.runId).toMatch(/^agent-run-/);
    expect(result.sessionId).toMatch(/^agent-session-/);

    const replay = await requestJson(`${app.url}/api/agent-runs/${result.runId}/events`);
    expect(replay.events.map((event: { type: string }) => event.type)).toContain('agent.run.created');
    expect(replay.events.map((event: { type: string }) => event.type)).toContain('agent.run.completed');
    expect(replay.nextCursor).toMatch(/^seq:/);
  });

  it('returns a trace replay payload for an agent run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const result = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'chat',
        userText: 'Who owns the interview materials?'
      })
    });

    const trace = await requestJson(`${app.url}/api/traces/${result.runId}`);
    expect(trace.runId).toBe(result.runId);
    expect(trace.status).toBe('completed');
    expect(trace.events.length).toBeGreaterThanOrEqual(2);
  });
```

- [ ] **Step 2: Run the HTTP tests and verify they fail**

Run:

```bash
npm run test -- src/server/appServer.test.ts -t "records replayable product events|returns a trace replay payload"
```

Expected: FAIL because response does not include `runId`/`sessionId` and replay APIs do not exist.

- [ ] **Step 3: Import EventLog, Product Harness, and Trace helpers**

Modify imports at the top of `src/server/appServer.ts`:

```ts
import { dirname, basename, join, resolve } from 'node:path';
import { buildAgentTrace } from './agentCore/agentTrace';
import { JsonlAgentEventStore, type AgentEventStore } from './agentCore/eventLogStore';
import { runProductAgentSession } from './agentCore/productHarness';
```

If `basename`, `join`, or `resolve` are already imported from `node:path`, preserve the existing names and add only `dirname`.

- [ ] **Step 4: Add event store to server options and initialization**

Add to `ServerOptions`:

```ts
  agentEventStore?: AgentEventStore;
```

Inside `createAppServer`, after `const db = ...` and `await db.init();`, add:

```ts
  const agentEventStore =
    options.agentEventStore ?? new JsonlAgentEventStore(join(dirname(resolve(options.dbPath)), 'agent-events.jsonl'));
  await agentEventStore.init();
```

- [ ] **Step 5: Replace direct runtime call in `/api/agent/run` with Product Harness**

In the `/api/agent/run` handler, replace:

```ts
runtime = await runAgentIntent(runtimeState, body, aiProvider, {
  runId,
  onProgress: publishProgress
}, { webSearchProvider });
```

with:

```ts
runtime = await runProductAgentSession({
  state: runtimeState,
  input: body,
  aiProvider,
  eventStore: agentEventStore,
  runId,
  sessionId: createRuntimeId('agent-session'),
  entrypoint: 'chat',
  onProgress: publishProgress,
  tools: { webSearchProvider }
});
```

Update the local `runtime` type from:

```ts
let runtime: Awaited<ReturnType<typeof runAgentIntent>>;
```

to:

```ts
let runtime: Awaited<ReturnType<typeof runProductAgentSession>>;
```

Change the final response from:

```ts
return sendJson(response, runtime.response);
```

to:

```ts
return sendJson(response, {
  ...runtime.response,
  runId: runtime.runId,
  sessionId: runtime.sessionId,
  eventCursor: runtime.events.at(-1)?.cursor
});
```

- [ ] **Step 6: Add replay endpoints before `/api/events`**

Add this block in `src/server/appServer.ts` before the existing `GET /api/events` route:

```ts
      const agentRunEventsMatch = url.pathname.match(/^\/api\/agent-runs\/([^/]+)\/events$/);
      if (request.method === 'GET' && agentRunEventsMatch) {
        const runId = decodeURIComponent(agentRunEventsMatch[1]);
        const limitInput = Number(url.searchParams.get('limit') ?? 100);
        const page = await agentEventStore.list({
          runId,
          after: url.searchParams.get('cursor'),
          limit: Number.isFinite(limitInput) ? limitInput : 100
        });
        return sendJson(response, page);
      }

      const traceMatch = url.pathname.match(/^\/api\/traces\/([^/]+)$/);
      if (request.method === 'GET' && traceMatch) {
        const runId = decodeURIComponent(traceMatch[1]);
        const page = await agentEventStore.list({ runId, limit: 500 });
        if (page.events.length === 0) {
          return sendJson(response, { error: 'trace not found' }, 404);
        }
        return sendJson(response, buildAgentTrace(page.events));
      }
```

- [ ] **Step 7: Remove unused direct runtime import**

If `runAgentIntent` is no longer used in `src/server/appServer.ts`, remove:

```ts
import { runAgentIntent } from './agentRunRuntime';
```

- [ ] **Step 8: Run the focused HTTP tests**

Run:

```bash
npm run test -- src/server/appServer.test.ts -t "records replayable product events|returns a trace replay payload"
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

```bash
git add src/server/appServer.ts src/server/appServer.test.ts
git commit -m "feat: expose agent run trace replay APIs"
```

---

### Task 6: EventLog Readiness Check

**Files:**
- Modify: `src/server/readiness/productReadiness.ts`
- Modify: `src/server/readiness/productReadiness.test.ts`
- Modify: `src/server/appServer.ts`
- Modify: `src/server/appServer.test.ts`

- [ ] **Step 1: Write failing readiness unit tests**

Add to `src/server/readiness/productReadiness.test.ts`:

```ts
  it('marks product readiness blocked when the event log is not writable', () => {
    const readiness = buildProductReadiness({
      auth: {
        mode: 'product-token',
        requireAuth: true,
        allowQueryToken: false,
        tokenConfigured: true,
        allowedOrigins: ['https://agentbridge.example.com']
      },
      storage: { mode: 'json-local', readable: true, writable: true },
      eventLog: { mode: 'jsonl-local', readable: true, writable: false, valid: true },
      worker: { autopilotEnabled: false, running: false },
      connector: { matrixEnabled: false, bootstrapMode: 'local' },
      provider: { configured: true, provider: 'deepseek', health: 'ok' }
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks.eventLog).toMatchObject({
      ok: false,
      status: 'blocked'
    });
  });
```

- [ ] **Step 2: Run the readiness test and verify it fails**

Run:

```bash
npm run test -- src/server/readiness/productReadiness.test.ts -t "event log"
```

Expected: FAIL because `eventLog` is not part of `ProductReadinessInput`.

- [ ] **Step 3: Add event log readiness type and builder logic**

Modify `src/server/readiness/productReadiness.ts`.

Add `eventLog` to `ProductReadiness` checks:

```ts
    eventLog: ReadinessCheck & { mode: string; readable: boolean; writable: boolean; valid: boolean };
```

Add `eventLog` to `ProductReadinessInput`:

```ts
  eventLog: { mode: string; readable: boolean; writable: boolean; valid: boolean };
```

Add it in `buildProductReadiness`:

```ts
    eventLog: buildEventLogCheck(input.eventLog),
```

Add this function:

```ts
function buildEventLogCheck(input: ProductReadinessInput['eventLog']): ProductReadiness['checks']['eventLog'] {
  const ready = input.readable && input.writable && input.valid;
  return {
    ok: ready,
    status: ready ? 'ready' : 'blocked',
    message: ready
      ? 'Agent event log is readable, writable, and valid.'
      : 'Agent event log is not product-ready; check readability, writability, and JSONL validity.',
    mode: input.mode,
    readable: input.readable,
    writable: input.writable,
    valid: input.valid
  };
}
```

- [ ] **Step 4: Pass event log health from App Server readiness**

In `src/server/appServer.ts`, inside `/api/readiness`, add:

```ts
        const eventLogHealth = await agentEventStore.health();
```

Then add this property to `buildProductReadiness` input:

```ts
            eventLog: { mode: 'jsonl-local', ...eventLogHealth },
```

- [ ] **Step 5: Add HTTP readiness assertion**

Add to an existing readiness HTTP test in `src/server/appServer.test.ts`, or create a focused one:

```ts
    const readiness = await requestJson(`${app.url}/api/readiness`);
    expect(readiness.checks.eventLog).toMatchObject({
      mode: 'jsonl-local',
      readable: true,
      writable: true,
      valid: true
    });
```

Use a server configuration that already passes auth for readiness in the existing tests. Do not weaken auth requirements.

- [ ] **Step 6: Run focused readiness tests**

Run:

```bash
npm run test -- src/server/readiness/productReadiness.test.ts src/server/appServer.test.ts -t "event log|readiness"
```

Expected: PASS for the new readiness assertions and existing readiness behavior.

- [ ] **Step 7: Commit Task 6**

```bash
git add src/server/readiness/productReadiness.ts src/server/readiness/productReadiness.test.ts src/server/appServer.ts src/server/appServer.test.ts
git commit -m "feat: add event log readiness check"
```

---

### Task 7: Full Verification and Documentation Note

**Files:**
- Modify: `docs/superpowers/status/2026-05-07-agent-system-product-readiness.md`

- [ ] **Step 1: Run all Agent Core and readiness tests**

Run:

```bash
npm run test -- src/server/agentCore src/server/readiness
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm run test
```

Expected: PASS.

- [ ] **Step 3: Run production build**

Run:

```bash
npm run build
```

Expected: PASS with `tsc --noEmit` and Vite build success.

- [ ] **Step 4: Update product readiness status document**

Append this section to `docs/superpowers/status/2026-05-07-agent-system-product-readiness.md`:

```md
## 2026-05-08 Product Kernel Slice

Implemented the first Product Kernel slice:

- Agent runs now emit canonical Product Kernel events.
- A local JSONL AgentEventStore provides durable replay for controlled pilot usage.
- `/api/agent-runs/:runId/events` returns cursor-based event replay.
- `/api/traces/:runId` returns trace replay payloads.
- `/api/readiness` includes Agent event log health.

This is not the final Postgres event store. It establishes the interface and API contract that the Postgres adapter will implement in the next storage-focused slice.
```

- [ ] **Step 5: Commit verification documentation**

```bash
git add docs/superpowers/status/2026-05-07-agent-system-product-readiness.md
git commit -m "docs: record product kernel event log slice"
```

- [ ] **Step 6: Final branch check**

Run:

```bash
git status --short --branch
```

Expected: clean working tree and branch ahead by the number of local commits created during this plan.

---

## Self-Review

Spec coverage:

- Event-first: covered by Tasks 1, 2, 3, and 5.
- Product Harness: covered by Task 3 and app integration in Task 5.
- Trace replay: covered by Task 4 and HTTP endpoint in Task 5.
- Readiness: covered by Task 6.
- Postgres authority: not implemented in this first slice; the event store interface is the required boundary for the next storage plan.
- Tool Platform v2, Permission Broker, A2A, Worker leases, and UI: intentionally separate plans because each is an independently testable subsystem.

Placeholder scan:

- No incomplete sections.
- No undefined file paths.
- No steps that ask workers to invent tests without exact assertions.

Type consistency:

- `AgentEventDraft`, `AgentEvent`, `AgentEventStore`, `runProductAgentSession`, and `buildAgentTrace` are defined before later tasks consume them.
- App server tests assert `runId`, `sessionId`, and `eventCursor`, which Task 5 adds to the `/api/agent/run` response.

Implementation boundary:

- Existing `runAgentIntent` behavior remains intact.
- Existing `/api/events` SSE remains intact.
- New replay APIs are additive.
