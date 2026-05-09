# AgentBridge Server Inventory Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, repeatable way to inventory the existing server before upgrading it.

**Architecture:** Implement this as a read-only Node.js script under `scripts/` so it can run from the checked-out release on the server. The script must redact token-like environment values and report deployment facts, file paths, systemd status, git version, and readiness HTTP boundaries without mutating server state.

**Tech Stack:** Node.js ESM, Vitest, existing deployment runbook.

---

## Files

- Create `scripts/server-inventory.mjs`
  - Read `/etc/agentbridge/agentbridge.env` by default.
  - Redact token/key/secret/password/credential values.
  - Inspect git, runtime versions, systemd service state, deployment paths, and optional readiness probes.
- Create `scripts/server-inventory.test.mjs`
  - Test env parsing, redaction, path derivation, findings, and readiness token safety.
- Modify `package.json`
  - Add `inventory:server`.
- Modify `docs/deployment/agentbridge-controlled-server-pilot.md`
  - Add server inventory before upgrade instructions.
- Modify `docs/superpowers/status/2026-05-07-agent-system-product-readiness.md`
  - Record this operational readiness slice.

## Tasks

### Task 1: Build Read-Only Inventory Script

- [x] Add CLI options: `--host`, `--env-file`, `--json`, `--help`.
- [x] Parse env files with simple shell-style `KEY=value` and `export KEY=value`.
- [x] Summarize known deployment env vars without revealing secrets.
- [x] Derive state, EventLog, media, current, and releases paths.
- [x] Collect git, Node/npm, and systemd service facts.
- [x] Optionally probe `/api/readiness` no-token, query-token, and authenticated boundaries.

### Task 2: Add Tests

- [x] Cover env parsing.
- [x] Cover secret redaction and DeepSeek non-secret URL visibility.
- [x] Cover path derivation.
- [x] Cover finding generation for unsafe settings.
- [x] Cover readiness probe reports without token leakage.

### Task 3: Document Server Usage

- [x] Add `npm run inventory:server` to `package.json`.
- [x] Add runbook instructions for collecting and reviewing `/tmp/agentbridge-server-inventory.json`.
- [x] Add explicit review points for service status, symlink target, state/EventLog files, auth boundary, and findings.

### Task 4: Verification

- [x] Run focused inventory tests.
- [x] Run production build.
- [ ] Commit the slice.
