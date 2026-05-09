# AgentBridge Release Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the current AgentBridge demo into a clean, reproducible, tagged `v0.1.0-demo` baseline before product architecture refactors begin.

**Architecture:** This phase does not change product behavior. It separates source from generated/runtime artifacts, records release readiness, verifies the local demo gate, commits only release-relevant files, and tags a rollback point. Runtime JSON and generated media remain reproducible from seed scripts rather than treated as product source.

**Tech Stack:** Git, npm scripts, TypeScript/Vite/Vitest, Playwright browser smoke, existing demo seed scripts.

---

## Scope

This plan implements Phase 0 from `docs/superpowers/specs/2026-05-07-agentbridge-product-architecture-design.md`.

In scope:

- Ignore generated release artifacts that currently pollute `git status`.
- Add a release status document for the current demo baseline.
- Remove tracked runtime JSON from the release source index while preserving the local file.
- Run the internal demo release gate.
- Commit release freeze files with a narrow staging command.
- Tag `v0.1.0-demo`.

Out of scope:

- API auth hardening.
- Query-token removal.
- Postgres migration.
- AgentSession v2 implementation.
- UI component splitting.
- Worker and connector migration.

## File Structure

### Files to Modify

- `.gitignore`: add missing generated artifact directories and UI snapshot markdown.
- Git index only: stop tracking `data/agent-im-db.json` while preserving the working copy.

### Files to Create

- `docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md`: release status, gate results, demo data counts, release blockers, and next phase.

### Files to Read During Execution

- `docs/superpowers/specs/2026-05-07-agentbridge-product-architecture-design.md`
- `package.json`
- `README.md`
- `.gitignore`
- `scripts/product-readiness.mjs`
- `scripts/prepare-demo-db.mjs`

---

## Task 1: Tighten Artifact Ignore Rules

**Files:**

- Modify: `.gitignore`

- [ ] **Step 1: Inspect current ignore rules**

Run:

```bash
Get-Content -Path .gitignore
```

Expected: the file already ignores `node_modules/`, `dist/`, `data/*.json`, `data/media/`, `.env*`, `synapse-data/`, `.playwright-mcp/`, `tmp/`, `*.log`, `agent-im-ui*.png`, and `demo-output/`.

- [ ] **Step 2: Add missing generated artifacts**

Patch `.gitignore` so the final file contains exactly these artifact rules:

```gitignore
node_modules/
dist/
data/*.json
data/media/
data/backups/
.env*
!.env.example
synapse-data/
.playwright-mcp/
tmp/
*.tsbuildinfo
*.log
agent-im-ui*.png
agent-im-ui-snapshot.md
demo-output/
output/
```

- [ ] **Step 3: Verify ignore behavior**

Run:

```bash
git check-ignore output/pdf/example.pdf data/backups/agent-im-db.20260506-123951.json agent-im-ui-snapshot.md
```

Expected output includes:

```text
output/pdf/example.pdf
data/backups/agent-im-db.20260506-123951.json
agent-im-ui-snapshot.md
```

- [ ] **Step 4: Confirm ignored artifacts disappear from short status**

Run:

```bash
git status --short --ignored=no
```

Expected: untracked `output/`, `data/backups/`, and `agent-im-ui-snapshot.md` no longer appear. Existing source edits and untracked source docs may still appear.

---

## Task 2: Add Demo Release Readiness Status

**Files:**

- Create: `docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md`

- [ ] **Step 1: Create status directory**

Run:

```bash
New-Item -ItemType Directory -Force -Path docs\superpowers\status
```

Expected: PowerShell prints a `docs\superpowers\status` directory entry or no error if it already exists.

- [ ] **Step 2: Create the initial readiness document**

Create `docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md` with this content:

```markdown
# AgentBridge v0.1.0-demo Readiness

## Status

Date: 2026-05-07

Release target: `v0.1.0-demo`

Branch: `ui-polish-agent-workbench`

Purpose: freeze the current local AgentBridge demo as a reproducible rollback baseline before product architecture refactors begin.

## Gate Results

| Gate | Command | Status | Notes |
| --- | --- | --- | --- |
| Unit tests | `npm run test` | PASS | 32 files, 212 tests passed during pre-freeze inspection. Re-run during final verification. |
| Production build | `npm run build` | PASS | TypeScript and Vite build passed during pre-freeze inspection. Re-run during final verification. |
| Local Agent eval | `npm run eval:agent` | PASS | 40/40 cases passed during pre-freeze inspection. Re-run during final verification. |
| Browser smoke | `npm run smoke:browser` | NOT RUN | Requires `npm run dev:full` to be running. Must pass before tagging. |
| Matrix/API smoke | `npm run infra:smoke` | NOT RUN | Optional for local demo; required for Matrix-enabled pilot. |
| Product readiness local demo | `npm run readiness:product -- --local-demo` | NOT RUN | Must pass before tagging. |

## Demo Data Snapshot

Current `data/agent-im-db.json` snapshot observed before release freeze:

| Collection | Count |
| --- | ---: |
| users | 4 |
| agents | 4 |
| rooms | 3 |
| messages | 47 |
| files | 25 |
| tasks | 5 |
| calendarEvents | 0 |
| actionLogs | 26 |
| actionRequests | 0 |
| a2aSessions | 0 |
| memories | 0 |

`data/agent-im-db.json` is runtime state. The release source of truth is the deterministic seed path through `npm run demo:prepare`.

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
```

- [ ] **Step 3: Verify the status document renders with no placeholders**

Run:

```bash
rg -n "待[定]|PLACEH[O]LDER|x[x]x|\\?\\?" docs\superpowers\status\2026-05-07-agentbridge-v0.1.0-demo-readiness.md
```

Expected: no matches and exit code `1`.

---

## Task 3: Stop Tracking Runtime JSON State

**Files:**

- Modify Git index: `data/agent-im-db.json`

- [ ] **Step 1: Confirm runtime state is tracked**

Run:

```bash
git ls-files data/agent-im-db.json
```

Expected output:

```text
data/agent-im-db.json
```

- [ ] **Step 2: Remove runtime JSON from the Git index only**

Run:

```bash
git rm --cached -- data/agent-im-db.json
```

Expected: Git stages deletion from the repository index, but the local file remains on disk.

- [ ] **Step 3: Verify local runtime file still exists**

Run:

```bash
Test-Path data\agent-im-db.json
```

Expected output:

```text
True
```

- [ ] **Step 4: Verify the runtime file is ignored after untracking**

Run:

```bash
git check-ignore data/agent-im-db.json
```

Expected output:

```text
data/agent-im-db.json
```

- [ ] **Step 5: Recreate demo state from seed**

Run:

```bash
npm run demo:prepare
```

Expected: command exits `0` and writes `data/agent-im-db.json` plus `data/media/*`.

- [ ] **Step 6: Verify seeded data has required collections**

Run:

```bash
node -e "const fs=require('fs'); const s=JSON.parse(fs.readFileSync('data/agent-im-db.json','utf8')); for (const k of ['users','agents','rooms','messages','files','tasks','actionLogs','actionRequests','a2aSessions','memories']) { if (!Array.isArray(s[k])) throw new Error(k+' missing'); console.log(k+': '+s[k].length); }"
```

Expected: each listed collection prints a numeric count and the command exits `0`.

---

## Task 4: Run the Local Demo Release Gate

**Files:**

- Read: `package.json`
- Read: `scripts/product-readiness.mjs`
- Runtime output: `tmp/agent-im-browser-smoke.png`

- [ ] **Step 1: Start API and web servers in a dedicated terminal**

Run:

```bash
npm run dev:full
```

Expected: API starts at `http://127.0.0.1:8791` and Vite starts at `http://127.0.0.1:5175`.

- [ ] **Step 2: Verify both servers are reachable from another terminal**

Run:

```bash
(Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:8791/api/state -TimeoutSec 10).StatusCode
(Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:5175 -TimeoutSec 10).StatusCode
```

Expected output:

```text
200
200
```

- [ ] **Step 3: Run local product readiness gate**

Run:

```bash
npm run readiness:product -- --local-demo
```

Expected:

- `unit tests` passes.
- `typecheck and build` passes.
- `local agent eval` passes.
- `browser smoke` passes.
- `real provider agent eval` is skipped for `--local-demo`.
- `Matrix and API smoke` is skipped for `--local-demo`.
- Process exits `0`.

- [ ] **Step 4: Update readiness status with actual gate result**

If Step 3 passes, update `docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md`:

Replace:

```markdown
| Browser smoke | `npm run smoke:browser` | NOT RUN | Requires `npm run dev:full` to be running. Must pass before tagging. |
| Product readiness local demo | `npm run readiness:product -- --local-demo` | NOT RUN | Must pass before tagging. |
```

With:

```markdown
| Browser smoke | `npm run smoke:browser` | PASS | Passed through `npm run readiness:product -- --local-demo` with API and web servers running. |
| Product readiness local demo | `npm run readiness:product -- --local-demo` | PASS | Local demo gate passed; real-provider eval and Matrix/API smoke intentionally skipped for demo release. |
```

- [ ] **Step 5: Stop only the dev servers started in Step 1**

Press `Ctrl+C` in the terminal running `npm run dev:full`.

Expected: API and Vite child processes exit.

---

## Task 5: Commit the Release Freeze

**Files:**

- Modify: `.gitignore`
- Create: `docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md`
- Modify Git index: `data/agent-im-db.json`
- Include existing completed source and plan files that are part of the current demo baseline.

- [ ] **Step 1: Review concise working tree status**

Run:

```bash
git status --short --ignored=no
```

Expected:

- Source files under `src/`, `scripts/`, `docs/`, `package.json`, `.gitignore`, and `package-lock.json` may appear.
- `output/`, `data/backups/`, `data/media/`, logs, screenshots, and `agent-im-ui-snapshot.md` do not appear.
- `data/agent-im-db.json` appears as staged or unstaged deletion from the index only.

- [ ] **Step 2: Stage release-relevant files with an explicit allowlist**

Run:

```bash
git add .gitignore package.json package-lock.json README.md scripts src docs/superpowers/specs docs/superpowers/plans docs/superpowers/status
git add -u data/agent-im-db.json
```

Expected: source and release docs are staged; generated artifacts remain unstaged/ignored.

- [ ] **Step 3: Review staged diff**

Run:

```bash
git diff --cached --stat
```

Expected:

- Includes `.gitignore`.
- Includes `docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md`.
- Includes current source, script, test, and plan files that make up the demo baseline.
- Does not include `output/`, `data/media/`, `data/backups/`, log files, or screenshot PNG files.

- [ ] **Step 4: Commit release freeze**

Run:

```bash
git commit -m "chore: freeze AgentBridge demo release"
```

Expected: commit succeeds and prints a new commit hash.

- [ ] **Step 5: Verify working tree after commit**

Run:

```bash
git status --short --ignored=no
```

Expected: either clean, or only intentionally ignored/local runtime files remain absent from the non-ignored status output.

---

## Task 6: Tag v0.1.0-demo

**Files:**

- Git tag metadata only.

- [ ] **Step 1: Confirm release commit passes local gate**

Run:

```bash
git log --oneline -1
```

Expected: latest commit subject is:

```text
chore: freeze AgentBridge demo release
```

- [ ] **Step 2: Create annotated tag**

Run:

```bash
git tag -a v0.1.0-demo -m "AgentBridge v0.1.0 demo release"
```

Expected: command exits `0`.

- [ ] **Step 3: Verify tag points at current commit**

Run:

```bash
git describe --tags --exact-match
```

Expected output:

```text
v0.1.0-demo
```

- [ ] **Step 4: Record tag in status document if a follow-up commit is desired**

This step is optional for the release tag itself. If the repository policy requires the status document to mention the tag, update `docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md` by adding this line under `Release target`:

```markdown
Git tag: `v0.1.0-demo`
```

Then run:

```bash
git add docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md
git commit -m "docs: record AgentBridge demo release tag"
git tag -f -a v0.1.0-demo -m "AgentBridge v0.1.0 demo release"
```

Expected: the tag is moved to the documentation follow-up commit. Use this only if you intentionally want the release tag to include the status-document tag line.

---

## Self-Review

### Spec Coverage

- Release freeze: covered by Tasks 1-6.
- Ignore generated artifacts: covered by Task 1.
- Release status document: covered by Task 2.
- Runtime JSON not treated as source: covered by Task 3.
- Local demo verification: covered by Task 4.
- Commit and tag rollback point: covered by Tasks 5-6.
- Product safety, database, AgentSession, worker, connector, and UI refactors are intentionally deferred to later phase plans.

### Placeholder Scan

This plan intentionally contains no placeholder names or vague implementation steps. Optional Step 6.4 is fully specified and can be skipped without blocking the release tag.

### Type and Command Consistency

- Package scripts match `package.json`: `demo:prepare`, `dev:full`, `readiness:product`.
- Status file path is consistent across all tasks.
- Tag name is consistently `v0.1.0-demo`.
- Runtime JSON path is consistently `data/agent-im-db.json`.
