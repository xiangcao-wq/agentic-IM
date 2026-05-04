# Agent IM Infra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the infrastructure foundation for a real personal-Agent IM demo: persistent state boundary, database-ready schema, Matrix event sync, Agent action pipeline, permission/risk gates, and reproducible local operations.

**Architecture:** Matrix remains the communication source of truth for rooms, messages, and media. The Agent IM API owns product state, Agent actions, authorization, tasks, calendar, file metadata, and audit logs through a repository boundary that can move from JSON to SQLite/Postgres without rewriting product logic. Agent behavior moves from direct button handlers to a queued runtime that plans, risk-assesses, executes tools, records audit logs, and publishes state changes.

**Tech Stack:** TypeScript, Node HTTP server, React/Vite, Matrix Synapse in Docker, Vitest, current JSON persistence first, SQLite/Postgres-ready store interface next.

---

## Target Infra Layers

1. **State Store Boundary**
   - `StateStore` interface: `init()`, `read()`, `write()`, and later transaction support.
   - First implementation: `JsonStateStore`.
   - Next implementation: SQLite-backed store with schema migration and seed/reset.

2. **Matrix Adapter Layer**
   - Keep Matrix client-server operations isolated in `matrixClient.ts`.
   - Add event sync checkpoints so Matrix messages can be observed continuously instead of fetched only during `/api/state`.
   - Keep media upload/download under Matrix adapter.

3. **Agent Action Runtime**
   - Introduce `AgentActionRequest` for pending/executed/blocked actions.
   - Route summarize, deadline, file share, coordinate, task update, and calendar update through a single pipeline.
   - Pipeline stages: intent input -> context gather -> plan -> risk assessment -> confirmation decision -> tool execution -> audit log -> UI publish.

4. **Permission And Risk Infra**
   - Separate authorization from UI buttons.
   - Agent can only read rooms/files/tools in its policy.
   - Low-risk read-only actions execute automatically.
   - Medium/high-risk actions enter confirmation queue.

5. **Tool Registry**
   - Tools are explicit functions with typed input/output.
   - Initial tools: room search, Matrix send message, file upload/download/share, task update, calendar suggest/update.
   - Every tool call creates an audit trail.

6. **Operational Infra**
   - One command starts Matrix, bootstraps demo data, starts API and web.
   - One command resets product DB and Matrix rooms to a known demo state.
   - Smoke tests verify API, Matrix upload/download, Agent action queue, and browser workflow.

---

## Task 1: Extract StateStore Boundary

**Files:**
- Create: `src/server/stateStore.ts`
- Create: `src/server/stateStore.test.ts`
- Modify: `src/server/appServer.ts`

- [x] **Step 1: Write the failing test**

Create `src/server/stateStore.test.ts` with tests that import `JsonStateStore`, initialize a missing DB path, persist a changed `DemoState`, and read it back.

- [x] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL because `src/server/stateStore.ts` does not exist.

- [x] **Step 3: Write minimal implementation**

Implement:

```ts
export interface StateStore {
  init(): Promise<void>;
  read(): Promise<DemoState>;
  write(state: DemoState): Promise<void>;
}

export class JsonStateStore implements StateStore {
  constructor(private readonly dbPath: string) {}
  async init(): Promise<void> {}
  async read(): Promise<DemoState> {}
  async write(state: DemoState): Promise<void> {}
}
```

Use the existing JSON persistence behavior currently embedded in `appServer.ts`.

- [x] **Step 4: Wire appServer to the boundary**

Replace the private `JsonDatabase` class in `appServer.ts` with `JsonStateStore`.

- [x] **Step 5: Verify**

Run: `npm run test` and `npm run build`

Expected: all tests pass and production build succeeds.

---

## Task 2: Add Database-Ready State Schema

**Files:**
- Create: `src/server/stateSchema.ts`
- Create: `src/server/stateSchema.test.ts`
- Modify: `src/server/stateStore.ts`

- [x] **Step 1: Write failing tests**

Test that a persisted state snapshot is normalized into named collections: users, agents, rooms, messages, files, tasks, calendar, actionLogs.

- [x] **Step 2: Implement schema helpers**

Add `getStateCollections()` and `validateDemoStateShape()` so later SQLite migrations can use the same collection names.

- [x] **Step 3: Verify**

Run: `npm run test` and `npm run build`.

---

## Task 3: Add Agent Action Queue Types And Store Operations

**Files:**
- Modify: `src/domain/types.ts`
- Create: `src/domain/actionQueue.ts`
- Create: `src/domain/actionQueue.test.ts`
- Modify: `src/domain/demoState.ts`

- [x] **Step 1: Write failing tests**

Test that a requested action can be queued as `pending`, marked `executed`, marked `needs_confirmation`, and linked to an `AgentActionLog`.

- [x] **Step 2: Implement types**

Add `AgentActionRequest` with fields: `id`, `agentId`, `roomId`, `kind`, `status`, `input`, `risk`, `createdAt`, `updatedAt`, `requiresHuman`, `logId`.

- [x] **Step 3: Add queue helpers**

Implement pure helpers for enqueue, complete, block, and require confirmation.

- [x] **Step 4: Verify**

Run: `npm run test` and `npm run build`.

---

## Task 4: Route Existing Agent Buttons Through The Queue

**Files:**
- Create: `src/server/agentRuntime.ts`
- Create: `src/server/agentRuntime.test.ts`
- Modify: `src/server/appServer.ts`

- [x] **Step 1: Write failing tests**

Test that `/api/agent/share-file` creates an action request, evaluates risk, executes low-risk share, and writes both action request and audit log.

- [x] **Step 2: Implement runtime orchestration**

Move direct execution logic from route handlers into `agentRuntime.ts`.

- [x] **Step 3: Preserve existing API shape**

The current frontend endpoints continue returning `{ result }` or `{ result, message }`.

- [x] **Step 4: Verify**

Run: `npm run test` and `npm run build`.

Note: the first runtime migration covers `/api/agent/share-file`, which is the critical write-capable Agent action. Summary, deadline, and coordination can now move through the same runtime boundary as the confirmation workflow expands.

---

## Task 5: Add Confirmation Queue API

**Files:**
- Modify: `src/server/appServer.ts`
- Modify: `src/client/apiClient.ts`
- Create: `src/server/confirmationQueue.test.ts`

- [x] **Step 1: Write failing API tests**

Test `GET /api/agent/actions`, `POST /api/agent/actions/:id/confirm`, and `POST /api/agent/actions/:id/reject`.

- [x] **Step 2: Implement endpoints**

High-risk actions remain pending until confirmed or rejected.

- [x] **Step 3: Verify**

Run: `npm run test` and `npm run build`.

Note: confirmation and rejection now close queued actions and create human-review audit logs. Confirmed file-share actions execute the share tool and persist the resulting message. The frontend workbench shows pending actions with confirm/reject controls.

---

## Task 6: Add Matrix Event Observer Checkpoints

**Files:**
- Create: `src/server/matrixSync.ts`
- Create: `src/server/matrixSync.test.ts`
- Modify: `src/server/matrixClient.ts`
- Modify: `src/server/start.ts`

- [x] **Step 1: Write failing tests**

Test that Matrix sync token/checkpoint is stored and that new `m.room.message` events can be converted into local `Message` entries without duplication.

- [ ] **Step 2: Implement observer loop**

Poll Matrix `/sync` with the stored token in local dev mode.

- [ ] **Step 3: Publish state changes**

When new Matrix events arrive, publish SSE updates to the frontend.

- [ ] **Step 4: Verify with Synapse**

Start Matrix, API, web, send a Matrix message, and confirm it appears without manual refresh.

Note: `/api/state` no longer imports Matrix history during a plain read; explicit `/api/matrix/sync-once` imports Matrix events and persists checkpoints. The remaining work is a background `/sync` observer loop.

---

## Task 7: Add Reproducible Dev Commands

**Files:**
- Modify: `package.json`
- Modify: `scripts/dev-full.mjs`
- Create: `scripts/reset-demo.mjs`
- Modify: `README.md`

- [x] **Step 1: Add scripts**

Add scripts for `infra:up`, `infra:reset`, `infra:smoke`, and `dev:full`.

- [x] **Step 2: Add smoke checks**

Smoke check API state, explicit Matrix sync, one Agent action, and frontend page load.

- [ ] **Step 3: Verify**

Run all commands on a clean local state.

---

## Execution Order

1. Task 1 first, because every later infra layer needs a stable persistence boundary.
2. Task 2 second, because schema naming prevents ad-hoc JSON shape drift.
3. Task 3 and Task 4 next, because Agent runtime needs a queue and orchestration boundary.
4. Task 5 then exposes pending actions to users.
5. Task 6 adds real background Matrix observation.
6. Task 7 makes the entire stack reproducible.

## Self-Review

- Spec coverage: covers persistence, Matrix adapter, Agent runtime, permissions/risk, tools, audit, real-time sync, and local operations.
- Placeholder scan: no task depends on an undefined future feature; each task has concrete files and verification commands.
- Type consistency: all planned state work builds from `DemoState`, `AgentActionLog`, and the new `AgentActionRequest`.
