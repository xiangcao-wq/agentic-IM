# AgentBridge Workbench Timeline Permission Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the existing Agent EventLog and Trace APIs to the product Workbench so each Agent run shows a replayable timeline and a first Permission Center view.

**Architecture:** Keep the server EventLog as the source of truth and add browser-side contracts for `/api/traces/:runId` and `/api/agent-runs/:runId/events`. Convert raw `AgentEvent` records into small Workbench view models in a pure client module, then render those models inside the existing compact Agent Workbench without exposing raw SSE progress noise.

**Tech Stack:** TypeScript, React 19, Vitest, existing Vite app, existing Agent EventLog/Trace backend APIs, existing `AgentToolInvocationSnapshot` domain type.

---

## Scope

This slice builds the first product-facing run observability surface:

- `apiClient` can fetch run traces and event pages.
- `AgentRunResult` exposes `runId`, `sessionId`, and `eventCursor`.
- The Workbench fetches trace replay after a run completes.
- A compact timeline shows run/tool/permission events from trace replay.
- A compact permission center shows allow/deny/ask decisions and required permissions.
- Existing SSE `agent-progress` events remain internal/live plumbing and do not reappear as a raw progress list.

Out of scope for this slice:

- Postgres event storage.
- Cross-run trace search.
- Policy editing UI.
- Long-form developer trace viewer with raw payload JSON.
- Server API changes. The required endpoints already exist on `main`.

## File Structure

- Modify `src/domain/types.ts`
  - Add shared browser-safe `AgentEvent`, `AgentTrace`, and `AgentRunEventPage` contracts.
  - Add optional `runId`, `sessionId`, and `eventCursor` to `AgentRunResult`.
- Modify `src/client/apiClient.ts`
  - Add `getAgentTrace(baseUrl, runId)` and `listAgentRunEvents(baseUrl, input)`.
- Modify `src/client/apiClient.test.ts`
  - Cover URL encoding, token-safe GET requests, and trace/event replay endpoints.
- Create `src/client/agentTimeline.ts`
  - Own the pure mapping from `AgentTrace.events` to Workbench timeline rows and permission rows.
- Create `src/client/agentTimeline.test.ts`
  - Cover allowed, denied, ask, failed, and skipped raw progress behavior.
- Modify `src/App.tsx`
  - Fetch trace replay after a successful `runAgent` response with `runId`.
  - Pass trace state into `AgentWorkbench`.
  - Render `AgentTracePanel` in the existing output area only after an Agent run has trace state.
- Modify `src/App.test.tsx`
  - Add `getAgentTrace` mock coverage.
  - Verify trace fetch and Workbench rendering.
  - Verify trace replay failure does not replace the actual Agent result.
- Modify `src/styles.css`
  - Add compact, dense styles for timeline and permission rows.
- Modify `docs/superpowers/status/2026-05-07-agent-system-product-readiness.md`
  - Record this slice after implementation.

## Event UI Contract

The Workbench should render these raw trace event types as product labels:

| Event type | Timeline title | Permission center |
| --- | --- | --- |
| `agent.run.created` | `Run queued` | no |
| `agent.run.started` | `Run started` | no |
| `agent.progress` | skipped in v1 UI | no |
| `agent.tool.requested` | `Tool requested` | no |
| `agent.permission.allowed` | `Permission allowed` | yes, outcome `allow` |
| `agent.permission.denied` | `Permission denied` | yes, outcome `deny` |
| `agent.permission.requested` | `Permission needs review` | yes, outcome `ask` |
| `agent.tool.completed` | `Tool completed` | no |
| `agent.tool.failed` | `Tool failed` | no |
| `agent.run.completed` | `Run completed` | no |
| `agent.run.failed` | `Run failed` | no |
| `agent.run.cancelled` | `Run cancelled` | no |

`agent.progress` is intentionally skipped because current product tests require low-level progress events to stay out of the compact Workbench.

---

### Task 1: Add Browser-Safe Trace Contracts And API Methods

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/client/apiClient.ts`
- Modify: `src/client/apiClient.test.ts`

- [ ] **Step 1: Extend shared domain types**

In `src/domain/types.ts`, add this block immediately after `AgentProgressEvent`:

```ts
export type AgentEventVisibility = 'user' | 'internal' | 'audit';

export type AgentEventType =
  | 'agent.run.created'
  | 'agent.run.started'
  | 'agent.progress'
  | 'agent.tool.requested'
  | 'agent.permission.allowed'
  | 'agent.permission.denied'
  | 'agent.permission.requested'
  | 'agent.tool.completed'
  | 'agent.tool.failed'
  | 'agent.run.completed'
  | 'agent.run.failed'
  | 'agent.run.cancelled';

export type AgentEventPayload = Record<string, unknown>;

export interface AgentEvent {
  id: string;
  sequence: number;
  cursor: string;
  type: AgentEventType;
  tenantId: string;
  sessionId: string;
  runId: string;
  agentId?: string;
  roomId?: string;
  visibility: AgentEventVisibility;
  phase?: string;
  label?: string;
  detail?: string;
  toolCalls: string[];
  riskLevel?: RiskLevel;
  payload: AgentEventPayload;
  createdAt: string;
}

export interface AgentRunEventPage {
  events: AgentEvent[];
  nextCursor?: string;
}

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
  eventCount: number;
  truncated?: boolean;
  events: AgentEvent[];
}
```

Then change `AgentRunResult` in the same file to include replay metadata at the top:

```ts
export interface AgentRunResult {
  runId?: string;
  sessionId?: string;
  eventCursor?: string;
  intent: AgentRunIntent;
  requiresHuman: boolean;
  plan?: string;
  reasoning?: string;
  result?: RoomSummary | DeadlineAnswer | FileShareAction | SendMessageAction | CoordinationResult | ChatResult | WebSearchAnswer;
  files?: FileItem[];
  message?: Message;
  memory?: MemoryItem;
  log: AgentActionLog;
  actionRequest?: AgentActionRequest;
}
```

- [ ] **Step 2: Add failing API client tests**

In `src/client/apiClient.test.ts`, add `getAgentTrace` and `listAgentRunEvents` to the import list:

```ts
  getAgentTrace,
  listAgentRunEvents,
```

Add this test before `it('uses runtime upgrade endpoints', ...)`:

```ts
  it('uses Agent trace replay endpoints', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) =>
      Response.json({
        events: [],
        runId: 'agent-run-1',
        status: 'completed',
        phases: [],
        toolCalls: [],
        eventCount: 0
      })
    );

    await listAgentRunEvents('/api-root/', {
      runId: 'agent-run/1',
      cursor: 'seq:2',
      limit: 10
    }, fetchMock);
    await getAgentTrace('/api-root/', 'agent-run/1', fetchMock);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api-root/api/agent-runs/agent-run%2F1/events?cursor=seq%3A2&limit=10',
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api-root/api/traces/agent-run%2F1',
      expect.any(Object)
    );
  });
```

- [ ] **Step 3: Run the focused API client test and verify failure**

Run:

```bash
npm run test -- src/client/apiClient.test.ts
```

Expected: FAIL because `getAgentTrace` and `listAgentRunEvents` are not exported yet.

- [ ] **Step 4: Implement API client methods**

In `src/client/apiClient.ts`, extend the type import from `../domain/types`:

```ts
  AgentRunEventPage,
  AgentTrace,
```

Add this input interface after `RunPendingAutopilotInput`:

```ts
export interface ListAgentRunEventsInput {
  runId: string;
  cursor?: string;
  limit?: number;
}
```

Add these functions immediately after `runAgent`:

```ts
export function listAgentRunEvents(
  baseUrl: string,
  input: ListAgentRunEventsInput,
  fetcher: Fetcher = fetch
): Promise<AgentRunEventPage> {
  const params = new URLSearchParams();
  if (input.cursor) {
    params.set('cursor', input.cursor);
  }
  if (input.limit !== undefined) {
    params.set('limit', String(input.limit));
  }
  const query = params.toString();
  const suffix = query ? `?${query}` : '';
  return requestJson(
    fetcher,
    endpoint(baseUrl, `/api/agent-runs/${encodeURIComponent(input.runId)}/events${suffix}`)
  );
}

export function getAgentTrace(
  baseUrl: string,
  runId: string,
  fetcher: Fetcher = fetch
): Promise<AgentTrace> {
  return requestJson(fetcher, endpoint(baseUrl, `/api/traces/${encodeURIComponent(runId)}`));
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run test -- src/client/apiClient.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add src/domain/types.ts src/client/apiClient.ts src/client/apiClient.test.ts
git commit -m "feat: add agent trace client contracts"
```

---

### Task 2: Add Pure Timeline And Permission View Models

**Files:**
- Create: `src/client/agentTimeline.ts`
- Create: `src/client/agentTimeline.test.ts`

- [ ] **Step 1: Write failing timeline model tests**

Create `src/client/agentTimeline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentTrace } from '../domain/types';
import { buildAgentTimelineItems, buildPermissionCenterItems } from './agentTimeline';

describe('agent timeline view models', () => {
  it('builds timeline rows without exposing raw progress events', () => {
    const trace = traceWith([
      event(1, { type: 'agent.run.created', label: 'created' }),
      event(2, { type: 'agent.progress', label: 'raw planning detail', phase: 'planning' }),
      event(3, {
        type: 'agent.tool.requested',
        label: 'Tool requested: message.send',
        detail: 'tool-invocation-1',
        toolCalls: ['message.send'],
        payload: {
          toolName: 'message.send',
          invocationId: 'tool-invocation-1'
        }
      }),
      event(4, {
        type: 'agent.permission.allowed',
        label: 'Permission allowed: message.send',
        detail: 'policy allow',
        toolCalls: ['message.send'],
        riskLevel: 'low',
        payload: {
          invocationId: 'tool-invocation-1',
          toolName: 'message.send',
          permissionOutcome: 'allow',
          requiredPermissions: ['message:send'],
          requiresHuman: false,
          reasons: ['policy allow']
        }
      }),
      event(5, {
        type: 'agent.tool.completed',
        label: 'Tool completed: message.send',
        toolCalls: ['message.send'],
        payload: {
          invocationId: 'tool-invocation-1',
          toolName: 'message.send',
          status: 'completed'
        }
      }),
      event(6, { type: 'agent.run.completed', label: 'done' })
    ]);

    const rows = buildAgentTimelineItems(trace);

    expect(rows.map((row) => row.title)).toEqual([
      'Run queued',
      'Tool requested',
      'Permission allowed',
      'Tool completed',
      'Run completed'
    ]);
    expect(rows.map((row) => row.detail).join(' ')).not.toContain('raw planning detail');
    expect(rows[2]).toMatchObject({
      toolName: 'message.send',
      riskLevel: 'low',
      tone: 'success'
    });
  });

  it('builds permission rows for allow, deny, and ask decisions', () => {
    const trace = traceWith([
      permissionEvent(1, 'agent.permission.allowed', 'allow', 'message.send', 'policy allow', ['message:send'], false),
      permissionEvent(2, 'agent.permission.denied', 'deny', 'file.share', 'target room blocked', ['file:share'], false),
      permissionEvent(3, 'agent.permission.requested', 'ask', 'file.share', 'needs owner review', ['file:share'], true)
    ]);

    const permissions = buildPermissionCenterItems(trace);

    expect(permissions).toEqual([
      expect.objectContaining({
        invocationId: 'invocation-1',
        toolName: 'message.send',
        outcome: 'allow',
        label: 'Allowed',
        requiredPermissions: ['message:send'],
        requiresHuman: false,
        reason: 'policy allow'
      }),
      expect.objectContaining({
        invocationId: 'invocation-2',
        toolName: 'file.share',
        outcome: 'deny',
        label: 'Denied',
        reason: 'target room blocked'
      }),
      expect.objectContaining({
        invocationId: 'invocation-3',
        toolName: 'file.share',
        outcome: 'ask',
        label: 'Needs review',
        requiresHuman: true,
        reason: 'needs owner review'
      })
    ]);
  });

  it('returns empty arrays without a trace', () => {
    expect(buildAgentTimelineItems(null)).toEqual([]);
    expect(buildPermissionCenterItems(undefined)).toEqual([]);
  });
});

function permissionEvent(
  sequence: number,
  type: AgentEvent['type'],
  outcome: 'allow' | 'deny' | 'ask',
  toolName: string,
  reason: string,
  requiredPermissions: string[],
  requiresHuman: boolean
): AgentEvent {
  return event(sequence, {
    type,
    label: `${type}: ${toolName}`,
    detail: reason,
    toolCalls: [toolName],
    riskLevel: outcome === 'deny' ? 'high' : outcome === 'ask' ? 'medium' : 'low',
    payload: {
      invocationId: `invocation-${sequence}`,
      toolName,
      permissionOutcome: outcome,
      requiredPermissions,
      requiresHuman,
      reviewerIds: requiresHuman ? ['user-lin'] : [],
      reasons: [reason]
    }
  });
}

function traceWith(events: AgentEvent[]): AgentTrace {
  return {
    runId: 'agent-run-ui',
    sessionId: 'agent-session-ui',
    tenantId: 'local',
    agentId: 'agent-lin',
    roomId: 'room-team',
    status: 'completed',
    startedAt: events[0]?.createdAt,
    finishedAt: events.at(-1)?.createdAt,
    phases: [],
    toolCalls: [...new Set(events.flatMap((item) => item.toolCalls))],
    eventCount: events.length,
    events
  };
}

function event(sequence: number, overrides: Partial<AgentEvent>): AgentEvent {
  return {
    id: `agent-run-ui-event-${String(sequence).padStart(8, '0')}`,
    sequence,
    cursor: `seq:${sequence}`,
    type: 'agent.run.created',
    tenantId: 'local',
    sessionId: 'agent-session-ui',
    runId: 'agent-run-ui',
    agentId: 'agent-lin',
    roomId: 'room-team',
    visibility: 'audit',
    toolCalls: [],
    payload: {},
    createdAt: `2026-05-09T00:00:0${sequence}.000Z`,
    ...overrides
  };
}
```

- [ ] **Step 2: Run timeline model tests and verify failure**

Run:

```bash
npm run test -- src/client/agentTimeline.test.ts
```

Expected: FAIL because `src/client/agentTimeline.ts` does not exist.

- [ ] **Step 3: Implement timeline model module**

Create `src/client/agentTimeline.ts`:

```ts
import type {
  AgentEvent,
  AgentEventType,
  AgentPermissionOutcome,
  AgentToolInvocationSnapshot,
  AgentToolName,
  AgentTrace,
  RiskLevel
} from '../domain/types';

export type AgentTimelineTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface AgentTimelineItem {
  id: string;
  type: AgentEventType;
  title: string;
  detail: string;
  timestamp: string;
  tone: AgentTimelineTone;
  toolName?: AgentToolName | string;
  riskLevel?: RiskLevel;
}

export interface PermissionCenterItem {
  id: string;
  invocationId: string;
  toolName: AgentToolName | string;
  outcome: AgentPermissionOutcome;
  label: string;
  requiredPermissions: string[];
  requiresHuman: boolean;
  reviewerIds: string[];
  reason: string;
  timestamp: string;
  riskLevel?: RiskLevel;
}

const SKIPPED_TIMELINE_EVENT_TYPES = new Set<AgentEventType>(['agent.progress']);

export function buildAgentTimelineItems(trace?: AgentTrace | null): AgentTimelineItem[] {
  if (!trace) {
    return [];
  }

  return trace.events
    .filter((event) => !SKIPPED_TIMELINE_EVENT_TYPES.has(event.type))
    .map((event) => ({
      id: event.id,
      type: event.type,
      title: timelineTitle(event.type),
      detail: timelineDetail(event),
      timestamp: event.createdAt,
      tone: timelineTone(event.type),
      ...(readToolName(event) ? { toolName: readToolName(event) } : {}),
      ...(event.riskLevel ? { riskLevel: event.riskLevel } : {})
    }));
}

export function buildPermissionCenterItems(trace?: AgentTrace | null): PermissionCenterItem[] {
  if (!trace) {
    return [];
  }

  return trace.events
    .filter(isPermissionEvent)
    .map((event) => {
      const invocation = readInvocation(event);
      const outcome = permissionOutcome(event);
      const invocationId = readString(event.payload.invocationId) ?? invocation?.id ?? event.id;
      const requiredPermissions = readStringArray(event.payload.requiredPermissions) ?? invocation?.requiredPermissions ?? [];
      const reviewerIds = readStringArray(event.payload.reviewerIds) ?? invocation?.reviewerIds ?? [];
      const reason =
        readStringArray(event.payload.reasons)?.[0] ??
        invocation?.reasons[0] ??
        event.detail ??
        event.label ??
        outcome;

      return {
        id: event.id,
        invocationId,
        toolName: readToolName(event) ?? invocation?.toolName ?? 'unknown.tool',
        outcome,
        label: permissionLabel(outcome),
        requiredPermissions,
        requiresHuman: readBoolean(event.payload.requiresHuman) ?? invocation?.requiresHuman ?? outcome === 'ask',
        reviewerIds,
        reason,
        timestamp: event.createdAt,
        ...(event.riskLevel ? { riskLevel: event.riskLevel } : {})
      };
    });
}

function isPermissionEvent(event: AgentEvent): boolean {
  return (
    event.type === 'agent.permission.allowed' ||
    event.type === 'agent.permission.denied' ||
    event.type === 'agent.permission.requested'
  );
}

function permissionOutcome(event: AgentEvent): AgentPermissionOutcome {
  if (event.type === 'agent.permission.allowed') {
    return 'allow';
  }
  if (event.type === 'agent.permission.denied') {
    return 'deny';
  }
  return 'ask';
}

function permissionLabel(outcome: AgentPermissionOutcome): string {
  if (outcome === 'allow') {
    return 'Allowed';
  }
  if (outcome === 'deny') {
    return 'Denied';
  }
  return 'Needs review';
}

function timelineTitle(type: AgentEventType): string {
  const titles: Record<AgentEventType, string> = {
    'agent.run.created': 'Run queued',
    'agent.run.started': 'Run started',
    'agent.progress': 'Progress',
    'agent.tool.requested': 'Tool requested',
    'agent.permission.allowed': 'Permission allowed',
    'agent.permission.denied': 'Permission denied',
    'agent.permission.requested': 'Permission needs review',
    'agent.tool.completed': 'Tool completed',
    'agent.tool.failed': 'Tool failed',
    'agent.run.completed': 'Run completed',
    'agent.run.failed': 'Run failed',
    'agent.run.cancelled': 'Run cancelled'
  };
  return titles[type];
}

function timelineTone(type: AgentEventType): AgentTimelineTone {
  if (type === 'agent.permission.denied' || type === 'agent.tool.failed' || type === 'agent.run.failed') {
    return 'danger';
  }
  if (type === 'agent.permission.requested') {
    return 'warning';
  }
  if (
    type === 'agent.permission.allowed' ||
    type === 'agent.tool.completed' ||
    type === 'agent.run.completed'
  ) {
    return 'success';
  }
  return 'neutral';
}

function timelineDetail(event: AgentEvent): string {
  const status = readString(event.payload.status);
  const outcome = readString(event.payload.permissionOutcome);
  const reason = readStringArray(event.payload.reasons)?.[0];
  return event.detail ?? reason ?? status ?? outcome ?? event.label ?? event.type;
}

function readToolName(event: AgentEvent): AgentToolName | string | undefined {
  return readString(event.payload.toolName) ?? event.toolCalls[0];
}

function readInvocation(event: AgentEvent): AgentToolInvocationSnapshot | undefined {
  const value = event.payload.invocation;
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.id !== 'string' || typeof value.toolName !== 'string') {
    return undefined;
  }
  return value as unknown as AgentToolInvocationSnapshot;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 4: Run focused timeline tests**

Run:

```bash
npm run test -- src/client/agentTimeline.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add src/client/agentTimeline.ts src/client/agentTimeline.test.ts
git commit -m "feat: model agent trace timeline"
```

---

### Task 3: Fetch Trace Replay From The Workbench Runtime Path

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`

- [ ] **Step 1: Extend App test API mocks**

In `src/App.test.tsx`, add `getAgentTrace` to `apiMocks`:

```ts
  getAgentTrace: vi.fn(),
```

In `beforeEach`, add this default:

```ts
    apiMocks.getAgentTrace.mockResolvedValue(createAgentTrace());
```

Add this helper after `createAgentRunResult`:

```ts
function createAgentTrace() {
  return {
    runId: 'agent-run-ui',
    sessionId: 'agent-session-ui',
    tenantId: 'local',
    agentId: 'agent-lin',
    roomId: 'room-team',
    status: 'completed' as const,
    startedAt: '2026-05-09T00:00:01.000Z',
    finishedAt: '2026-05-09T00:00:05.000Z',
    phases: ['executing'],
    toolCalls: ['message.send'],
    eventCount: 5,
    events: [
      {
        id: 'agent-run-ui-event-00000001',
        sequence: 1,
        cursor: 'seq:1',
        type: 'agent.run.created' as const,
        tenantId: 'local',
        sessionId: 'agent-session-ui',
        runId: 'agent-run-ui',
        agentId: 'agent-lin',
        roomId: 'room-team',
        visibility: 'internal' as const,
        toolCalls: [],
        payload: {},
        createdAt: '2026-05-09T00:00:01.000Z'
      },
      {
        id: 'agent-run-ui-event-00000002',
        sequence: 2,
        cursor: 'seq:2',
        type: 'agent.tool.requested' as const,
        tenantId: 'local',
        sessionId: 'agent-session-ui',
        runId: 'agent-run-ui',
        agentId: 'agent-lin',
        roomId: 'room-team',
        visibility: 'audit' as const,
        toolCalls: ['message.send'],
        payload: {
          invocationId: 'tool-invocation-ui',
          toolName: 'message.send'
        },
        createdAt: '2026-05-09T00:00:02.000Z'
      },
      {
        id: 'agent-run-ui-event-00000003',
        sequence: 3,
        cursor: 'seq:3',
        type: 'agent.permission.allowed' as const,
        tenantId: 'local',
        sessionId: 'agent-session-ui',
        runId: 'agent-run-ui',
        agentId: 'agent-lin',
        roomId: 'room-team',
        visibility: 'audit' as const,
        detail: 'policy allow',
        riskLevel: 'low' as const,
        toolCalls: ['message.send'],
        payload: {
          invocationId: 'tool-invocation-ui',
          toolName: 'message.send',
          permissionOutcome: 'allow',
          requiredPermissions: ['message:send'],
          requiresHuman: false,
          reviewerIds: [],
          reasons: ['policy allow']
        },
        createdAt: '2026-05-09T00:00:03.000Z'
      },
      {
        id: 'agent-run-ui-event-00000004',
        sequence: 4,
        cursor: 'seq:4',
        type: 'agent.tool.completed' as const,
        tenantId: 'local',
        sessionId: 'agent-session-ui',
        runId: 'agent-run-ui',
        agentId: 'agent-lin',
        roomId: 'room-team',
        visibility: 'audit' as const,
        toolCalls: ['message.send'],
        payload: {
          invocationId: 'tool-invocation-ui',
          toolName: 'message.send',
          status: 'completed'
        },
        createdAt: '2026-05-09T00:00:04.000Z'
      },
      {
        id: 'agent-run-ui-event-00000005',
        sequence: 5,
        cursor: 'seq:5',
        type: 'agent.run.completed' as const,
        tenantId: 'local',
        sessionId: 'agent-session-ui',
        runId: 'agent-run-ui',
        agentId: 'agent-lin',
        roomId: 'room-team',
        visibility: 'internal' as const,
        toolCalls: ['message.send'],
        payload: {},
        createdAt: '2026-05-09T00:00:05.000Z'
      }
    ]
  };
}
```

- [ ] **Step 2: Write failing App behavior tests**

In `src/App.test.tsx`, add these tests before `it('submits the Agent input as free chat and renders the chat reply', ...)`:

```ts
  it('fetches trace replay after an Agent run and renders audit timeline data', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult({
      runId: 'agent-run-ui',
      sessionId: 'agent-session-ui',
      eventCursor: 'seq:5',
      intent: 'send_message',
      log: {
        toolCalls: ['message.send']
      } as Partial<AgentRunResult['log']> as AgentRunResult['log']
    }));

    await act(async () => {
      root.render(<App />);
    });

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    expect(prompt).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, 'Tell Chen I will send the notes.');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(apiMocks.getAgentTrace).toHaveBeenCalledWith('', 'agent-run-ui');
    expect(host.querySelector('[data-testid="agent-trace-panel"]')).toBeTruthy();
    expect(host.textContent).toContain('Agent Timeline');
    expect(host.textContent).toContain('Permission Center');
    expect(host.textContent).toContain('Tool requested');
    expect(host.textContent).toContain('Permission allowed');
    expect(host.textContent).toContain('message.send');
    expect(host.textContent).toContain('message:send');
  });

  it('keeps the Agent result visible when trace replay is unavailable', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult({
      runId: 'agent-run-missing-trace',
      result: {
        reply: 'The answer still renders.'
      }
    }));
    apiMocks.getAgentTrace.mockRejectedValueOnce(new Error('trace not found'));

    await act(async () => {
      root.render(<App />);
    });

    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('The answer still renders.');
    expect(host.textContent).toContain('Trace unavailable');
    expect(host.textContent).not.toContain('trace not found');
  });
```

- [ ] **Step 3: Run App tests and verify failure**

Run:

```bash
npm run test -- src/App.test.tsx
```

Expected: FAIL because `App.tsx` does not fetch or render trace replay yet.

- [ ] **Step 4: Add trace state and fetch logic to App**

In `src/App.tsx`, add `getAgentTrace` to the client imports:

```ts
  getAgentTrace,
```

Add `AgentTrace` to the domain type import:

```ts
  AgentTrace,
```

Add this import after `sortMessagesChronologically`:

```ts
import {
  buildAgentTimelineItems,
  buildPermissionCenterItems,
  type AgentTimelineItem,
  type PermissionCenterItem
} from './client/agentTimeline';
```

Add this type near the existing local UI types:

```ts
type AgentTraceLoadStatus = 'idle' | 'loading' | 'ready' | 'unavailable';
```

Inside `App()`, add state next to `agentResult`:

```ts
  const [agentTrace, setAgentTrace] = useState<AgentTrace | null>(null);
  const [agentTraceStatus, setAgentTraceStatus] = useState<AgentTraceLoadStatus>('idle');
```

Replace `runAgentWorkbenchAction` with:

```ts
  async function runAgentWorkbenchAction(label: string, request: AgentRunRequest): Promise<AgentRunResult | undefined> {
    const runId = agentRunSequenceRef.current + 1;
    agentRunSequenceRef.current = runId;
    setBusyAction(label);
    setError(null);
    setAgentTrace(null);
    setAgentTraceStatus('idle');
    eventStreamErrorVisibleRef.current = false;
    try {
      const response = await runAgent(apiBaseUrl, request);
      if (agentRunSequenceRef.current === runId) {
        setAgentResult({ kind: 'agent-run', value: response });
      }
      if (response.runId) {
        if (agentRunSequenceRef.current === runId) {
          setAgentTraceStatus('loading');
        }
        const trace = await getAgentTrace(apiBaseUrl, response.runId).catch(() => null);
        if (agentRunSequenceRef.current === runId) {
          setAgentTrace(trace);
          setAgentTraceStatus(trace ? 'ready' : 'unavailable');
        }
      }
      await refreshState();
      return response;
    } catch (actionError) {
      if (agentRunSequenceRef.current === runId) {
        eventStreamErrorVisibleRef.current = false;
        setAgentTrace(null);
        setAgentTraceStatus('idle');
        setError(actionError instanceof Error ? actionError.message : '操作失败');
      }
      return undefined;
    } finally {
      if (agentRunSequenceRef.current === runId) {
        setBusyAction(null);
      }
    }
  }
```

Pass the new props into `AgentWorkbench`:

```tsx
          trace={agentTrace}
          traceStatus={agentTraceStatus}
```

Add these props to the `AgentWorkbench` props type:

```ts
  trace: AgentTrace | null;
  traceStatus: AgentTraceLoadStatus;
```

- [ ] **Step 5: Add trace panel rendering to AgentWorkbench**

Inside `AgentWorkbench`, add these derived values after `resultKey`:

```ts
  const timelineItems = useMemo(() => buildAgentTimelineItems(props.trace), [props.trace]);
  const permissionItems = useMemo(() => buildPermissionCenterItems(props.trace), [props.trace]);
```

Inside the `agent-output-area`, immediately after the `AnimatePresence` result block, add:

```tsx
        {props.result?.kind === 'agent-run' && (props.trace || props.traceStatus !== 'idle') ? (
          <AgentTracePanel
            trace={props.trace}
            traceStatus={props.traceStatus}
            timelineItems={timelineItems}
            permissionItems={permissionItems}
          />
        ) : null}
```

Add this component above `AgentBusyPanel`:

```tsx
function AgentTracePanel(props: {
  trace: AgentTrace | null;
  traceStatus: AgentTraceLoadStatus;
  timelineItems: AgentTimelineItem[];
  permissionItems: PermissionCenterItem[];
}) {
  if (props.traceStatus === 'loading') {
    return (
      <section className="data-section agent-trace-section" data-testid="agent-trace-panel">
        <div className="section-title">
          <ClipboardList size={17} />
          <h3>Agent Timeline</h3>
        </div>
        <div className="compact-row is-running">
          <strong>Loading trace</strong>
          <span>Waiting for replay data</span>
        </div>
      </section>
    );
  }

  if (props.traceStatus === 'unavailable') {
    return (
      <section className="data-section agent-trace-section" data-testid="agent-trace-panel">
        <div className="section-title">
          <ClipboardList size={17} />
          <h3>Agent Timeline</h3>
        </div>
        <div className="compact-row is-empty">
          <strong>Trace unavailable</strong>
          <span>Run result is available, but replay data could not be loaded.</span>
        </div>
      </section>
    );
  }

  if (!props.trace) {
    return null;
  }

  const visibleTimeline = props.timelineItems.slice(-8);

  return (
    <section className="data-section agent-trace-section" data-testid="agent-trace-panel">
      <div className="section-title">
        <ClipboardList size={17} />
        <h3>Agent Timeline</h3>
      </div>
      <div className="trace-summary-row">
        <strong>{props.trace.status}</strong>
        <span>
          {props.trace.eventCount} events · {props.trace.toolCalls.join(', ') || 'no tools'}
          {props.trace.truncated ? ' · truncated' : ''}
        </span>
      </div>
      <div className="compact-list agent-timeline-list">
        {visibleTimeline.map((item) => (
          <div className={`compact-row trace-row tone-${item.tone}`} key={item.id}>
            <strong>
              <span>{item.title}</span>
              {item.riskLevel ? <em>{item.riskLevel}</em> : null}
            </strong>
            <span>
              {item.toolName ? `${item.toolName} · ` : ''}
              {item.detail} · {formatTime(item.timestamp)}
            </span>
          </div>
        ))}
      </div>

      <div className="section-title permission-title">
        <ShieldCheck size={17} />
        <h3>Permission Center</h3>
      </div>
      <div className="compact-list permission-center-list">
        {props.permissionItems.length > 0 ? (
          props.permissionItems.map((item) => (
            <div className={`compact-row permission-row outcome-${item.outcome}`} key={item.id}>
              <strong>
                <span>{item.label}</span>
                <em>{item.toolName}</em>
              </strong>
              <span>
                {item.requiredPermissions.join(', ') || 'no scoped permission'} ·{' '}
                {item.requiresHuman ? 'human review' : 'policy auto'} · {formatTime(item.timestamp)}
              </span>
              <small>{item.reason}</small>
            </div>
          ))
        ) : (
          <div className="compact-row is-empty">
            <strong>No permission decision</strong>
            <span>This run did not request a permissioned tool.</span>
          </div>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Run App tests**

Run:

```bash
npm run test -- src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

Run:

```bash
git add src/App.tsx src/App.test.tsx
git commit -m "feat: render agent trace replay in workbench"
```

---

### Task 4: Add Dense Product Styles For Timeline And Permission Rows

**Files:**
- Modify: `src/styles.css`
- Modify: `src/App.test.tsx`

- [ ] **Step 1: Add a small class assertion to the App test**

In the `fetches trace replay after an Agent run and renders audit timeline data` test from Task 3, add these assertions after the existing text assertions:

```ts
    expect(host.querySelector('.agent-timeline-list .trace-row')).toBeTruthy();
    expect(host.querySelector('.permission-center-list .permission-row')).toBeTruthy();
```

- [ ] **Step 2: Run App tests and verify current behavior**

Run:

```bash
npm run test -- src/App.test.tsx
```

Expected: PASS for behavior. The next CSS step improves visual density and does not need a failing visual unit test.

- [ ] **Step 3: Add CSS**

In `src/styles.css`, add this block after the existing `.a2a-confirmation-hint` block:

```css
.agent-trace-section {
  display: grid;
  gap: 10px;
}

.trace-summary-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid #d7e5e7;
  border-radius: 8px;
  padding: 9px 10px;
  background: #fbfdfd;
}

.trace-summary-row strong {
  color: #213235;
  font-size: 12px;
  text-transform: uppercase;
}

.trace-summary-row span {
  color: #657477;
  font-size: 12px;
  font-weight: 700;
}

.permission-title {
  margin-top: 4px;
}

.trace-row,
.permission-row {
  border: 1px solid #d8e4e6;
}

.trace-row.tone-success,
.permission-row.outcome-allow {
  border-color: #bee1cd;
  background: #f0faf4;
}

.trace-row.tone-warning,
.permission-row.outcome-ask {
  border-color: #efd69c;
  background: #fff8e8;
}

.trace-row.tone-danger,
.permission-row.outcome-deny {
  border-color: #e8c6ce;
  background: #fff1f3;
}

.trace-row em,
.permission-row em {
  margin-left: auto;
  border-radius: 999px;
  padding: 2px 7px;
  color: #0f6970;
  background: #e7f3f2;
  font-style: normal;
  font-size: 11px;
}

.permission-row.outcome-deny em {
  color: #a23a4f;
  background: #ffe8ed;
}

.permission-row.outcome-ask em {
  color: #986315;
  background: #fff3d7;
}

.permission-row small {
  display: block;
  margin-top: 5px;
  color: #657477;
  font-size: 12px;
  line-height: 1.4;
}
```

- [ ] **Step 4: Run focused App tests**

Run:

```bash
npm run test -- src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add src/styles.css src/App.test.tsx
git commit -m "style: polish agent trace workbench panels"
```

---

### Task 5: Update Product Readiness Status And Run Full Verification

**Files:**
- Modify: `docs/superpowers/status/2026-05-07-agent-system-product-readiness.md`

- [ ] **Step 1: Update readiness status**

Append this section to `docs/superpowers/status/2026-05-07-agent-system-product-readiness.md`:

```markdown
## 2026-05-09 Workbench Timeline + Permission Center Slice

Implemented the fourth Product Kernel slice:

- Browser client now has typed contracts for Agent run event replay and trace replay.
- Agent Workbench fetches `/api/traces/:runId` after product Agent runs.
- Workbench renders a compact Agent Timeline from replayed run, tool, and permission events.
- Workbench renders a first Permission Center from `agent.permission.*` events.
- Raw SSE progress remains hidden from the compact Workbench; replayed EventLog data is the product-facing source.

Remaining gap: this is a per-run Workbench surface. Cross-run trace search, policy editing, and Postgres-backed audit querying remain future product slices.
```

- [ ] **Step 2: Run focused verification**

Run:

```bash
npm run test -- src/client/apiClient.test.ts src/client/agentTimeline.test.ts src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```bash
npm run test
```

Expected: PASS.

- [ ] **Step 4: Run production build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

Run:

```bash
git add docs/superpowers/status/2026-05-07-agent-system-product-readiness.md
git commit -m "docs: record workbench trace slice"
```

---

## Review Checklist

- [ ] `AgentRunResult` includes replay identifiers but remains backward compatible because every new field is optional.
- [ ] `agent.progress` events are not rendered in the compact Workbench timeline.
- [ ] Trace fetch failures do not hide the actual Agent answer or action result.
- [ ] `apiClient` uses `encodeURIComponent(runId)` and sends API tokens via headers through existing `requestJson`.
- [ ] Timeline and Permission Center derive from `/api/traces/:runId`, not from mocked client-only state.
- [ ] No backend endpoint changes are included in this slice.
- [ ] Focused frontend tests, full test suite, and build pass before PR.

## Self-Review

Spec coverage:

- Permission Center初版: covered by Task 2 view model and Task 3 Workbench panel.
- Agent Trace初版: covered by Task 1 client contract and Task 3 trace replay fetch/render.
- EventLog as product-facing source: covered by using `/api/traces/:runId` and avoiding client-only generated audit data.
- Compact Workbench discipline: covered by skipping `agent.progress` and preserving existing low-level progress tests.

Placeholder scan:

- The plan contains exact file paths, concrete code blocks, exact commands, and expected outcomes.
- No task relies on an undefined helper; `createAgentTrace`, `AgentTracePanel`, `buildAgentTimelineItems`, and `buildPermissionCenterItems` are defined before use.

Type consistency:

- `AgentTrace`, `AgentEvent`, and `AgentRunEventPage` match the server replay payload shape already returned by `src/server/appServer.ts`.
- `PermissionCenterItem.outcome` uses existing `AgentPermissionOutcome`.
- `AgentTimelineItem.riskLevel` uses existing `RiskLevel`.
