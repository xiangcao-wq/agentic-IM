# Tool Audit EventLog Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist tool invocation and permission audit records as canonical AgentEvent timeline entries so `/api/agent-runs/:runId/events` and `/api/traces/:runId` replay actual tool and permission behavior.

**Architecture:** Keep `executeCoreTool` as the single source of tool audit truth, convert its `ToolInvocationRecord` into a domain-safe `AgentToolInvocationSnapshot`, and let `ProductHarness` translate those snapshots into canonical `agent.tool.*` and `agent.permission.*` events. Runtime paths only attach snapshots to existing progress events; EventLog/Trace remain the replay boundary.

**Tech Stack:** TypeScript, Vitest, Node server runtime, existing `AgentEventStore`, existing `ProductHarness`, existing core tool executor.

---

## File Structure

- Modify `src/domain/types.ts`
  - Owns transport-safe `AgentToolInvocationSnapshot` and extends `AgentProgressEvent`.
  - This avoids importing server-only `ToolInvocationRecord` into shared domain/UI types.
- Modify `src/server/agentCore/toolInvocationAudit.ts`
  - Adds `toolInvocationRecordToSnapshot(record)` as the boundary converter.
  - Keeps `ToolInvocationRecord` as the server-internal audit record.
- Modify `src/server/agentCore/toolInvocationAudit.test.ts`
  - Verifies snapshot conversion and defensive cloning.
- Modify `src/server/agentCore/agentEvents.ts`
  - Extends `AgentEventType` with tool and permission event names.
  - Preserves optional `toolInvocations` in progress payloads.
- Modify `src/server/agentCore/agentEvents.test.ts`
  - Verifies progress-to-event mapping carries invocation snapshots without mutation.
- Create `src/server/agentCore/toolEventAdapter.ts`
  - Converts `AgentToolInvocationSnapshot` into canonical event drafts.
  - Owns status/outcome-to-event mapping.
- Create `src/server/agentCore/toolEventAdapter.test.ts`
  - Verifies allow, deny, ask, failed, and validation-failed mappings.
- Modify `src/server/agentCore/productHarness.ts`
  - Reads `progress.toolInvocations` and appends tool/permission drafts after the related progress event.
  - Deduplicates by invocation id within a run.
- Modify `src/server/agentCore/productHarness.test.ts`
  - Verifies a real `send_message` run writes tool and permission events.
- Modify `src/server/agentRuntime.ts`
  - Returns `toolInvocation` from file-share runtime paths.
- Modify `src/server/agentRuntime.test.ts`
  - Verifies file-share runtime exposes the invocation snapshot.
- Modify `src/server/agentRunRuntime.ts`
  - Emits snapshots in progress events for `send_message` and `share_file`.
- Modify `src/server/appServer.test.ts`
  - Verifies replay and trace APIs include tool/permission events.
- Modify `docs/superpowers/status/2026-05-07-agent-system-product-readiness.md`
  - Records this slice as the audit bridge between Tool Platform v2 and Product Kernel EventLog.

## Event Contract

Add these event types:

```ts
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
```

Mapping rules:

| Invocation status | Permission outcome | Events |
| --- | --- | --- |
| `completed` | `allow` | `agent.tool.requested`, `agent.permission.allowed`, `agent.tool.completed` |
| `failed` | `allow` | `agent.tool.requested`, `agent.permission.allowed`, `agent.tool.failed` |
| `denied` | `deny` | `agent.tool.requested`, `agent.permission.denied`, `agent.tool.failed` |
| `awaiting_permission` | `ask` | `agent.tool.requested`, `agent.permission.requested` |
| `validation_failed` | undefined | `agent.tool.requested`, `agent.tool.failed` |

Do not introduce a separate permission storage table in this slice. The EventLog is the replayable source for now.

---

### Task 1: Add Domain-Level Tool Invocation Snapshots

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/server/agentCore/toolInvocationAudit.ts`
- Modify: `src/server/agentCore/toolInvocationAudit.test.ts`

- [ ] **Step 1: Write the failing snapshot conversion test**

Add this test case to `src/server/agentCore/toolInvocationAudit.test.ts` inside `describe('tool invocation audit', ...)`:

```ts
  it('converts invocation records into transport-safe snapshots', () => {
    const record = createToolInvocationRecord({
      id: 'tool-invocation-snapshot',
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'completed',
      permission,
      inputSummary: {
        targetRoomId: 'room-team',
        nested: { values: ['initial'] }
      },
      outputSummary: { messageId: 'msg-1' },
      evidenceIds: ['room-team'],
      createdAt: '2026-05-09T00:00:00.000Z'
    });

    const snapshot = toolInvocationRecordToSnapshot(record);

    record.requiredPermissions.push('mutated:permission');
    record.reasons.push('mutated reason');
    (record.inputSummary.nested as { values: string[] }).values.push('mutated');

    expect(snapshot).toMatchObject({
      id: 'tool-invocation-snapshot',
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'completed',
      permissionOutcome: 'allow',
      requiredPermissions: ['message:send'],
      requiresHuman: false,
      reviewerIds: [],
      reasons: ['allowed'],
      evidenceIds: ['room-team'],
      inputSummary: {
        targetRoomId: 'room-team',
        nested: { values: ['initial'] }
      },
      outputSummary: { messageId: 'msg-1' },
      createdAt: '2026-05-09T00:00:00.000Z'
    });
  });
```

Update the import at the top:

```ts
import { createToolInvocationRecord, toolInvocationRecordToSnapshot } from './toolInvocationAudit';
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm run test -- src/server/agentCore/toolInvocationAudit.test.ts
```

Expected: FAIL because `toolInvocationRecordToSnapshot` is not exported.

- [ ] **Step 3: Add snapshot types to the shared domain**

In `src/domain/types.ts`, add these types after `export type AgentToolName = ...`:

```ts
export type AgentToolInvocationStatus =
  | 'validation_failed'
  | 'denied'
  | 'awaiting_permission'
  | 'completed'
  | 'failed';

export type AgentPermissionOutcome = 'allow' | 'deny' | 'ask';

export interface AgentToolInvocationSnapshot {
  id: string;
  toolName: AgentToolName;
  agentId: string;
  roomId: string;
  status: AgentToolInvocationStatus;
  permissionOutcome?: AgentPermissionOutcome;
  requiredPermissions: string[];
  requiresHuman: boolean;
  risk?: RiskAssessment;
  reviewerIds: string[];
  reasons: string[];
  evidenceIds: string[];
  inputSummary: Record<string, unknown>;
  outputSummary: Record<string, unknown>;
  error?: string;
  createdAt: string;
}
```

Then extend `AgentProgressEvent`:

```ts
export interface AgentProgressEvent {
  id: string;
  runId: string;
  sequence: number;
  agentId: string;
  roomId: string;
  phase: AgentProgressPhase;
  label: string;
  detail?: string;
  toolCalls: string[];
  toolInvocations?: AgentToolInvocationSnapshot[];
  riskLevel?: RiskLevel;
  createdAt: string;
}
```

- [ ] **Step 4: Export the converter from `toolInvocationAudit.ts`**

At the top of `src/server/agentCore/toolInvocationAudit.ts`, update imports:

```ts
import type { AgentToolInvocationSnapshot, RiskAssessment } from '../../domain/types';
```

Add this function below `createToolInvocationRecord`:

```ts
export function toolInvocationRecordToSnapshot(record: ToolInvocationRecord): AgentToolInvocationSnapshot {
  return {
    id: record.id,
    toolName: record.toolName,
    agentId: record.agentId,
    roomId: record.roomId,
    status: record.status,
    permissionOutcome: record.permissionOutcome,
    requiredPermissions: [...record.requiredPermissions],
    requiresHuman: record.requiresHuman,
    risk: record.risk ? { ...record.risk } : undefined,
    reviewerIds: [...record.reviewerIds],
    reasons: [...record.reasons],
    evidenceIds: [...record.evidenceIds],
    inputSummary: cloneSummary(record.inputSummary),
    outputSummary: cloneSummary(record.outputSummary),
    error: record.error,
    createdAt: record.createdAt
  };
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run test -- src/server/agentCore/toolInvocationAudit.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/server/agentCore/toolInvocationAudit.ts src/server/agentCore/toolInvocationAudit.test.ts
git commit -m "feat: add tool invocation snapshots"
```

---

### Task 2: Add Tool And Permission Event Adapter

**Files:**
- Modify: `src/server/agentCore/agentEvents.ts`
- Modify: `src/server/agentCore/agentEvents.test.ts`
- Create: `src/server/agentCore/toolEventAdapter.ts`
- Create: `src/server/agentCore/toolEventAdapter.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Create `src/server/agentCore/toolEventAdapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { AgentToolInvocationSnapshot } from '../../domain/types';
import { toolInvocationToEventDrafts } from './toolEventAdapter';

const context = {
  tenantId: 'local',
  sessionId: 'session-1',
  runId: 'run-1'
};

const baseInvocation: AgentToolInvocationSnapshot = {
  id: 'tool-invocation-1',
  toolName: 'message.send',
  agentId: 'agent-lin',
  roomId: 'room-team',
  status: 'completed',
  permissionOutcome: 'allow',
  requiredPermissions: ['message:send'],
  requiresHuman: false,
  risk: {
    level: 'low',
    score: 0.1,
    reason: 'allowed',
    model: 'test-policy'
  },
  reviewerIds: [],
  reasons: ['allowed'],
  evidenceIds: ['room-team'],
  inputSummary: { targetRoomId: 'room-team' },
  outputSummary: { messageId: 'msg-1' },
  createdAt: '2026-05-09T00:00:00.000Z'
};

describe('tool invocation event adapter', () => {
  it('maps allowed completed invocations to requested, permission, and completed events', () => {
    const drafts = toolInvocationToEventDrafts(context, baseInvocation);

    expect(drafts.map((draft) => draft.type)).toEqual([
      'agent.tool.requested',
      'agent.permission.allowed',
      'agent.tool.completed'
    ]);
    expect(drafts.every((draft) => draft.visibility === 'audit')).toBe(true);
    expect(drafts.every((draft) => draft.toolCalls.includes('message.send'))).toBe(true);
    expect(drafts[0]).toMatchObject({
      tenantId: 'local',
      sessionId: 'session-1',
      runId: 'run-1',
      agentId: 'agent-lin',
      roomId: 'room-team',
      riskLevel: 'low'
    });
    expect(drafts[1].payload).toMatchObject({
      invocationId: 'tool-invocation-1',
      permissionOutcome: 'allow',
      requiredPermissions: ['message:send'],
      requiresHuman: false
    });
    expect(drafts[2].payload).toMatchObject({
      invocationId: 'tool-invocation-1',
      status: 'completed',
      outputSummary: { messageId: 'msg-1' }
    });
  });

  it('maps ask decisions to requested and permission requested without a terminal tool event', () => {
    const drafts = toolInvocationToEventDrafts(context, {
      ...baseInvocation,
      id: 'tool-invocation-ask',
      toolName: 'file.share',
      status: 'awaiting_permission',
      permissionOutcome: 'ask',
      requiredPermissions: ['file:share'],
      requiresHuman: true,
      reviewerIds: ['user-lin'],
      reasons: ['missing_downloadable_file_backing']
    });

    expect(drafts.map((draft) => draft.type)).toEqual([
      'agent.tool.requested',
      'agent.permission.requested'
    ]);
    expect(drafts[1].payload).toMatchObject({
      invocationId: 'tool-invocation-ask',
      permissionOutcome: 'ask',
      requiredPermissions: ['file:share'],
      requiresHuman: true,
      reviewerIds: ['user-lin']
    });
  });

  it('maps denied decisions to permission denied and failed tool events', () => {
    const drafts = toolInvocationToEventDrafts(context, {
      ...baseInvocation,
      id: 'tool-invocation-denied',
      status: 'denied',
      permissionOutcome: 'deny',
      risk: {
        level: 'high',
        score: 0.9,
        reason: 'blocked',
        model: 'test-policy'
      },
      reasons: ['target_room_not_authorized']
    });

    expect(drafts.map((draft) => draft.type)).toEqual([
      'agent.tool.requested',
      'agent.permission.denied',
      'agent.tool.failed'
    ]);
    expect(drafts[2].riskLevel).toBe('high');
    expect(drafts[2].payload).toMatchObject({
      invocationId: 'tool-invocation-denied',
      status: 'denied',
      reasons: ['target_room_not_authorized']
    });
  });

  it('maps validation failures without permission events', () => {
    const drafts = toolInvocationToEventDrafts(context, {
      ...baseInvocation,
      id: 'tool-invocation-validation',
      status: 'validation_failed',
      permissionOutcome: undefined,
      requiredPermissions: [],
      reasons: [],
      error: 'messageBody must be a non-empty string'
    });

    expect(drafts.map((draft) => draft.type)).toEqual([
      'agent.tool.requested',
      'agent.tool.failed'
    ]);
    expect(drafts[1].payload).toMatchObject({
      invocationId: 'tool-invocation-validation',
      status: 'validation_failed',
      error: 'messageBody must be a non-empty string'
    });
  });

  it('defensively clones invocation payloads', () => {
    const invocation: AgentToolInvocationSnapshot = {
      ...baseInvocation,
      inputSummary: { nested: { values: ['initial'] } }
    };

    const drafts = toolInvocationToEventDrafts(context, invocation);

    (invocation.inputSummary.nested as { values: string[] }).values.push('mutated');

    expect(drafts[0].payload).toMatchObject({
      invocation: {
        inputSummary: { nested: { values: ['initial'] } }
      }
    });
  });
});
```

- [ ] **Step 2: Add failing progress mapping test**

In `src/server/agentCore/agentEvents.test.ts`, add:

```ts
  it('preserves tool invocation snapshots on progress event payloads', () => {
    const invocation = {
      id: 'tool-invocation-progress',
      toolName: 'message.send' as const,
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'completed' as const,
      permissionOutcome: 'allow' as const,
      requiredPermissions: ['message:send'],
      requiresHuman: false,
      reviewerIds: [],
      reasons: ['allowed'],
      evidenceIds: ['room-team'],
      inputSummary: { targetRoomId: 'room-team' },
      outputSummary: { messageId: 'msg-1' },
      createdAt: '2026-05-09T00:00:00.000Z'
    };

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
        label: 'Audit tool',
        toolCalls: ['message.send'],
        toolInvocations: [invocation]
      }
    );

    invocation.requiredPermissions.push('mutated:permission');

    expect(draft.payload.toolInvocations).toEqual([
      expect.objectContaining({
        id: 'tool-invocation-progress',
        toolName: 'message.send',
        requiredPermissions: ['message:send']
      })
    ]);
  });
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
npm run test -- src/server/agentCore/agentEvents.test.ts src/server/agentCore/toolEventAdapter.test.ts
```

Expected: FAIL because the adapter file and event types do not exist.

- [ ] **Step 4: Extend `AgentEventType` and progress draft typing**

In `src/server/agentCore/agentEvents.ts`, update imports:

```ts
import type { AgentToolInvocationSnapshot, RiskLevel } from '../../domain/types';
```

Replace `AgentEventType` with the contract from the "Event Contract" section.

Update `LegacyAgentProgressEvent`:

```ts
export interface LegacyAgentProgressEvent {
  runId: string;
  agentId?: string;
  roomId?: string;
  phase: string;
  label: string;
  detail?: string;
  toolCalls?: string[];
  toolInvocations?: AgentToolInvocationSnapshot[];
  riskLevel?: RiskLevel;
}
```

Update `agentProgressToEventDraft`:

```ts
  const toolCalls = progress.toolCalls ? [...progress.toolCalls] : [];
  const toolInvocations = (progress.toolInvocations ?? []).map(cloneToolInvocationSnapshot);

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
    visibility: 'user',
    toolCalls,
    riskLevel: progress.riskLevel,
    payload: {
      phase: progress.phase,
      label: progress.label,
      detail: progress.detail,
      toolCalls,
      ...(toolInvocations.length ? { toolInvocations } : {}),
      riskLevel: progress.riskLevel
    }
  };
```

Add these helpers at the bottom of `agentEvents.ts` before `normalizeSequence`:

```ts
function cloneToolInvocationSnapshot(snapshot: AgentToolInvocationSnapshot): AgentToolInvocationSnapshot {
  return {
    ...snapshot,
    requiredPermissions: [...snapshot.requiredPermissions],
    risk: snapshot.risk ? { ...snapshot.risk } : undefined,
    reviewerIds: [...snapshot.reviewerIds],
    reasons: [...snapshot.reasons],
    evidenceIds: [...snapshot.evidenceIds],
    inputSummary: cloneRecord(snapshot.inputSummary),
    outputSummary: cloneRecord(snapshot.outputSummary)
  };
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(record) as Record<string, unknown>;
    } catch {
      return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    }
  }

  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}
```

- [ ] **Step 5: Implement `toolEventAdapter.ts`**

Create `src/server/agentCore/toolEventAdapter.ts`:

```ts
import type { AgentToolInvocationSnapshot } from '../../domain/types';
import type { AgentEventDraft, AgentEventPayload, AgentEventType } from './agentEvents';

export interface ToolInvocationEventContext {
  tenantId: string;
  sessionId: string;
  runId: string;
}

export function toolInvocationToEventDrafts(
  context: ToolInvocationEventContext,
  invocation: AgentToolInvocationSnapshot
): AgentEventDraft[] {
  const snapshot = cloneInvocation(invocation);
  const drafts: AgentEventDraft[] = [createToolEventDraft(context, snapshot, 'agent.tool.requested')];
  const permissionType = permissionEventType(snapshot.permissionOutcome);
  if (permissionType) {
    drafts.push(createToolEventDraft(context, snapshot, permissionType));
  }

  const terminalType = terminalToolEventType(snapshot.status);
  if (terminalType) {
    drafts.push(createToolEventDraft(context, snapshot, terminalType));
  }

  return drafts;
}

function createToolEventDraft(
  context: ToolInvocationEventContext,
  invocation: AgentToolInvocationSnapshot,
  type: AgentEventType
): AgentEventDraft {
  return {
    type,
    tenantId: context.tenantId,
    sessionId: context.sessionId,
    runId: context.runId,
    agentId: invocation.agentId,
    roomId: invocation.roomId,
    visibility: 'audit',
    label: labelFor(type, invocation),
    detail: detailFor(type, invocation),
    toolCalls: [invocation.toolName],
    riskLevel: invocation.risk?.level,
    payload: payloadFor(type, invocation)
  };
}

function permissionEventType(outcome: AgentToolInvocationSnapshot['permissionOutcome']): AgentEventType | undefined {
  if (outcome === 'allow') return 'agent.permission.allowed';
  if (outcome === 'deny') return 'agent.permission.denied';
  if (outcome === 'ask') return 'agent.permission.requested';
  return undefined;
}

function terminalToolEventType(status: AgentToolInvocationSnapshot['status']): AgentEventType | undefined {
  if (status === 'completed') return 'agent.tool.completed';
  if (status === 'awaiting_permission') return undefined;
  return 'agent.tool.failed';
}

function payloadFor(type: AgentEventType, invocation: AgentToolInvocationSnapshot): AgentEventPayload {
  return {
    invocation: cloneInvocation(invocation),
    invocationId: invocation.id,
    toolName: invocation.toolName,
    status: invocation.status,
    permissionOutcome: invocation.permissionOutcome,
    requiredPermissions: [...invocation.requiredPermissions],
    requiresHuman: invocation.requiresHuman,
    reviewerIds: [...invocation.reviewerIds],
    reasons: [...invocation.reasons],
    evidenceIds: [...invocation.evidenceIds],
    inputSummary: cloneRecord(invocation.inputSummary),
    outputSummary: cloneRecord(invocation.outputSummary),
    risk: invocation.risk ? { ...invocation.risk } : undefined,
    error: invocation.error,
    eventKind: type
  };
}

function labelFor(type: AgentEventType, invocation: AgentToolInvocationSnapshot): string {
  if (type === 'agent.tool.requested') return `Tool requested: ${invocation.toolName}`;
  if (type === 'agent.permission.allowed') return `Permission allowed: ${invocation.toolName}`;
  if (type === 'agent.permission.denied') return `Permission denied: ${invocation.toolName}`;
  if (type === 'agent.permission.requested') return `Permission requested: ${invocation.toolName}`;
  if (type === 'agent.tool.completed') return `Tool completed: ${invocation.toolName}`;
  if (type === 'agent.tool.failed') return `Tool failed: ${invocation.toolName}`;
  return invocation.toolName;
}

function detailFor(type: AgentEventType, invocation: AgentToolInvocationSnapshot): string {
  if (type === 'agent.tool.failed') {
    return invocation.error ?? invocation.reasons[0] ?? invocation.status;
  }
  if (type.startsWith('agent.permission.')) {
    return invocation.reasons[0] ?? invocation.permissionOutcome ?? invocation.id;
  }
  return invocation.id;
}

function cloneInvocation(invocation: AgentToolInvocationSnapshot): AgentToolInvocationSnapshot {
  return {
    ...invocation,
    requiredPermissions: [...invocation.requiredPermissions],
    risk: invocation.risk ? { ...invocation.risk } : undefined,
    reviewerIds: [...invocation.reviewerIds],
    reasons: [...invocation.reasons],
    evidenceIds: [...invocation.evidenceIds],
    inputSummary: cloneRecord(invocation.inputSummary),
    outputSummary: cloneRecord(invocation.outputSummary)
  };
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(record) as Record<string, unknown>;
    } catch {
      return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    }
  }

  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}
```

- [ ] **Step 6: Run focused adapter tests**

Run:

```bash
npm run test -- src/server/agentCore/agentEvents.test.ts src/server/agentCore/toolEventAdapter.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/agentCore/agentEvents.ts src/server/agentCore/agentEvents.test.ts src/server/agentCore/toolEventAdapter.ts src/server/agentCore/toolEventAdapter.test.ts
git commit -m "feat: map tool invocations to agent events"
```

---

### Task 3: Persist Tool Events Through ProductHarness

**Files:**
- Modify: `src/server/agentCore/productHarness.ts`
- Modify: `src/server/agentCore/productHarness.test.ts`

- [ ] **Step 1: Write failing ProductHarness test**

Add this test to `src/server/agentCore/productHarness.test.ts`:

```ts
  it('records tool and permission events from runtime progress snapshots', async () => {
    const store = new MemoryAgentEventStore();
    await store.init();

    const runtime = await runProductAgentSession({
      state: createDemoState(),
      input: {
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'send_message',
        targetRoomId: 'room-team',
        targetUserId: 'user-chen',
        messageBody: 'Please review the latest notes.',
        userText: 'Send Chen a review request.'
      },
      eventStore: store,
      runId: 'agent-run-tool-events',
      sessionId: 'agent-session-tool-events',
      aiProvider: undefined,
      tools: {}
    });

    expect(runtime.response.intent).toBe('send_message');

    const page = await store.list({ runId: 'agent-run-tool-events' });
    const toolEvents = page.events.filter((event) => event.type.startsWith('agent.tool.'));
    const permissionEvents = page.events.filter((event) => event.type.startsWith('agent.permission.'));

    expect(toolEvents.map((event) => event.type)).toEqual([
      'agent.tool.requested',
      'agent.tool.completed'
    ]);
    expect(permissionEvents.map((event) => event.type)).toEqual(['agent.permission.allowed']);
    expect(page.events.map((event) => event.type)).toContain('agent.run.completed');
    expect(toolEvents[0].payload).toMatchObject({
      toolName: 'message.send',
      status: 'completed',
      permissionOutcome: 'allow'
    });
  });
```

Expected event ordering around the tool call:

```ts
[
  'agent.progress',
  'agent.tool.requested',
  'agent.permission.allowed',
  'agent.tool.completed'
]
```

The test only asserts filtered tool/permission order so unrelated progress improvements do not make it brittle.

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm run test -- src/server/agentCore/productHarness.test.ts
```

Expected: FAIL because runtime progress does not yet carry `toolInvocations`, and `ProductHarness` does not convert them.

- [ ] **Step 3: Import the adapter in `productHarness.ts`**

Add:

```ts
import { toolInvocationToEventDrafts } from './toolEventAdapter';
```

- [ ] **Step 4: Convert progress snapshots into event drafts**

Inside `runProductAgentSession`, after `const progressDrafts: AgentEventDraft[] = [];`, add:

```ts
  const seenToolInvocationIds = new Set<string>();
```

Replace the existing `onProgress` block with:

```ts
        onProgress: (event) => {
          progressDrafts.push(
            agentProgressToEventDraft(
              {
                tenantId,
                sessionId,
                runId
              },
              event
            )
          );

          for (const invocation of event.toolInvocations ?? []) {
            if (seenToolInvocationIds.has(invocation.id)) {
              continue;
            }
            seenToolInvocationIds.add(invocation.id);
            progressDrafts.push(
              ...toolInvocationToEventDrafts(
                {
                  tenantId,
                  sessionId,
                  runId
                },
                invocation
              )
            );
          }

          try {
            input.onProgress?.(event);
          } catch {
            // Progress observers must not alter the agent runtime result.
          }
        }
```

- [ ] **Step 5: Run focused ProductHarness tests**

Run:

```bash
npm run test -- src/server/agentCore/productHarness.test.ts
```

Expected: The new test still fails until Task 4 wires runtime snapshots.

- [ ] **Step 6: Commit after Task 4 passes**

Do not commit this task alone while the test is still failing. Commit Task 3 and Task 4 together when Task 4 supplies the runtime snapshots:

```bash
git add src/server/agentCore/productHarness.ts src/server/agentCore/productHarness.test.ts
git commit -m "feat: persist tool audit events from harness progress"
```

---

### Task 4: Thread Invocation Snapshots Through Runtime Paths

**Files:**
- Modify: `src/server/agentRuntime.ts`
- Modify: `src/server/agentRuntime.test.ts`
- Modify: `src/server/agentRunRuntime.ts`
- Modify: `src/server/agentCore/productHarness.test.ts`

- [ ] **Step 1: Write failing file-share runtime test**

Add assertions to the first test in `src/server/agentRuntime.test.ts` after the existing tool call assertions:

```ts
    expect(result.toolInvocation).toMatchObject({
      toolName: 'file.share',
      status: 'completed',
      permissionOutcome: 'allow',
      requiredPermissions: ['file:share'],
      requiresHuman: false
    });
```

Add assertions to the high-risk confirmation test:

```ts
    expect(result.toolInvocation).toMatchObject({
      toolName: 'file.share',
      status: 'awaiting_permission',
      permissionOutcome: 'ask',
      requiresHuman: true
    });
```

- [ ] **Step 2: Run runtime tests and verify they fail**

Run:

```bash
npm run test -- src/server/agentRuntime.test.ts src/server/agentCore/productHarness.test.ts
```

Expected: FAIL because `runFileShareAction` does not return `toolInvocation`, and `send_message` progress does not yet include invocation snapshots.

- [ ] **Step 3: Return snapshots from file-share runtime**

In `src/server/agentRuntime.ts`, update imports:

```ts
import type { AgentActionRequest, AgentToolInvocationSnapshot, DemoState, FileShareAction } from '../domain/types';
import { executeCoreTool } from './agentCore/toolExecutor';
import { toolInvocationRecordToSnapshot } from './agentCore/toolInvocationAudit';
```

Add this interface near `RuntimeFileShareInput`:

```ts
interface EnforcedFileSharePolicy {
  result: FileShareAction;
  toolInvocation?: AgentToolInvocationSnapshot;
}
```

Update `runFileShareAction` return type:

```ts
): Promise<{
  state: DemoState;
  result: FileShareAction;
  actionRequest: AgentActionRequest;
  toolInvocation?: AgentToolInvocationSnapshot;
}> {
```

Change:

```ts
  const enforcedResult = enforceFileSharePolicy(queued.state, input, result);
```

to:

```ts
  const enforced = enforceFileSharePolicy(queued.state, input, result);
  const enforcedResult = enforced.result;
```

In each return object, include:

```ts
      toolInvocation: enforced.toolInvocation
```

Update `enforceFileSharePolicy` signature:

```ts
function enforceFileSharePolicy(
  state: DemoState,
  input: RuntimeFileShareInput,
  result: FileShareAction
): EnforcedFileSharePolicy {
```

Change the missing-agent branch:

```ts
  if (!agent) {
    return { result };
  }
```

At the end, return:

```ts
  return {
    result: {
      ...result,
      status,
      requiresHuman: status === 'needs_confirmation',
      risk: toolResult.risk ?? {
        level: 'high',
        score: 0.9,
        reason: toolResult.error ?? 'File share tool execution failed.',
        model: 'tool-executor-v1'
      },
      file: toolResult.data?.file ?? result.file,
      message: status === 'executed' ? toolResult.data?.message : undefined,
      log: {
        ...result.log,
        status,
        risk: toolResult.risk ?? result.risk,
        toolCalls
      }
    },
    toolInvocation: toolResult.invocation ? toolInvocationRecordToSnapshot(toolResult.invocation) : undefined
  };
```

- [ ] **Step 4: Emit send-message invocation progress**

In `src/server/agentRunRuntime.ts`, update imports:

```ts
import { executeCoreTool } from './agentCore/toolExecutor';
import { toolInvocationRecordToSnapshot } from './agentCore/toolInvocationAudit';
```

Inside `handleAgentSendMessage`, after `const result: SendMessageAction = { ... };`, add:

```ts
  const toolInvocation = toolResult.invocation
    ? toolInvocationRecordToSnapshot(toolResult.invocation)
    : undefined;

  emitAgentRunProgress(progress, input, {
    phase: 'executing',
    label: 'Audit message.send',
    detail: toolResult.status,
    toolCalls: toolResult.toolCalls,
    toolInvocations: toolInvocation ? [toolInvocation] : [],
    riskLevel: risk.level
  });
```

This must happen before the `if (status === 'needs_confirmation')` branch so both executed and queued runs emit the audit snapshot.

- [ ] **Step 5: Emit file-share invocation progress**

In the `share_file` branch of `src/server/agentRunRuntime.ts`, update the final progress event:

```ts
    emitAgentRunProgress(progress, input, {
      phase: 'executing',
      label: result.requiresHuman ? '写入确认队列' : '写入运行日志',
      detail: result.status,
      toolCalls: resultLog.toolCalls,
      toolInvocations: runtime.toolInvocation ? [runtime.toolInvocation] : [],
      riskLevel: result.risk.level
    });
```

Keep the existing localized label if the file currently uses encoded Chinese text; the important functional addition is `toolInvocations`.

- [ ] **Step 6: Run focused runtime and harness tests**

Run:

```bash
npm run test -- src/server/agentRuntime.test.ts src/server/agentCore/productHarness.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/agentRuntime.ts src/server/agentRuntime.test.ts src/server/agentRunRuntime.ts src/server/agentCore/productHarness.ts src/server/agentCore/productHarness.test.ts
git commit -m "feat: emit tool invocation snapshots from runtime"
```

---

### Task 5: Verify API Replay And Trace Include Tool Audit Events

**Files:**
- Modify: `src/server/appServer.test.ts`
- No expected production change: `src/server/appServer.ts`
- No expected production change: `src/server/agentCore/agentTrace.ts`

- [ ] **Step 1: Add API replay test for send-message tool events**

In `src/server/appServer.test.ts`, add this test near `records replayable product events for /api/agent/run`:

```ts
  it('replays tool and permission audit events for agent runs', async () => {
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
        intent: 'send_message',
        targetRoomId: 'room-team',
        targetUserId: 'user-chen',
        messageBody: 'Please review the latest notes.',
        userText: 'Send Chen a review request.'
      })
    });

    const replay = await requestJson(`${app.url}/api/agent-runs/${result.runId}/events`);
    const types = replay.events.map((event: { type: string }) => event.type);

    expect(types).toEqual(expect.arrayContaining([
      'agent.tool.requested',
      'agent.permission.allowed',
      'agent.tool.completed'
    ]));
    expect(replay.events.find((event: { type: string }) => event.type === 'agent.tool.completed')).toMatchObject({
      visibility: 'audit',
      toolCalls: ['message.send'],
      payload: {
        toolName: 'message.send',
        status: 'completed',
        permissionOutcome: 'allow'
      }
    });
  });
```

- [ ] **Step 2: Add trace aggregation test**

Add:

```ts
  it('includes tool audit events in trace replay payloads', async () => {
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
        intent: 'send_message',
        targetRoomId: 'room-team',
        targetUserId: 'user-chen',
        messageBody: 'Please review the latest notes.',
        userText: 'Send Chen a review request.'
      })
    });

    const trace = await requestJson(`${app.url}/api/traces/${result.runId}`);

    expect(trace.status).toBe('completed');
    expect(trace.toolCalls).toContain('message.send');
    expect(trace.events.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining([
      'agent.tool.requested',
      'agent.permission.allowed',
      'agent.tool.completed'
    ]));
  });
```

- [ ] **Step 3: Run API tests**

Run:

```bash
npm run test -- src/server/appServer.test.ts
```

Expected: PASS. `appServer.ts` and `agentTrace.ts` should not need changes because they already replay every stored `AgentEvent` and aggregate `toolCalls` from all event types.

- [ ] **Step 4: Commit**

```bash
git add src/server/appServer.test.ts
git commit -m "test: verify tool audit trace replay"
```

---

### Task 6: Full Verification And Product Status Update

**Files:**
- Modify: `docs/superpowers/status/2026-05-07-agent-system-product-readiness.md`

- [ ] **Step 1: Update product readiness status**

Add a new status entry under the current tool platform section:

```md
### Tool Audit EventLog Bridge

- Tool invocation audit records are now converted into domain-safe snapshots and carried through Agent progress.
- ProductHarness persists tool and permission decisions as canonical AgentEvent entries.
- `/api/agent-runs/:runId/events` and `/api/traces/:runId` now replay `agent.tool.*` and `agent.permission.*` events alongside run/progress events.

Remaining gap: audit events still use the local EventLog adapter. Postgres-backed multi-tenant audit storage remains a future persistence slice.
```

- [ ] **Step 2: Run focused Agent Core tests**

Run:

```bash
npm run test -- src/server/agentCore src/server/agentRuntime.test.ts src/server/appServer.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm run test
npm run build
```

Expected: PASS for both commands.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git diff --stat
git status --short
```

Expected changed areas:

```text
src/domain/types.ts
src/server/agentCore/agentEvents.ts
src/server/agentCore/agentEvents.test.ts
src/server/agentCore/toolEventAdapter.ts
src/server/agentCore/toolEventAdapter.test.ts
src/server/agentCore/toolInvocationAudit.ts
src/server/agentCore/toolInvocationAudit.test.ts
src/server/agentCore/productHarness.ts
src/server/agentCore/productHarness.test.ts
src/server/agentRuntime.ts
src/server/agentRuntime.test.ts
src/server/agentRunRuntime.ts
src/server/appServer.test.ts
docs/superpowers/status/2026-05-07-agent-system-product-readiness.md
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/status/2026-05-07-agent-system-product-readiness.md
git commit -m "docs: record tool audit eventlog bridge"
```

---

## Subagent Execution Notes

Use one worker per task, with disjoint write scopes where possible:

- Worker 1: Task 1 only.
- Worker 2: Task 2 only.
- Worker 3: Task 3 and Task 4 together because ProductHarness tests depend on runtime snapshots.
- Worker 4: Task 5 only.
- Main agent: Task 6 verification and final integration review.

Workers are not alone in the codebase. Each worker must avoid reverting edits outside its assigned files and must adapt to prior commits from other workers.

## Review Checklist

- Tool permission decisions appear as canonical events, not only as action log strings.
- `awaiting_permission` creates `agent.permission.requested` without pretending the tool completed.
- `denied` creates `agent.permission.denied` and a failed terminal tool event with status `denied`.
- Event payloads include `invocationId`, `toolName`, `status`, permission details, summaries, evidence ids, risk, and reasons.
- Progress SSE remains backward-compatible because `toolInvocations` is optional.
- `/api/agent/run` still returns successful responses even if EventLog append fails.
- Trace status remains governed by `agent.run.*` terminal events, not tool failures.
- No server-only type is imported by `src/domain/types.ts`.

## Self-Review

- Spec coverage: the plan connects Tool Platform v2 audit output to Product Kernel EventLog/Trace and keeps Postgres persistence out of scope.
- Unresolved-marker scan: no task contains open-ended implementation instructions.
- Type consistency: `AgentToolInvocationSnapshot`, `toolInvocationRecordToSnapshot`, `toolInvocationToEventDrafts`, and `toolInvocations` use the same names across tasks.
- Risk check: the plan avoids UI work and database migration before the backend replay contract is stable.
