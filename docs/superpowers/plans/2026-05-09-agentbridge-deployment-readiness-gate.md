# AgentBridge Deployment Readiness Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the controlled server pilot safer to upgrade by turning key deployment assumptions into automated readiness checks and correcting the server runbook for the current `main` release flow.

**Architecture:** Keep this slice small: extend the existing `scripts/product-readiness-runner.mjs` rather than introducing a new deploy system. The release gate should fail when audit EventLog readiness is missing or unhealthy, and it should verify that unauthenticated and query-token readiness access are rejected in product mode.

**Tech Stack:** Node.js ESM scripts, Vitest, existing `/api/readiness` product checks, Nginx/systemd runbook documentation.

---

## Scope

This plan covers deployment readiness guardrails only. It does not connect to the production server, change secrets, or migrate storage.

## Files

- Modify `scripts/product-readiness-runner.mjs`
  - Require `eventLog` in `/api/readiness`.
  - Add an authenticated deployment boundary check that rejects no-token and query-token readiness access.
- Modify `scripts/product-readiness-runner.test.mjs`
  - Cover the new `eventLog` requirement.
  - Cover auth boundary pass/fail behavior and local-demo skipping.
- Modify `docs/deployment/agentbridge-controlled-server-pilot.md`
  - Replace old branch references with `main`.
  - Document the safer release-directory update flow.
  - Make the JSON-store downtime limitation explicit.
- Modify `docs/superpowers/status/2026-05-07-agent-system-product-readiness.md`
  - Record the deployment readiness gate slice.

## Tasks

### Task 1: Require EventLog In Product Readiness

- [x] Add `eventLog` to `requiredReadinessChecks`.
- [x] Update all healthy readiness test payloads to include `eventLog`.
- [x] Run `npm run test -- scripts/product-readiness-runner.test.mjs`.

### Task 2: Add Auth Boundary Readiness Check

- [x] Add a default check named `readiness auth boundary`.
- [x] Make it run before the authenticated `/api/readiness` check.
- [x] In product mode, fetch `/api/readiness` without headers and expect `401` or `403`.
- [x] In product mode, fetch `/api/readiness?agent_im_token=<token>` without headers and expect `401` or `403`.
- [x] Skip the check in `--local-demo`, because local demo mode intentionally supports looser auth.
- [x] Sanitize token values from all failure messages.
- [x] Run `npm run test -- scripts/product-readiness-runner.test.mjs`.

### Task 3: Correct Deployment Runbook

- [x] Replace `ui-polish-agent-workbench` with `main`.
- [x] Update first deployment and update commands to use `git switch main` and `git pull --ff-only origin main`.
- [x] Add a release-directory procedure that builds in `/opt/agentbridge/releases/<sha>` before switching `/opt/agentbridge/current`.
- [x] Explicitly state that true zero-downtime writes require database-backed storage; the current JSON store supports controlled near-zero-downtime updates only with a short API restart window.
- [x] Keep rollback commands clear and non-destructive unless the operator has recorded the previous known-good SHA.

### Task 4: Status And Verification

- [x] Update product readiness status with the deployment gate slice.
- [x] Run `npm run test -- scripts/product-readiness-runner.test.mjs`.
- [x] Run `npm run test -- --reporter=verbose`.
- [x] Run `npm run build`.
- [ ] Commit the slice.

Verification note: after the final transport-error redaction hardening, `node --check` and a direct Node behavior probe passed. A subsequent focused Vitest rerun was blocked by the known Windows sandbox `spawn EPERM`; the elevated retry approval timed out twice.

## Acceptance Criteria

- `npm run readiness:product` fails if `/api/readiness` omits `eventLog`.
- `npm run readiness:product` fails if no-token readiness access succeeds.
- `npm run readiness:product` fails if query-token readiness access succeeds.
- `npm run readiness:product -- --local-demo` still skips product-only checks.
- The deployment runbook points at `main` and describes a safer upgrade/rollback path.
