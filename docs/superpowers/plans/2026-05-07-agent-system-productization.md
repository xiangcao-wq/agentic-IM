# Agent System Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current demo-grade Agent IM system into a usable product with secure API boundaries, traceable Agent Core v2 execution, real A2A negotiation, reliable evaluation, and durable operational behavior.

**Architecture:** Preserve the current React workbench and `/api/agent/run` compatibility surface while replacing the runtime internals through vertical slices. Start with product safety and verification gates, then migrate tools into Agent Core v2, add first-class traces and evidence, protocolize A2A, and finally harden persistence and Matrix operations.

**Tech Stack:** TypeScript, Vitest, Vite/React, current Node HTTP server, current Matrix adapter, current JSON state store in early phases, optional SQLite persistence in the product-hardening phase.

---

## Problem Ledger

### P0: Product Safety

- API auth is optional. When `AGENT_IM_API_TOKEN` is unset, state-changing API requests are accepted.
- The client can pass `agent_im_token` in URLs for SSE and downloads. Tokens in query strings can leak through logs, browser history, and referrers.
- File download responses do not have a complete production hardening policy for `X-Content-Type-Options`, SVG handling, and attachment behavior.
- CORS is adequate for local use, but product mode needs an explicit origin list and a failing default.

### P0: Verification Gaps

- `npm run eval:agent` passes, but it is still the local fallback evaluation path. It does not prove the real DeepSeek planner is stable.
- Browser smoke and live Matrix smoke are not part of the required product readiness gate.
- Current demo data has `a2aSessions: 0`, so the product cannot rely on preloaded A2A examples on first open.

### P1: Agent Core v2 Incomplete

- `message.send` and `file.share` are behind `ToolRegistry`, `PolicyEngine`, and `ToolExecutor`.
- Remaining capabilities still live in legacy runtime branches: chat, summary, deadline answer, file search, web search, task update, schedule coordination, and A2A coordination.
- There is no first-class `AgentSession` object with bounded plan-act-observe execution.
- There is no first-class runtime trace object that records goal, evidence, policy decisions, tool calls, observations, and final status.

### P1: Evidence and Trust Gaps

- Some no-evidence guards exist for summary, deadline, and internal-fact chat.
- File search still needs an explicit no-evidence guard.
- LLM-selected file ids for file-share flows must be validated against authorized evidence before any policy or risk decision.
- Evidence selection is still distributed across runtime code instead of owned by a dedicated `ContextEngine`.

### P1: A2A Not Yet Protocolized

- A2A sessions and turns exist and are tested, but the system still behaves like a central orchestrator creating negotiation records.
- A2A message types are not first-class executable protocol messages.
- Target agents do not yet run independent policy-gated `AgentSession` responses for every A2A turn.
- A2A cannot yet guarantee that every cross-agent decision passed through each target agent's own permissions and evidence boundary.

### P2: Persistence and Operations

- State is persisted to a JSON file. This is acceptable for local demo, but weak for product use, multi-process safety, recovery, and audit.
- Matrix sync is manually triggered by `/api/matrix/sync-once`; there is no background observer loop.
- There is no product readiness command that runs unit tests, build, eval, browser smoke, and Matrix smoke as one gate.

### P2: Product Experience

- Users cannot inspect a clean run trace in the UI.
- Confirmation requests work, but the reason trail is not yet unified across all tools.
- Demo seed data should intentionally show one successful A2A negotiation, one blocked private-file request, one confirmation-required schedule update, and one evidence-cited answer.

---

## Product Definition of Done

The system is product-usable when all of the following are true:

- Public/product mode rejects unauthenticated state-changing requests by default.
- Tokens are not sent in URL query strings in product mode.
- Every Agent write action passes through `ToolRegistry`, `PolicyEngine`, and `ToolExecutor`.
- Every Agent run produces a trace with selected evidence, policy decisions, tool results, and final status.
- Internal-fact answers either cite authorized evidence or explicitly say the system does not have enough evidence.
- A2A negotiation uses first-class message types and each target agent responds through its own policy-gated runtime.
- Demo data and smoke scripts prove the main product workflows end to end.
- The product readiness command passes on a clean checkout.

---

## File Structure

### Existing Files to Modify

- `src/server/appServer.ts`: auth defaults, query-token policy, CORS product mode, download headers, readiness endpoint, Matrix observer wiring.
- `src/client/apiClient.ts`: remove production query-token usage, add authenticated SSE/download alternatives.
- `src/server/agentRunRuntime.ts`: shrink into a compatibility adapter over Agent Core v2 sessions.
- `src/server/agentRuntime.ts`: keep existing compatible helpers while moving file/task/calendar behavior into core tools.
- `src/server/agentAutopilotRuntime.ts`: replace synthetic A2A turn generation with protocolized A2A tools and sessions.
- `src/server/agentEval.ts`: expand from fallback intent eval into task-level product eval.
- `src/server/agentEvalCli.ts`: add product readiness modes and real-provider gating.
- `src/domain/types.ts`: add `AgentTrace`, structured A2A message types, and optional durable store metadata.
- `src/domain/demoState.ts`: seed product-ready demo scenarios.
- `src/App.tsx`: expose trace, readiness, and A2A protocol state without changing the core workbench model.

### Existing Core Files to Extend

- `src/server/agentCore/policyEngine.ts`: add policies for read tools, task updates, calendar proposals, A2A, memory writes, and web search.
- `src/server/agentCore/toolRegistry.ts`: register every product tool with validation metadata.
- `src/server/agentCore/toolExecutor.ts`: execute all registered tools through one policy and audit path.

### New Files to Create

- `src/server/security/auth.ts`: product-mode auth config, request token extraction, and token transport policy.
- `src/server/security/downloadPolicy.ts`: content headers, SVG policy, and attachment rules.
- `src/server/security/auth.test.ts`: auth and query-token regression tests.
- `src/server/security/downloadPolicy.test.ts`: download hardening tests.
- `src/server/agentCore/session.ts`: `AgentSession` state machine and bounded execution loop.
- `src/server/agentCore/session.test.ts`: session lifecycle tests.
- `src/server/agentCore/contextEngine.ts`: authorized evidence collection and ranking.
- `src/server/agentCore/contextEngine.test.ts`: evidence selection and no-evidence tests.
- `src/server/agentCore/trace.ts`: trace builders, trace serialization, and user-visible summaries.
- `src/server/agentCore/trace.test.ts`: trace completeness tests.
- `src/server/agentCore/a2aProtocol.ts`: A2A message schema, validation, and status transitions.
- `src/server/agentCore/a2aProtocol.test.ts`: protocol validation tests.
- `src/server/readiness/productReadiness.ts`: in-process readiness checks used by API and CLI.
- `src/server/readiness/productReadiness.test.ts`: readiness check tests.
- `scripts/product-readiness.mjs`: command that runs the product verification gate.
- `scripts/product-demo-seed.mjs`: deterministic seed for product demo workflows.

---

## Phase 0: Baseline and Product Readiness Gate

**Goal:** Make the current state measurable before refactoring.

**Acceptance:**

- One command reports unit tests, build, local eval, real eval availability, browser smoke status, and Matrix smoke status.
- The command fails clearly when product-critical checks are skipped without an explicit local-demo flag.

### Task 0.1: Add Product Readiness Script

**Files:**

- Create: `scripts/product-readiness.mjs`
- Modify: `package.json`

- [ ] Add a package script:

```json
"readiness:product": "node scripts/product-readiness.mjs"
```

- [ ] Implement the script so it runs these commands in order:

```text
npm run test
npm run build
npm run eval:agent
npm run eval:agent:real
npm run smoke:browser
npm run infra:smoke
```

- [ ] Add `--local-demo` support that skips `eval:agent:real` and `infra:smoke`, while printing both skipped checks.

- [ ] Verify:

```bash
npm run readiness:product -- --local-demo
```

Expected: exits `0` only when test, build, local eval, and browser smoke pass.

### Task 0.2: Record Baseline Product Status

**Files:**

- Create: `docs/superpowers/status/2026-05-07-agent-system-product-readiness.md`

- [ ] Record current pass/fail status for:

```text
npm run test
npm run build
npm run eval:agent
npm run eval:agent:real
npm run smoke:browser
npm run infra:smoke
```

- [ ] Record current demo data counts:

```text
users
agents
rooms
messages
actionRequests
a2aSessions
memories
```

- [ ] Add a short section named `Release Blockers` with the P0 items from this plan.

---

## Phase 1: API Security and Download Hardening

**Goal:** Make the server safe enough for a controlled product deployment.

**Acceptance:**

- Product mode requires auth by default.
- URL query tokens are rejected in product mode.
- SSE and downloads work without placing tokens in URLs.
- SVG downloads are safe by header policy or blocked by config.

### Task 1.1: Centralize Auth Policy

**Files:**

- Create: `src/server/security/auth.ts`
- Create: `src/server/security/auth.test.ts`
- Modify: `src/server/appServer.ts`

- [ ] Create `resolveAuthConfig` with this behavior:

```ts
export interface AuthConfig {
  apiToken?: string;
  requireAuth: boolean;
  allowQueryToken: boolean;
}
```

- [ ] Product mode rules:

```text
If AGENT_IM_PUBLIC_MODE=true, requireAuth must be true.
If NODE_ENV=production and AGENT_IM_ALLOW_NO_AUTH is not true, requireAuth must be true.
If requireAuth is true and apiToken is missing, server startup must fail.
If allowQueryToken is false, agent_im_token must not authenticate requests.
```

- [ ] Local demo rules:

```text
If neither production nor AGENT_IM_PUBLIC_MODE is enabled, no-token local mode remains supported.
```

- [ ] Move token extraction from `appServer.ts` into `auth.ts`.

- [ ] Verify:

```bash
npm run test -- src/server/security/auth.test.ts src/server/appServer.test.ts
npm run build
```

### Task 1.2: Remove Product Query Token Usage

**Files:**

- Modify: `src/client/apiClient.ts`
- Modify: `src/client/apiClient.test.ts`
- Modify: `src/server/appServer.test.ts`

- [ ] Replace tokenized EventSource URLs with a fetch-based SSE reader that sends:

```text
x-agent-im-token: <token>
```

- [ ] Replace tokenized download URLs with an authenticated fetch download helper.

- [ ] Keep query token support only when `allowQueryToken=true` in local demo mode.

- [ ] Verify existing client tests no longer expect:

```text
agent_im_token=
```

in product-mode URLs.

- [ ] Run:

```bash
npm run test -- src/client/apiClient.test.ts src/server/appServer.test.ts
npm run build
```

### Task 1.3: Harden Downloads and SVG Handling

**Files:**

- Create: `src/server/security/downloadPolicy.ts`
- Create: `src/server/security/downloadPolicy.test.ts`
- Modify: `src/server/appServer.ts`
- Modify: `src/server/appServer.test.ts`

- [ ] Add these headers to file responses:

```text
Content-Disposition: attachment
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: private, no-store
```

- [ ] In product mode, either reject uploaded `image/svg+xml` files or serve them only as attachment with the hardening headers above.

- [ ] Keep demo assets working in local demo mode.

- [ ] Run:

```bash
npm run test -- src/server/security/downloadPolicy.test.ts src/server/appServer.test.ts src/server/demoAssets.test.ts
npm run build
```

---

## Phase 2: Evidence, Trace, and No-Evidence Discipline

**Goal:** Make every internal answer auditable and prevent unsupported claims.

**Acceptance:**

- Every `/api/agent/run` result has a trace id.
- Every trace records selected evidence, tool calls, policy decisions, and final status.
- File search and LLM file-share flows validate evidence before answering or acting.

### Task 2.1: Add First-Class AgentTrace

**Files:**

- Modify: `src/domain/types.ts`
- Create: `src/server/agentCore/trace.ts`
- Create: `src/server/agentCore/trace.test.ts`
- Modify: `src/server/agentRunRuntime.ts`
- Modify: `src/server/appServer.ts`

- [ ] Add these domain types:

```ts
export type AgentTraceStepKind = 'context' | 'plan' | 'policy' | 'tool' | 'observation' | 'response';

export interface AgentTraceStep {
  id: string;
  kind: AgentTraceStepKind;
  status: 'ok' | 'blocked' | 'needs_confirmation' | 'failed';
  summary: string;
  evidenceIds: string[];
  toolName?: string;
  policyOutcome?: 'allow' | 'deny' | 'require_confirmation';
  createdAt: string;
}

export interface AgentTrace {
  id: string;
  runId: string;
  agentId: string;
  roomId: string;
  goal: string;
  steps: AgentTraceStep[];
  finalStatus: 'completed' | 'blocked' | 'needs_confirmation' | 'failed';
  userVisibleSummary: string;
  createdAt: string;
}
```

- [ ] Add `agentTraces: AgentTrace[]` to `DemoState`.

- [ ] Ensure `/api/agent/run` stores one trace per run.

- [ ] Run:

```bash
npm run test -- src/server/agentCore/trace.test.ts src/server/agentPlanRuntime.test.ts src/server/appServer.test.ts
npm run build
```

### Task 2.2: Add ContextEngine for Authorized Evidence

**Files:**

- Create: `src/server/agentCore/contextEngine.ts`
- Create: `src/server/agentCore/contextEngine.test.ts`
- Modify: `src/server/agentRunRuntime.ts`

- [ ] Implement a read-only evidence bundle:

```ts
export interface ContextEvidence {
  id: string;
  type: 'message' | 'file_metadata' | 'file_text' | 'task' | 'calendar' | 'memory' | 'a2a_turn';
  summary: string;
  confidence: number;
  visibility: 'current_room' | 'authorized_room' | 'owner_private';
  whySelected: string;
}

export interface AgentContextBundle {
  evidence: ContextEvidence[];
  missing: string[];
}
```

- [ ] Enforce allowed room and owner boundaries inside `ContextEngine`.

- [ ] Replace ad hoc evidence filtering in chat, deadline, summary, and file search with the new bundle.

- [ ] Run:

```bash
npm run test -- src/server/agentCore/contextEngine.test.ts src/domain/agentEngine.test.ts src/server/agentPlanRuntime.test.ts
npm run eval:agent
```

### Task 2.3: Close Remaining Evidence Gaps

**Files:**

- Modify: `src/domain/agentEngine.ts`
- Modify: `src/domain/agentEngine.test.ts`
- Modify: `src/server/agentRunRuntime.ts`
- Modify: `src/server/agentPlanRuntime.test.ts`

- [ ] File search with no authorized match must return an empty result and clear wording.

- [ ] LLM-selected file ids must be filtered through `ContextEngine` before `file.share` policy runs.

- [ ] If no valid selected file remains, the result must be `needs_confirmation` or `blocked`, never auto-executed.

- [ ] Run:

```bash
npm run test -- src/domain/agentEngine.test.ts src/server/agentPlanRuntime.test.ts src/server/agentCore/toolExecutor.test.ts
npm run eval:agent
npm run build
```

---

## Phase 3: Complete Agent Core v2 Runtime

**Goal:** Replace large intent branches with a bounded, policy-gated AgentSession loop.

**Acceptance:**

- `/api/agent/run` still returns the current compatible response shape.
- Internally, mixed user goals run through `AgentSession`.
- Every registered tool has validation, policy, execution, trace, and tests.

### Task 3.1: Expand ToolRegistry

**Files:**

- Modify: `src/server/agentCore/toolRegistry.ts`
- Modify: `src/server/agentCore/toolRegistry.test.ts`
- Modify: `src/server/agentCore/policyEngine.ts`
- Modify: `src/server/agentCore/policyEngine.test.ts`

- [ ] Add these tool names:

```text
context.search_messages
context.search_files
file.read_text
task.inspect
task.propose_update
calendar.inspect
calendar.propose_update
memory.search
memory.write
web.search
agent.coordinate
```

- [ ] For each tool, define:

```text
sideEffect
requiredPermissions
riskPolicy
validateInput
```

- [ ] Add tests proving invalid input fails before policy and execution.

- [ ] Run:

```bash
npm run test -- src/server/agentCore/toolRegistry.test.ts src/server/agentCore/policyEngine.test.ts
```

### Task 3.2: Expand ToolExecutor

**Files:**

- Modify: `src/server/agentCore/toolExecutor.ts`
- Modify: `src/server/agentCore/toolExecutor.test.ts`
- Modify: `src/server/agentRuntime.ts`
- Modify: `src/server/agentRunRuntime.ts`

- [ ] Move task update suggestions into `task.propose_update`.

- [ ] Move schedule changes into `calendar.propose_update`.

- [ ] Move file search into `context.search_files`.

- [ ] Move room summaries into `context.search_messages` plus response composition.

- [ ] Ensure write tools return one of:

```text
ok
denied
needs_confirmation
failed
```

- [ ] Run:

```bash
npm run test -- src/server/agentCore/toolExecutor.test.ts src/server/agentPlanRuntime.test.ts src/server/agentRuntime.test.ts
npm run eval:agent
npm run build
```

### Task 3.3: Introduce AgentSession Loop

**Files:**

- Create: `src/server/agentCore/session.ts`
- Create: `src/server/agentCore/session.test.ts`
- Modify: `src/server/agentRunRuntime.ts`

- [ ] Implement session statuses:

```text
running
waiting_for_user
needs_confirmation
completed
failed
```

- [ ] Limit the first product loop to four steps.

- [ ] Stop the loop when:

```text
answer is sufficient
user clarification is required
policy requires confirmation
policy denies action
tool fails without fallback
max steps reached
```

- [ ] Keep `/api/agent/run` response compatibility by mapping `AgentSession` output to the existing result shape.

- [ ] Run:

```bash
npm run test -- src/server/agentCore/session.test.ts src/server/agentPlanRuntime.test.ts src/server/appServer.test.ts
npm run eval:agent
npm run build
```

### Task 3.4: Delete or Quarantine Legacy Runtime Helpers

**Files:**

- Modify: `src/server/agentRunRuntime.ts`
- Modify: `src/server/agentRuntime.ts`
- Modify: `src/server/appServer.ts`

- [ ] Identify helpers that are no longer called after `AgentSession` migration.

- [ ] Remove dead helper code when tests prove it is unused.

- [ ] For still-supported legacy endpoints, route them through `AgentSession` instead of direct helper calls.

- [ ] Run:

```bash
npm run test
npm run eval:agent
npm run build
```

---

## Phase 4: Protocolize A2A

**Goal:** Make A2A a real constrained protocol instead of only a generated session log.

**Acceptance:**

- A2A messages are validated by schema.
- Each target agent responds through its own permissions, context, and policy.
- A2A cannot bypass confirmation rules for task, calendar, file, or message writes.

### Task 4.1: Add A2A Protocol Schema

**Files:**

- Create: `src/server/agentCore/a2aProtocol.ts`
- Create: `src/server/agentCore/a2aProtocol.test.ts`
- Modify: `src/domain/types.ts`

- [ ] Define message types:

```text
proposal
capability_check
availability_response
resource_response
counter_proposal
final_summary
blocked
```

- [ ] Add validation for sender agent, target agent, room scope, evidence ids, and requested action.

- [ ] Run:

```bash
npm run test -- src/server/agentCore/a2aProtocol.test.ts
npm run build
```

### Task 4.2: Move A2A into ToolExecutor

**Files:**

- Modify: `src/server/agentCore/toolRegistry.ts`
- Modify: `src/server/agentCore/toolExecutor.ts`
- Modify: `src/server/agentCore/policyEngine.ts`
- Modify: `src/server/agentAutopilotRuntime.ts`
- Modify: `src/server/agentAutopilotRuntime.test.ts`

- [ ] Add tools:

```text
a2a.propose
a2a.respond
a2a.finalize
```

- [ ] For `a2a.respond`, run the target agent through a constrained `AgentSession`.

- [ ] Ensure every A2A response records:

```text
target agent id
authorized evidence ids
policy outcome
tool observations
final turn type
```

- [ ] Run:

```bash
npm run test -- src/server/agentAutopilotRuntime.test.ts src/server/agentCore/toolExecutor.test.ts src/server/appServer.test.ts
npm run eval:agent
npm run build
```

### Task 4.3: Product A2A UX and Demo Seed

**Files:**

- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Modify: `src/domain/demoState.ts`
- Create: `scripts/product-demo-seed.mjs`
- Modify: `src/server/agentAutopilotRuntime.test.ts`

- [ ] Seed one successful schedule negotiation.

- [ ] Seed one counter-proposal caused by a calendar conflict.

- [ ] Seed one blocked private-file request.

- [ ] Update A2A panel labels to show protocol turn type, policy status, and evidence count.

- [ ] Run:

```bash
npm run test -- src/server/agentAutopilotRuntime.test.ts src/App.test.tsx
npm run smoke:browser
npm run build
```

---

## Phase 5: Persistence and Matrix Operations

**Goal:** Make product data durable and make Matrix ingestion continuous.

**Acceptance:**

- Single-process JSON remains supported for local demo.
- Product mode can use a durable store with transactional updates.
- Matrix events can be observed in the background with deduplication and restart safety.

### Task 5.1: Add Store Interface

**Files:**

- Modify: `src/server/stateStore.ts`
- Create: `src/server/stateStore.test.ts`
- Create: `src/server/store/types.ts`
- Create: `src/server/store/jsonStateStore.ts`

- [ ] Define:

```ts
export interface AgentStateStore {
  read(): Promise<DemoState>;
  update(mutator: (state: DemoState) => DemoState | Promise<DemoState>): Promise<DemoState>;
}
```

- [ ] Move current JSON behavior behind `jsonStateStore`.

- [ ] Keep existing tests passing without a database dependency.

- [ ] Run:

```bash
npm run test -- src/server/stateStore.test.ts src/server/appServer.test.ts
npm run build
```

### Task 5.2: Add Product Database Store

**Files:**

- Create: `src/server/store/sqliteStateStore.ts`
- Create: `src/server/store/sqliteStateStore.test.ts`
- Create: `scripts/migrate-json-state-to-sqlite.mjs`
- Modify: `package.json`

- [ ] Add a concrete SQLite dependency before implementation:

```bash
npm install better-sqlite3
```

- [ ] Store canonical state tables for:

```text
users
agents
rooms
messages
files
tasks
calendarEvents
actionLogs
actionRequests
a2aSessions
agentTraces
memories
```

- [ ] Add migration from the current JSON file to SQLite.

- [ ] Run:

```bash
npm run test -- src/server/store/sqliteStateStore.test.ts src/server/appServer.test.ts
npm run build
```

### Task 5.3: Add Matrix Background Observer

**Files:**

- Create: `src/server/matrixObserver.ts`
- Create: `src/server/matrixObserver.test.ts`
- Modify: `src/server/appServer.ts`
- Modify: `src/server/start.ts`

- [ ] Add config:

```text
MATRIX_OBSERVER_ENABLED=true
MATRIX_OBSERVER_INTERVAL_MS=3000
```

- [ ] Reuse current sync logic from `/api/matrix/sync-once`.

- [ ] Persist the last processed Matrix event id.

- [ ] Deduplicate imported messages by Matrix event id.

- [ ] Run:

```bash
npm run test -- src/server/matrixObserver.test.ts src/server/runtimeUpgrade.test.ts
npm run infra:smoke
npm run build
```

---

## Phase 6: Product UI and Operator Experience

**Goal:** Make users and operators understand what the agents did and why.

**Acceptance:**

- Users can inspect evidence and trace summaries.
- Operators can see readiness, provider status, Matrix status, and auth mode.
- Confirmation requests show consistent policy reasons.

### Task 6.1: Trace Inspector

**Files:**

- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Modify: `src/App.test.tsx`

- [ ] Add a trace panel for the selected agent run.

- [ ] Show:

```text
goal
final status
evidence count
tool calls
policy decisions
user-visible summary
```

- [ ] Do not show chain-of-thought or raw hidden prompts.

- [ ] Run:

```bash
npm run test -- src/App.test.tsx
npm run smoke:browser
npm run build
```

### Task 6.2: Readiness and Provider Status

**Files:**

- Create: `src/server/readiness/productReadiness.ts`
- Create: `src/server/readiness/productReadiness.test.ts`
- Modify: `src/server/appServer.ts`
- Modify: `src/App.tsx`

- [ ] Add `/api/readiness` returning:

```text
auth mode
provider configured
matrix configured
store mode
last matrix sync
last eval status if available
```

- [ ] Add a compact UI status strip.

- [ ] Run:

```bash
npm run test -- src/server/readiness/productReadiness.test.ts src/server/appServer.test.ts src/App.test.tsx
npm run build
```

---

## Phase 7: Product Evaluation Suite

**Goal:** Evaluate task completion, safety, and A2A behavior rather than only intent selection.

**Acceptance:**

- At least 60 task-level eval cases exist.
- Safety eval pass rate must be 100%.
- Critical workflow eval pass rate must be at least 90%.
- Each failed eval includes the trace id or trace summary needed to debug it.

### Task 7.1: Expand Eval Case Model

**Files:**

- Modify: `src/server/agentEval.ts`
- Modify: `src/server/agentEvalCli.ts`
- Create: `src/server/agentEvalProduct.test.ts`

- [ ] Add eval categories:

```text
task_completion
evidence_grounding
security_boundary
confirmation_gate
a2a_protocol
interaction_quality
```

- [ ] Require expected evidence ids for internal-fact cases.

- [ ] Require expected policy outcome for write-action cases.

- [ ] Run:

```bash
npm run test -- src/server/agentEvalProduct.test.ts
npm run eval:agent
```

### Task 7.2: Add Product Eval Cases

**Files:**

- Modify: `src/server/agentEval.ts`

- [ ] Add at least 20 evidence-grounding cases.

- [ ] Add at least 15 security-boundary cases.

- [ ] Add at least 10 A2A protocol cases.

- [ ] Add at least 10 confirmation-gate cases.

- [ ] Add at least 5 interaction-quality cases.

- [ ] Run:

```bash
npm run eval:agent
npm run eval:agent:real
```

---

## Recommended Execution Order

1. Phase 0: baseline and readiness gate.
2. Phase 1: auth, token transport, and download hardening.
3. Phase 2: trace and evidence closure.
4. Phase 3: complete Agent Core v2 runtime.
5. Phase 4: protocolized A2A.
6. Phase 7: product eval expansion.
7. Phase 6: trace/readiness UI.
8. Phase 5: persistence and Matrix operations.

This order puts security and verification first, then replaces the runtime in controlled slices, then improves user-facing and operational depth.

---

## Release Gates

### Internal Demo Gate

Required:

```bash
npm run test
npm run build
npm run eval:agent
npm run smoke:browser
```

Allowed skips:

```text
eval:agent:real
infra:smoke
```

Only allowed when the release note says this is a local-only demo.

### Controlled Product Pilot Gate

Required:

```bash
npm run readiness:product
```

No skipped checks.

Required environment:

```text
AGENT_IM_PUBLIC_MODE=true
AGENT_IM_API_TOKEN=<configured>
AGENT_IM_ALLOWED_ORIGINS=<explicit origins>
VITE_AGENT_API_TOKEN=<configured for local pilot only or replaced by session auth>
```

### Public Deployment Gate

Required:

```text
No query token authentication
No unauthenticated state-changing routes
No inline SVG rendering from uploaded files
Real-provider eval passes
Browser smoke passes
Matrix smoke passes if Matrix is enabled
Every write action has policy decision and trace
```

---

## Residual Risks

- Planner quality remains the largest product risk after security. Limit the first loop to four steps and keep write actions behind policy.
- SQLite migration adds dependency and packaging work. Keep JSON store available for local demos until the database store is stable.
- A2A protocolization can expand scope quickly. Keep v1 focused on schedule, file-resource, and task-status negotiation.
- Real LLM eval may expose unstable prompt behavior. Treat that as product feedback, not a reason to bypass the eval.

---

## Self-Review

- Spec coverage: This plan covers the known safety, verification, Agent Core v2, evidence, A2A, persistence, Matrix, UI, and eval gaps.
- Open-marker scan: No open markers are used.
- Type consistency: New types are aligned with existing `DemoState`, `AgentActionRequest`, `A2ASession`, and Agent Core tool modules.
