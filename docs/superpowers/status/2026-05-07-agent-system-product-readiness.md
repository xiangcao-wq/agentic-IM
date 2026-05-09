# Agent System Product Readiness Status

Date: 2026-05-07

## Baseline Checks

| Check | Status | Notes |
| --- | --- | --- |
| `npm run test` | Passed | 32 test files, 212 tests passed |
| `npm run build` | Passed | `tsc --noEmit` and Vite production build passed |
| `npm run eval:agent` | Passed | 40/40 fallback/local agent eval cases passed |
| `npm run eval:agent:real` | Not run | Requires real provider call and should be part of product pilot gate |
| `npm run smoke:browser` | Blocked | API can start, but Vite dev server failed in background startup with `Error: spawn EPERM` while launching esbuild |
| `npm run infra:smoke` | Not run | Requires local API, web server, and Matrix smoke environment |

## Demo Data Counts

Current `data/agent-im-db.json` counts at baseline:

| Collection | Count |
| --- | ---: |
| users | 4 |
| agents | 4 |
| rooms | 3 |
| messages | 47 |
| actionRequests | 0 |
| a2aSessions | 0 |
| memories | 0 |

## Release Blockers

- Product mode must require API auth by default.
- Query-string token transport must be removed or limited to local demo mode.
- Download responses need hardened headers and an explicit SVG policy.
- Real provider eval has not been run.
- Browser smoke is not yet part of an automated readiness gate with managed local services.
- Matrix smoke is not yet part of an automated readiness gate with managed local services.
- Current persisted demo data has no preloaded A2A sessions.

## Recent Verification

- Added `scripts/product-readiness.mjs`.
- Added `readiness:product` package script.
- Verified `npm run readiness:product -- --help`.
- Verified `package.json` parses successfully.
- Attempted local browser-smoke setup with a temporary API database at `tmp/readiness-agent-im-db.json`.
- Cleaned up the residual `8791` API process after the Vite startup failure.

## 2026-05-08 Product Kernel Slice

Implemented the first Product Kernel slice:

- Agent runs now emit canonical Product Kernel events.
- A local JSONL AgentEventStore provides durable replay for controlled pilot usage.
- `/api/agent-runs/:runId/events` returns cursor-based event replay.
- `/api/traces/:runId` returns trace replay payloads.
- `/api/readiness` includes Agent event log health.

This is not the final Postgres event store. It establishes the interface and API contract that the Postgres adapter will implement in the next storage-focused slice.

## 2026-05-09 Tool Platform v2 Slice

Implemented the second Product Kernel slice:

- Core tools now expose product-grade metadata for visibility, audit, permission, side effect, category, and version.
- Permission Broker converts existing policy decisions into explicit allow / deny / ask decisions.
- Tool Executor returns permission decisions and invocation audit payloads for `message.send` and `file.share`.
- Runtime compatibility checks confirm existing delegated message and file share flows still behave as before.

This slice does not persist `tool_invocations` or `permission_requests` to Postgres yet. It establishes the typed backend contract that the future Permission Center UI and database-backed audit ledger can consume.

## 2026-05-09 Tool Audit EventLog Bridge Slice

Implemented the third Product Kernel slice:

- Tool invocation audit records are converted into domain-safe snapshots and carried through Agent progress events.
- ProductHarness persists tool execution and permission decisions as canonical AgentEvent entries.
- `/api/agent-runs/:runId/events` replays `agent.tool.*` and `agent.permission.*` events alongside run/progress events.
- `/api/traces/:runId` includes tool audit events and aggregates audited tool calls for trace replay.
- JSONL EventLog replay validation now recognizes the canonical tool and permission event types.

Remaining gap: audit events still use the local EventLog adapter. Postgres-backed multi-tenant audit storage remains a future persistence slice.

## 2026-05-09 Workbench Timeline + Permission Center Slice

Implemented the fourth Product Kernel slice:

- Browser client now has typed contracts for Agent run event replay and trace replay.
- Agent Workbench fetches `/api/traces/:runId` after product Agent runs.
- Workbench renders a compact Agent Timeline from replayed run, tool, and permission events.
- Workbench renders a first Permission Center from `agent.permission.*` events.
- Raw SSE progress remains hidden from the compact Workbench; replayed EventLog data is the product-facing source.

Remaining gap: this is a per-run Workbench surface. Cross-run trace search, policy editing, and Postgres-backed audit querying remain future product slices.
