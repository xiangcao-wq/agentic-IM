# AgentBridge v0.1.0-demo Readiness

## Status

Date: 2026-05-07

Release target: `v0.1.0-demo`

Branch: `ui-polish-agent-workbench`

Purpose: freeze the current local AgentBridge demo as a reproducible rollback baseline before product architecture refactors begin.

## Gate Results

| Gate | Command | Status | Notes |
| --- | --- | --- | --- |
| Unit tests | `npm run test` | PASS | 33 files, 214 tests passed during `npm run readiness:product -- --local-demo`. |
| Production build | `npm run build` | PASS | TypeScript and Vite build passed during `npm run readiness:product -- --local-demo`. |
| Local Agent eval | `npm run eval:agent` | PASS | 40/40 cases passed during `npm run readiness:product -- --local-demo`. |
| Browser smoke | `npm run smoke:browser` | PASS | Passed through `npm run readiness:product -- --local-demo`; no page errors or console errors. |
| Matrix/API smoke | `npm run infra:smoke` | NOT RUN | Optional for local demo; required for Matrix-enabled pilot. |
| Product readiness local demo | `npm run readiness:product -- --local-demo` | PASS | Local demo gate passed with real-provider eval and Matrix/API smoke intentionally skipped. |

## Demo Data Snapshot

Seeded `data/agent-im-db.json` snapshot after `npm run demo:prepare`:

| Collection | Count |
| --- | ---: |
| users | 4 |
| agents | 4 |
| rooms | 3 |
| messages | 37 |
| files | 25 |
| fileTextChunks | 11 |
| tasks | 5 |
| calendar | 5 |
| actionLogs | 21 |
| actionRequests | 0 |
| a2aSessions | 0 |
| memories | 0 |

`data/agent-im-db.json` is runtime state. The release source of truth is the deterministic seed path through `npm run demo:prepare`.

## Local Gate Environment

The passing local demo gate used:

- `DEEPSEEK_API_KEY` explicitly set to blank so the API uses fallback/local Agent rules.
- `MATRIX_BOOTSTRAP_PATH=local` so local browser smoke does not require a running Synapse homeserver.
- API at `http://127.0.0.1:8791`.
- Web at `http://127.0.0.1:5175`.

## Release Blockers

These do not block `v0.1.0-demo`, but they block a controlled server or public product release:

- Production auth is not fail-closed yet.
- URL query token transport still exists for SSE/download flows.
- CORS defaults are local-demo oriented.
- Download hardening is not yet centralized.
- JSON state remains the runtime store.
- Matrix is still close to the business runtime instead of isolated as a connector.
- Agent traces are not yet first-class product objects.

## Release Criteria

`v0.1.0-demo` can be tagged when:

- `npm run demo:prepare` completes.
- `npm run readiness:product -- --local-demo` passes with API and web servers running.
- `git status --short --ignored=no` contains only intentional source changes.
- Runtime/generated artifacts are ignored.
- `data/agent-im-db.json` is no longer tracked as a release source file.

## Next Phase

After this tag, implement Phase 1 from the product architecture spec:

1. Centralized auth policy.
2. Production fail-closed token requirements.
3. Query-token removal for product mode.
4. CORS allowlist behavior.
5. Download header hardening.
6. `/api/readiness`.
