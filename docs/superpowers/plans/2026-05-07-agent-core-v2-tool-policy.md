# Agent Core v2 Tool Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the first write action, `message.send`, behind Agent Core v2 style tool and policy boundaries.

**Architecture:** Keep `/api/agent/run` response compatibility. Add focused `src/server/agentCore` modules for pure policy decisions and tool metadata, then route the existing delegated message handler through them. Confirmation queue and action log shapes remain unchanged.

**Tech Stack:** TypeScript, Vitest, current `DemoState`, current `AgentRunResult`.

---

## File Structure

- Create `src/server/agentCore/policyEngine.ts`: pure `PolicyEngine` types plus `assessMessageSendPolicy`.
- Create `src/server/agentCore/policyEngine.test.ts`: unit tests for allow, deny, and confirmation outcomes.
- Create `src/server/agentCore/toolRegistry.ts`: v2-style tool metadata for `message.send` and `file.share`.
- Create `src/server/agentCore/toolRegistry.test.ts`: verifies schema-like input validation and registered tool metadata.
- Modify `src/server/agentRunRuntime.ts`: replace local delegated-message permission/risk calculation with `assessMessageSendPolicy`.

## Task 1: Add PolicyEngine for `message.send`

**Files:**
- Create: `src/server/agentCore/policyEngine.test.ts`
- Create: `src/server/agentCore/policyEngine.ts`

- [x] **Step 1: Write the failing test**

Add tests that call `assessMessageSendPolicy` with:

```ts
expect(decision.outcome).toBe('allow');
expect(decision.risk.level).toBe('low');
```

for a short message to an authorized room, plus:

```ts
expect(decision.outcome).toBe('deny');
expect(decision.risk.level).toBe('high');
```

for an unauthorized room, and:

```ts
expect(decision.outcome).toBe('require_confirmation');
expect(decision.risk.level).toBe('medium');
```

for sensitive delegated content.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test -- src/server/agentCore/policyEngine.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement minimal policy module**

Create `assessMessageSendPolicy(state, input)` returning:

```ts
type PolicyOutcome = 'allow' | 'deny' | 'require_confirmation';
interface PolicyDecision {
  outcome: PolicyOutcome;
  risk: RiskAssessment;
  reasons: string[];
  requiredReviewerIds?: string[];
}
```

Use current delegated-message rules: target room must exist, agent must be authorized for it, owner must be a room member, optional target user must exist, sensitive or long content requires confirmation, otherwise allow.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
npm run test -- src/server/agentCore/policyEngine.test.ts
```

Expected: PASS.

## Task 2: Add ToolRegistry Metadata

**Files:**
- Create: `src/server/agentCore/toolRegistry.test.ts`
- Create: `src/server/agentCore/toolRegistry.ts`

- [x] **Step 1: Write the failing test**

Assert `getCoreTool('message.send')` has `sideEffect: 'write'`, `requiredPermissions`, `riskPolicy.requiresPolicy: true`, and validates a minimal `{ targetRoomId, messageBody }` input.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test -- src/server/agentCore/toolRegistry.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement minimal registry**

Add a tiny registry with `message.send` and `file.share`, including `validateInput(input)` returning `{ ok: true, value }` or `{ ok: false, error }`.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
npm run test -- src/server/agentCore/toolRegistry.test.ts
```

Expected: PASS.

## Task 3: Migrate Runtime `message.send`

**Files:**
- Modify: `src/server/agentRunRuntime.ts`
- Modify: `src/server/agentPlanRuntime.test.ts`

- [x] **Step 1: Write runtime regression test**

Add an `/api/agent/run` test proving an unauthorized delegated message is blocked and its log contains `message.send` but no `matrix.send_event`.

- [x] **Step 2: Run test to verify it fails or captures legacy coupling**

Run:

```bash
npm run test -- src/server/agentPlanRuntime.test.ts
```

Expected: current behavior may pass functionally, but `agentRunRuntime.ts` still owns policy logic. Continue with migration while preserving the test.

- [x] **Step 3: Replace local policy logic**

Import `assessMessageSendPolicy` and map outcomes:

```ts
const policy = assessMessageSendPolicy(state, { agent, targetRoomId, targetUserId, messageBody });
const status = policy.outcome === 'allow'
  ? 'executed'
  : policy.outcome === 'deny'
    ? 'blocked'
    : 'needs_confirmation';
```

Use `policy.risk` and include `policy.reasons` in confirmation context through the existing risk reason.

- [x] **Step 4: Run focused and regression tests**

Run:

```bash
npm run test -- src/server/agentCore/policyEngine.test.ts src/server/agentCore/toolRegistry.test.ts src/server/agentPlanRuntime.test.ts
npm run eval:agent
npm run build
```

Expected: all pass.

## Task 4: Migrate Runtime `file.share`

**Files:**
- Modify: `src/server/agentCore/policyEngine.ts`
- Modify: `src/server/agentCore/policyEngine.test.ts`
- Modify: `src/server/agentRuntime.ts`
- Modify: `src/server/agentRuntime.test.ts`
- Modify: `src/server/runtimeUpgrade.test.ts`

- [x] **Step 1: Write file-share policy tests**

Added tests for three policy outcomes:

```ts
expect(decision.outcome).toBe('allow');
expect(decision.reasons).toContain('downloadable_file_backing');
```

for an authorized downloadable file, plus:

```ts
expect(decision.outcome).toBe('require_confirmation');
expect(decision.reasons).toContain('missing_downloadable_file_backing');
```

for metadata-only files, and:

```ts
expect(decision.outcome).toBe('deny');
expect(decision.reasons).toContain('file_outside_agent_owner_boundary');
```

for files outside the agent owner boundary.

- [x] **Step 2: Run test to verify it fails**

Ran:

```bash
npm run test -- src/server/agentCore/policyEngine.test.ts
```

Observed: FAIL because `assessFileSharePolicy` did not exist.

- [x] **Step 3: Implement file-share policy**

Implemented `assessFileSharePolicy` with checks for owner identity, source/target room authorization, requester identity, file owner boundary, `agentCanShare`, `visibility`, downloadable backing, media metadata, and cross-room sharing.

- [x] **Step 4: Migrate `runFileShareAction`**

Added `enforceFileSharePolicy` in `src/server/agentRuntime.ts` so `createFileShareAction` can still select the candidate file, while final `status`, `risk`, `message`, and `log` are determined by `PolicyEngine`.

- [x] **Step 5: Verify focused suite**

Ran:

```bash
npm run test -- src/server/agentCore/policyEngine.test.ts src/server/agentCore/toolRegistry.test.ts src/server/agentRuntime.test.ts src/server/agentPlanRuntime.test.ts src/server/runtimeUpgrade.test.ts
```

Observed: PASS, 40 tests.

## Task 5: Introduce ToolExecutor for `message.send`

**Files:**
- Create: `src/server/agentCore/toolExecutor.ts`
- Create: `src/server/agentCore/toolExecutor.test.ts`
- Modify: `src/server/agentRunRuntime.ts`
- Modify: `src/server/agentPlanRuntime.test.ts`

- [x] **Step 1: Write ToolExecutor tests**

Added tests for:

```ts
expect(result.status).toBe('ok');
expect(result.toolCalls).toContain('matrix.send_event');
```

for allowed `message.send`, plus:

```ts
expect(result.status).toBe('denied');
expect(result.toolCalls).toEqual(['tool_executor.message.send', 'message.send']);
```

for unauthorized sends, and:

```ts
expect(result.status).toBe('failed');
expect(result.error).toBe('messageBody must be a non-empty string');
```

for invalid tool input.

- [x] **Step 2: Run test to verify it fails**

Ran:

```bash
npm run test -- src/server/agentCore/toolExecutor.test.ts
```

Observed: FAIL because `toolExecutor` did not exist.

- [x] **Step 3: Implement minimal ToolExecutor**

Created `executeCoreTool` and `CoreToolResult`. The first supported tool is `message.send`, which validates input through `ToolRegistry`, gates through `PolicyEngine`, creates the delegated agent message only when allowed, and returns `ok`, `denied`, `needs_confirmation`, or `failed`.

- [x] **Step 4: Migrate runtime send_message path**

Changed `handleAgentSendMessage` to call `executeCoreTool('message.send')` and consume the returned `ToolResult` when building the existing compatible `AgentRunResult`, action log, confirmation request, and runtime message mutation.

- [x] **Step 5: Verify focused suite**

Ran:

```bash
npm run test -- src/server/agentCore/policyEngine.test.ts src/server/agentCore/toolRegistry.test.ts src/server/agentCore/toolExecutor.test.ts src/server/agentRuntime.test.ts src/server/agentPlanRuntime.test.ts src/server/runtimeUpgrade.test.ts
```

Observed: PASS, 43 tests.

## Task 6: Move `file.share` into ToolExecutor

**Files:**
- Modify: `src/server/agentCore/toolRegistry.ts`
- Modify: `src/server/agentCore/toolExecutor.ts`
- Modify: `src/server/agentCore/toolExecutor.test.ts`
- Modify: `src/server/agentCore/policyEngine.ts`
- Modify: `src/server/agentCore/policyEngine.test.ts`
- Modify: `src/server/agentRuntime.ts`
- Modify: `src/server/agentRuntime.test.ts`

- [x] **Step 1: Write file-share ToolExecutor tests**

Added tests for `file.share` returning:

```ts
expect(result.status).toBe('ok');
expect(result.toolCalls).toContain('tool_executor.file.share');
expect(result.toolCalls).toContain('matrix.send_event');
```

for an authorized downloadable file, plus `needs_confirmation` for metadata-only files and `denied` for files outside the owner boundary.

- [x] **Step 2: Run test to verify it fails**

Ran:

```bash
npm run test -- src/server/agentCore/toolExecutor.test.ts
```

Observed: FAIL because `executeCoreTool` only supported `message.send`.

- [x] **Step 3: Implement file-share ToolExecutor**

Extended `ToolRegistry` validation for `file.share` input and added `executeFileShareTool`. The executor validates input, gates with `assessFileSharePolicy`, creates the file message only when policy allows execution, and returns a unified `ToolResult`.

- [x] **Step 4: Migrate runtime file share path**

Changed `runFileShareAction` to call `executeCoreTool('file.share')` after the existing file-selection step. The runtime now uses `ToolResult` for final `status`, `risk`, `message`, and audit `toolCalls`.

- [x] **Step 5: Fix confirmation queue regression**

Full tests exposed that ambiguous requests such as “process the pptx” should remain in `needs_confirmation`, not auto-send. Added `ambiguous_file_share_intent` policy handling so unclear file-share intent requires human confirmation.

- [x] **Step 6: Verify full suite**

Ran:

```bash
npm run test
npm run eval:agent
npm run build
```

Observed: PASS, 212 tests; Agent eval 40/40; build passed.

## Self-Review

- Spec coverage: Starts Phase 1 by introducing ToolRegistry and PolicyEngine, migrates `message.send` and `file.share` through ToolExecutor, and preserves confirmation queue semantics.
- Placeholder scan: No placeholder markers remain.
- Type consistency: Reuses existing `RiskAssessment`, `DemoState`, `PersonalAgent`, and `AgentToolName` types.
