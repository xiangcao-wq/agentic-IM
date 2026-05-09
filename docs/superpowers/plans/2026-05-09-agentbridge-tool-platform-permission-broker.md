# AgentBridge Tool Platform v2 Permission Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the current two-tool Agent Core into a product-grade Tool Platform v2 with explicit tool metadata, permission decisions, and invocation audit payloads while preserving existing runtime behavior.

**Architecture:** Keep the existing `toolRegistry`, `policyEngine`, and `toolExecutor` boundaries, but make them platform-shaped. `toolRegistry` owns tool contracts, `permissionBroker` translates policy results into product permission decisions, and `toolInvocationAudit` records what happened for each invocation without introducing database schema changes in this slice.

**Tech Stack:** TypeScript, Vitest, existing `DemoState`, existing `AgentEvent`/Product Harness layer, no new package dependency, no UI work, no Postgres migration in this slice.

---

## Scope Check

This is the second v0.2 Product Kernel slice after EventLog/Harness/Trace. It covers only the backend Tool Platform and Permission Broker foundation.

Included:

- Tool metadata v2 for `message.send` and `file.share`.
- Permission decision model: allow / deny / ask.
- Tool invocation audit payloads returned from executor results.
- Executor integration without changing old success/deny/confirmation behavior.
- Runtime compatibility verification for explicit Agent runs and file share flows.

Excluded:

- Frontend Permission Center UI.
- Persistent `tool_invocations` or `permission_requests` database tables.
- Postgres adapter.
- New external connectors.
- Full policy editor.
- Rewriting `runAgentIntent`.

## File Structure

- Modify: `src/server/agentCore/toolRegistry.ts`
  - Add v2 metadata while keeping `getCoreTool()` compatibility.
- Modify: `src/server/agentCore/toolRegistry.test.ts`
  - Verify metadata, visibility, permission, audit, listing, and name guard.
- Create: `src/server/agentCore/permissionBroker.ts`
  - Translate policy decisions into product permission decisions.
- Create: `src/server/agentCore/permissionBroker.test.ts`
  - Verify allow / deny / ask mapping and reviewer propagation.
- Create: `src/server/agentCore/toolInvocationAudit.ts`
  - Build deterministic invocation audit records for executor outputs.
- Create: `src/server/agentCore/toolInvocationAudit.test.ts`
  - Verify started/completed/denied/ask/failed records.
- Modify: `src/server/agentCore/toolExecutor.ts`
  - Use Permission Broker and return invocation/permission payloads.
- Modify: `src/server/agentCore/toolExecutor.test.ts`
  - Verify behavior remains compatible and audit payloads exist.
- Modify: `src/server/appServer.test.ts`
  - Verify explicit `/api/agent/run` delegated message still works and carries legacy response fields.
- Modify: `src/server/agentRuntime.test.ts`
  - Verify file share confirmation/execution still works through the enhanced executor.
- Modify: `docs/superpowers/status/2026-05-07-agent-system-product-readiness.md`
  - Record the Tool Platform v2 slice after implementation and verification.

---

### Task 1: Tool Registry v2 Metadata

**Files:**
- Modify: `src/server/agentCore/toolRegistry.ts`
- Modify: `src/server/agentCore/toolRegistry.test.ts`

- [ ] **Step 1: Write failing metadata tests**

Update `src/server/agentCore/toolRegistry.test.ts` with tests for v2 metadata:

```ts
import { describe, expect, it } from 'vitest';
import { getCoreTool, isCoreToolName, listCoreTools } from './toolRegistry';

describe('agent core tool registry', () => {
  it('registers message.send as a policy-gated write tool', () => {
    const tool = getCoreTool('message.send');

    expect(tool).toMatchObject({
      name: 'message.send',
      version: 1,
      displayName: 'Send message',
      category: 'communication',
      sideEffect: 'write',
      visibility: 'model',
      audit: { level: 'full' },
      permission: {
        mode: 'policy',
        requiredPermissions: ['message:send'],
        requiresApprovalOn: ['ask']
      },
      riskPolicy: { requiresPolicy: true }
    });
    expect(tool.requiredPermissions).toContain('message:send');
  });

  it('registers file.share as a policy-gated file tool', () => {
    const tool = getCoreTool('file.share');

    expect(tool).toMatchObject({
      name: 'file.share',
      version: 1,
      displayName: 'Share file',
      category: 'file',
      sideEffect: 'external',
      visibility: 'model',
      audit: { level: 'full' },
      permission: {
        mode: 'policy',
        requiredPermissions: ['file:share'],
        requiresApprovalOn: ['ask']
      },
      riskPolicy: { requiresPolicy: true }
    });
    expect(tool.requiredPermissions).toContain('file:share');
  });

  it('lists stable core tools without exposing mutable registry state', () => {
    const tools = listCoreTools();

    expect(tools.map((tool) => tool.name)).toEqual(['message.send', 'file.share']);
    tools.pop();
    expect(listCoreTools().map((tool) => tool.name)).toEqual(['message.send', 'file.share']);
  });

  it('identifies supported core tool names', () => {
    expect(isCoreToolName('message.send')).toBe(true);
    expect(isCoreToolName('file.share')).toBe(true);
    expect(isCoreToolName('web.search')).toBe(false);
    expect(isCoreToolName(undefined)).toBe(false);
  });

  it('validates message.send input before execution', () => {
    const tool = getCoreTool('message.send');

    expect(
      tool.validateInput({
        targetRoomId: 'room-team',
        targetUserId: 'user-chen',
        messageBody: 'Please review the latest notes.'
      })
    ).toEqual({
      ok: true,
      value: {
        targetRoomId: 'room-team',
        targetUserId: 'user-chen',
        messageBody: 'Please review the latest notes.'
      }
    });

    expect(tool.validateInput({ targetRoomId: 'room-team', messageBody: '   ' })).toEqual({
      ok: false,
      error: 'messageBody must be a non-empty string'
    });
  });
});
```

- [ ] **Step 2: Run the focused registry test and confirm failure**

Run:

```bash
npm run test -- src/server/agentCore/toolRegistry.test.ts
```

Expected: FAIL because `version`, `displayName`, `category`, `visibility`, `audit`, `permission`, `listCoreTools`, and `isCoreToolName` are missing.

- [ ] **Step 3: Extend `toolRegistry.ts` metadata without breaking callers**

Modify `src/server/agentCore/toolRegistry.ts`:

```ts
export type ToolSideEffect = 'read' | 'write' | 'external' | 'destructive';
export type ToolVisibility = 'model' | 'internal';
export type ToolCategory = 'communication' | 'file';
export type ToolAuditLevel = 'none' | 'summary' | 'full';

export interface ToolAuditPolicy {
  level: ToolAuditLevel;
}

export interface ToolPermissionPolicy {
  mode: 'none' | 'policy';
  requiredPermissions: string[];
  requiresApprovalOn: Array<'ask'>;
}
```

Update `AgentCoreToolDefinition<Input>` to include:

```ts
  version: number;
  displayName: string;
  category: ToolCategory;
  visibility: ToolVisibility;
  audit: ToolAuditPolicy;
  permission: ToolPermissionPolicy;
```

Keep the existing `requiredPermissions` and `riskPolicy` fields for compatibility. The definitions should include:

```ts
'message.send': {
  name: 'message.send',
  version: 1,
  displayName: 'Send message',
  category: 'communication',
  description: 'Send an Agent-authored delegated message to an authorized room or direct chat.',
  sideEffect: 'write',
  visibility: 'model',
  requiredPermissions: ['message:send'],
  permission: {
    mode: 'policy',
    requiredPermissions: ['message:send'],
    requiresApprovalOn: ['ask']
  },
  audit: { level: 'full' },
  riskPolicy: { requiresPolicy: true },
  validateInput: validateMessageSendInput
}
```

For `file.share`, use:

```ts
sideEffect: 'external',
displayName: 'Share file',
category: 'file',
permission.requiredPermissions: ['file:share']
```

Add:

```ts
export function listCoreTools(): AgentCoreToolDefinition<MessageSendInput | FileShareInput>[] {
  return Object.values(coreTools);
}

export function isCoreToolName(value: unknown): value is AgentCoreToolName {
  return typeof value === 'string' && value in coreTools;
}
```

- [ ] **Step 4: Run registry tests**

Run:

```bash
npm run test -- src/server/agentCore/toolRegistry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/server/agentCore/toolRegistry.ts src/server/agentCore/toolRegistry.test.ts
git commit -m "feat: add tool registry v2 metadata"
```

---

### Task 2: Permission Broker

**Files:**
- Create: `src/server/agentCore/permissionBroker.ts`
- Create: `src/server/agentCore/permissionBroker.test.ts`

- [ ] **Step 1: Write failing broker tests**

Create `src/server/agentCore/permissionBroker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RiskAssessment } from '../../domain/types';
import type { PolicyDecision } from './policyEngine';
import { getCoreTool } from './toolRegistry';
import { createToolPermissionDecision } from './permissionBroker';

const lowRisk: RiskAssessment = {
  level: 'low',
  score: 0.1,
  reason: 'allowed',
  model: 'test-policy'
};

function policy(overrides: Partial<PolicyDecision>): PolicyDecision {
  return {
    outcome: 'allow',
    risk: lowRisk,
    reasons: ['allowed'],
    ...overrides
  };
}

describe('permission broker', () => {
  it('maps allow policies to allow permission decisions', () => {
    const decision = createToolPermissionDecision({
      tool: getCoreTool('message.send'),
      policy: policy({ outcome: 'allow' }),
      agentId: 'agent-lin',
      roomId: 'room-team'
    });

    expect(decision).toMatchObject({
      outcome: 'allow',
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      requiredPermissions: ['message:send'],
      reasons: ['allowed'],
      risk: lowRisk
    });
    expect(decision.requiresHuman).toBe(false);
  });

  it('maps deny policies to deny permission decisions', () => {
    const decision = createToolPermissionDecision({
      tool: getCoreTool('message.send'),
      policy: policy({ outcome: 'deny', reasons: ['target_room_not_authorized'] }),
      agentId: 'agent-lin',
      roomId: 'room-team'
    });

    expect(decision.outcome).toBe('deny');
    expect(decision.requiresHuman).toBe(false);
    expect(decision.reasons).toEqual(['target_room_not_authorized']);
  });

  it('maps require_confirmation policies to ask permission decisions', () => {
    const decision = createToolPermissionDecision({
      tool: getCoreTool('file.share'),
      policy: policy({
        outcome: 'require_confirmation',
        reasons: ['cross_room_file_share'],
        requiredReviewerIds: ['user-lin']
      }),
      agentId: 'agent-lin',
      roomId: 'room-team'
    });

    expect(decision).toMatchObject({
      outcome: 'ask',
      requiresHuman: true,
      reviewerIds: ['user-lin'],
      requiredPermissions: ['file:share']
    });
  });
});
```

- [ ] **Step 2: Run broker test and confirm failure**

Run:

```bash
npm run test -- src/server/agentCore/permissionBroker.test.ts
```

Expected: FAIL because `permissionBroker.ts` does not exist.

- [ ] **Step 3: Add `permissionBroker.ts`**

Create `src/server/agentCore/permissionBroker.ts`:

```ts
import type { RiskAssessment } from '../../domain/types';
import type { PolicyDecision } from './policyEngine';
import type { AgentCoreToolDefinition, AgentCoreToolName } from './toolRegistry';

export type ToolPermissionOutcome = 'allow' | 'deny' | 'ask';

export interface ToolPermissionDecision {
  outcome: ToolPermissionOutcome;
  toolName: AgentCoreToolName;
  agentId: string;
  roomId: string;
  requiredPermissions: string[];
  reasons: string[];
  risk: RiskAssessment;
  requiresHuman: boolean;
  reviewerIds: string[];
}

export interface CreateToolPermissionDecisionInput {
  tool: AgentCoreToolDefinition<unknown>;
  policy: PolicyDecision;
  agentId: string;
  roomId: string;
}

export function createToolPermissionDecision(input: CreateToolPermissionDecisionInput): ToolPermissionDecision {
  const outcome = mapPolicyOutcome(input.policy.outcome);
  return {
    outcome,
    toolName: input.tool.name,
    agentId: input.agentId,
    roomId: input.roomId,
    requiredPermissions: [...input.tool.permission.requiredPermissions],
    reasons: [...input.policy.reasons],
    risk: input.policy.risk,
    requiresHuman: outcome === 'ask',
    reviewerIds: [...(input.policy.requiredReviewerIds ?? [])]
  };
}

function mapPolicyOutcome(outcome: PolicyDecision['outcome']): ToolPermissionOutcome {
  if (outcome === 'require_confirmation') {
    return 'ask';
  }
  return outcome;
}
```

- [ ] **Step 4: Run broker tests**

Run:

```bash
npm run test -- src/server/agentCore/permissionBroker.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/server/agentCore/permissionBroker.ts src/server/agentCore/permissionBroker.test.ts
git commit -m "feat: add permission broker decisions"
```

---

### Task 3: Tool Invocation Audit Payloads

**Files:**
- Create: `src/server/agentCore/toolInvocationAudit.ts`
- Create: `src/server/agentCore/toolInvocationAudit.test.ts`

- [ ] **Step 1: Write failing invocation audit tests**

Create `src/server/agentCore/toolInvocationAudit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RiskAssessment } from '../../domain/types';
import type { ToolPermissionDecision } from './permissionBroker';
import { createToolInvocationRecord } from './toolInvocationAudit';

const risk: RiskAssessment = {
  level: 'low',
  score: 0.1,
  reason: 'allowed',
  model: 'test-policy'
};

const permission: ToolPermissionDecision = {
  outcome: 'allow',
  toolName: 'message.send',
  agentId: 'agent-lin',
  roomId: 'room-team',
  requiredPermissions: ['message:send'],
  reasons: ['allowed'],
  risk,
  requiresHuman: false,
  reviewerIds: []
};

describe('tool invocation audit', () => {
  it('creates a completed invocation record', () => {
    const record = createToolInvocationRecord({
      id: 'tool-invocation-1',
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'completed',
      permission,
      inputSummary: { targetRoomId: 'room-team' },
      outputSummary: { messageId: 'msg-1' },
      evidenceIds: ['room-team', 'msg-1'],
      createdAt: '2026-05-09T00:00:00.000Z'
    });

    expect(record).toMatchObject({
      id: 'tool-invocation-1',
      toolName: 'message.send',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'completed',
      permissionOutcome: 'allow',
      evidenceIds: ['room-team', 'msg-1'],
      inputSummary: { targetRoomId: 'room-team' },
      outputSummary: { messageId: 'msg-1' },
      createdAt: '2026-05-09T00:00:00.000Z'
    });
  });

  it('creates an awaiting permission record for ask decisions', () => {
    const record = createToolInvocationRecord({
      toolName: 'file.share',
      agentId: 'agent-lin',
      roomId: 'room-team',
      status: 'awaiting_permission',
      permission: {
        ...permission,
        outcome: 'ask',
        toolName: 'file.share',
        requiresHuman: true,
        reviewerIds: ['user-lin']
      },
      evidenceIds: ['file-slides-v3']
    });

    expect(record.id).toMatch(/^tool-invocation-/);
    expect(record.permissionOutcome).toBe('ask');
    expect(record.reviewerIds).toEqual(['user-lin']);
  });
});
```

- [ ] **Step 2: Run audit tests and confirm failure**

Run:

```bash
npm run test -- src/server/agentCore/toolInvocationAudit.test.ts
```

Expected: FAIL because `toolInvocationAudit.ts` does not exist.

- [ ] **Step 3: Add `toolInvocationAudit.ts`**

Create `src/server/agentCore/toolInvocationAudit.ts`:

```ts
import type { AgentCoreToolName } from './toolRegistry';
import type { ToolPermissionDecision } from './permissionBroker';

export type ToolInvocationStatus =
  | 'validation_failed'
  | 'denied'
  | 'awaiting_permission'
  | 'completed'
  | 'failed';

export interface ToolInvocationRecord {
  id: string;
  toolName: AgentCoreToolName;
  agentId: string;
  roomId: string;
  status: ToolInvocationStatus;
  permissionOutcome?: ToolPermissionDecision['outcome'];
  reviewerIds: string[];
  reasons: string[];
  evidenceIds: string[];
  inputSummary: Record<string, unknown>;
  outputSummary: Record<string, unknown>;
  error?: string;
  createdAt: string;
}

export interface CreateToolInvocationRecordInput {
  id?: string;
  toolName: AgentCoreToolName;
  agentId: string;
  roomId: string;
  status: ToolInvocationStatus;
  permission?: ToolPermissionDecision;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  evidenceIds?: string[];
  error?: string;
  createdAt?: string;
}

export function createToolInvocationRecord(input: CreateToolInvocationRecordInput): ToolInvocationRecord {
  return {
    id: input.id ?? `tool-invocation-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    toolName: input.toolName,
    agentId: input.agentId,
    roomId: input.roomId,
    status: input.status,
    permissionOutcome: input.permission?.outcome,
    reviewerIds: [...(input.permission?.reviewerIds ?? [])],
    reasons: [...(input.permission?.reasons ?? [])],
    evidenceIds: [...(input.evidenceIds ?? [])],
    inputSummary: { ...(input.inputSummary ?? {}) },
    outputSummary: { ...(input.outputSummary ?? {}) },
    error: input.error,
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}
```

- [ ] **Step 4: Run audit tests**

Run:

```bash
npm run test -- src/server/agentCore/toolInvocationAudit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/server/agentCore/toolInvocationAudit.ts src/server/agentCore/toolInvocationAudit.test.ts
git commit -m "feat: add tool invocation audit records"
```

---

### Task 4: Tool Executor Integration

**Files:**
- Modify: `src/server/agentCore/toolExecutor.ts`
- Modify: `src/server/agentCore/toolExecutor.test.ts`

- [ ] **Step 1: Write failing executor assertions**

Update `src/server/agentCore/toolExecutor.test.ts`:

```ts
expect(result.permissionDecision).toMatchObject({
  outcome: 'allow',
  toolName: 'message.send',
  requiredPermissions: ['message:send']
});
expect(result.invocation).toMatchObject({
  toolName: 'message.send',
  status: 'completed',
  permissionOutcome: 'allow'
});
```

Add to the denied `message.send` test:

```ts
expect(result.permissionDecision?.outcome).toBe('deny');
expect(result.invocation).toMatchObject({
  toolName: 'message.send',
  status: 'denied',
  permissionOutcome: 'deny'
});
```

Add to the validation failure test:

```ts
expect(result.permissionDecision).toBeUndefined();
expect(result.invocation).toMatchObject({
  toolName: 'message.send',
  status: 'validation_failed',
  error: 'messageBody must be a non-empty string'
});
```

Add to the `needs_confirmation` file.share test:

```ts
expect(result.permissionDecision?.outcome).toBe('ask');
expect(result.invocation).toMatchObject({
  toolName: 'file.share',
  status: 'awaiting_permission',
  permissionOutcome: 'ask'
});
```

- [ ] **Step 2: Run executor test and confirm failure**

Run:

```bash
npm run test -- src/server/agentCore/toolExecutor.test.ts
```

Expected: FAIL because executor results do not expose `permissionDecision` or `invocation`.

- [ ] **Step 3: Extend `CoreToolResult`**

Modify `src/server/agentCore/toolExecutor.ts` imports:

```ts
import { createToolPermissionDecision, type ToolPermissionDecision } from './permissionBroker';
import { createToolInvocationRecord, type ToolInvocationRecord, type ToolInvocationStatus } from './toolInvocationAudit';
```

Extend `CoreToolResult<T>`:

```ts
  permissionDecision?: ToolPermissionDecision;
  invocation?: ToolInvocationRecord;
```

- [ ] **Step 4: Add small helper functions in `toolExecutor.ts`**

Add:

```ts
function invocationStatusForResult(status: CoreToolResultStatus): ToolInvocationStatus {
  if (status === 'denied') return 'denied';
  if (status === 'needs_confirmation') return 'awaiting_permission';
  if (status === 'ok') return 'completed';
  if (status === 'failed' || status === 'not_found') return 'failed';
  return 'failed';
}

function validationFailedInvocation(input: {
  toolName: AgentCoreToolName;
  agentId: string;
  roomId: string;
  error: string;
}): ToolInvocationRecord {
  return createToolInvocationRecord({
    toolName: input.toolName,
    agentId: input.agentId,
    roomId: input.roomId,
    status: 'validation_failed',
    error: input.error
  });
}
```

- [ ] **Step 5: Integrate permission decisions for both tools**

In `executeMessageSendTool`:

1. On validation failure, add `invocation: validationFailedInvocation(...)`.
2. After policy assessment, call:

```ts
const permissionDecision = createToolPermissionDecision({
  tool,
  policy,
  agentId: request.agent.id,
  roomId: request.sourceRoomId
});
```

3. Include `permissionDecision` and `invocation` in deny / needs_confirmation / ok returns:

```ts
invocation: createToolInvocationRecord({
  toolName: 'message.send',
  agentId: request.agent.id,
  roomId: request.sourceRoomId,
  status: invocationStatusForResult('ok'),
  permission: permissionDecision,
  inputSummary: {
    targetRoomId: input.targetRoomId,
    targetUserId: input.targetUserId
  },
  outputSummary: {
    messageId: message.id
  },
  evidenceIds
})
```

Use equivalent summaries for denied and ask paths without a `messageId`.

Repeat for `executeFileShareTool`.

- [ ] **Step 6: Run executor tests**

Run:

```bash
npm run test -- src/server/agentCore/toolExecutor.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run all agentCore tests**

Run:

```bash
npm run test -- src/server/agentCore
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/server/agentCore/toolExecutor.ts src/server/agentCore/toolExecutor.test.ts
git commit -m "feat: attach permission and invocation audit to tools"
```

---

### Task 5: Runtime Compatibility Checks

**Files:**
- Modify: `src/server/appServer.test.ts`
- Modify: `src/server/agentRuntime.test.ts`

- [ ] **Step 1: Add explicit Agent run compatibility assertion**

In `src/server/appServer.test.ts`, update the existing test named:

```ts
it('runs an Agent delegated message to a selected direct room through /api/agent/run', async () => {
```

Add these assertions after the existing `result.message` assertion:

```ts
expect(result.log.toolCalls).toContain('message.send');
expect(result.requiresHuman).toBe(false);
expect(result.actionRequest).toBeUndefined();
expect(result.runId).toMatch(/^agent-run-/);
expect(result.sessionId).toMatch(/^agent-session-/);
```

- [ ] **Step 2: Add file share compatibility assertion**

In `src/server/agentRuntime.test.ts`, update the existing test named:

```ts
it('queues, executes, and audits a low-risk file share action', async () => {
```

Add these assertions after the existing `toolCalls` assertions:

```ts
expect(result.result.log.toolCalls).toContain('file.share');
expect(result.actionRequest.status).toBe('executed');
```

Update the existing test named:

```ts
it('keeps high-risk file share actions in the confirmation queue', async () => {
```

Add this assertion after the existing `state.actionLogs` assertion:

```ts
expect(result.result.log.toolCalls).toContain('file.share');
```

- [ ] **Step 3: Run runtime tests and confirm compatibility**

Run:

```bash
npm run test -- src/server/appServer.test.ts src/server/agentRuntime.test.ts -t "runs an Agent delegated message|queues, executes, and audits|keeps high-risk file share"
```

Expected: PASS.

- [ ] **Step 4: Run core + runtime tests**

Run:

```bash
npm run test -- src/server/agentCore src/server/appServer.test.ts src/server/agentRuntime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/server/appServer.test.ts src/server/agentRuntime.test.ts
git commit -m "test: verify tool platform runtime compatibility"
```

---

### Task 6: Full Verification and Status Document

**Files:**
- Modify: `docs/superpowers/status/2026-05-07-agent-system-product-readiness.md`

- [ ] **Step 1: Run full agent core tests**

Run:

```bash
npm run test -- src/server/agentCore
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm run test
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Append status note**

Append this section to `docs/superpowers/status/2026-05-07-agent-system-product-readiness.md`:

```md
## 2026-05-09 Tool Platform v2 Slice

Implemented the second Product Kernel slice:

- Core tools now expose product-grade metadata for visibility, audit, permission, side effect, category, and version.
- Permission Broker converts existing policy decisions into explicit allow / deny / ask decisions.
- Tool Executor returns permission decisions and invocation audit payloads for `message.send` and `file.share`.
- Runtime compatibility checks confirm existing delegated message and file share flows still behave as before.

This slice does not persist `tool_invocations` or `permission_requests` to Postgres yet. It establishes the typed backend contract that the future Permission Center UI and database-backed audit ledger can consume.
```

- [ ] **Step 5: Commit Task 6**

```bash
git add docs/superpowers/status/2026-05-07-agent-system-product-readiness.md
git commit -m "docs: record tool platform v2 slice"
```

---

### Task 7: Final Branch Check

**Files:**
- No file changes expected.

- [ ] **Step 1: Check working tree**

Run:

```bash
git status --short --branch
```

Expected: clean working tree.

- [ ] **Step 2: Review recent commits**

Run:

```bash
git log --oneline -8
```

Expected: shows this plan's commits on top of the EventLog/Harness slice.

- [ ] **Step 3: Record verification summary**

Report:

```text
Tool Platform v2 slice complete.
Tests:
- npm run test -- src/server/agentCore
- npm run test
- npm run build
Branch:
- clean
```

---

## Self-Review

Spec coverage:

- Tool metadata: Task 1.
- Permission Broker: Task 2.
- Tool invocation audit payloads: Task 3.
- Executor integration: Task 4.
- Runtime compatibility: Task 5.
- Verification and status document: Task 6.

Intentional gaps:

- No UI Permission Center in this slice.
- No persistent database schema in this slice.
- No new external tool connectors in this slice.
- No policy editor in this slice.

Type consistency:

- `ToolPermissionDecision` is produced by `permissionBroker` and consumed by `toolExecutor`.
- `ToolInvocationRecord` is produced by `toolInvocationAudit` and attached to `CoreToolResult`.
- Existing `PolicyDecision` remains owned by `policyEngine`.
- Existing `AgentActionRequest` and confirmation queue behavior remain unchanged.

Risk control:

- Existing executor status values stay compatible.
- Existing runtime tests protect user-visible behavior.
- New audit payloads are additive.
