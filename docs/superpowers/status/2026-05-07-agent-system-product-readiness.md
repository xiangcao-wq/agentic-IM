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
