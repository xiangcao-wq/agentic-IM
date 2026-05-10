# Agent Console IA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cramped three-column IM layout with a two-column IM surface and a dedicated Agent Console for deeper Agent work.

**Architecture:** Keep the existing React/Vite single-page app and reuse the current Agent execution handlers. Add a local `workspaceMode` state that switches between `im` and `agent-console`, move low-frequency Agent controls into the console, and expose high-frequency Agent actions through the chat composer plus menu.

**Tech Stack:** React 19, TypeScript, Framer Motion, Vitest/jsdom, existing CSS modules in `src/styles.css`.

---

### Task 1: Lock the Navigation Contract

**Files:**
- Modify: `src/App.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Write failing tests**

Add tests that assert the default page is a two-column IM layout, the Agent workbench is not visible by default, the composer plus menu exposes high-frequency Agent actions, and a visible entry switches into the Agent Console.

- [ ] **Step 2: Verify red**

Run: `npm run test -- src/App.test.tsx`
Expected: FAIL because the current app still renders the Agent workbench in the main layout and has no composer Agent menu or console mode.

- [ ] **Step 3: Implement minimal UI state**

Add `workspaceMode: 'im' | 'agent-console'`, wire "进入 Agent 操作台" and "返回聊天", and conditionally render IM or console layouts without changing backend APIs.

- [ ] **Step 4: Verify green**

Run: `npm run test -- src/App.test.tsx`
Expected: PASS for the new navigation tests and existing tests.

### Task 2: Composer Agent Menu

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Modify: `src/App.test.tsx`

- [ ] **Step 1: Write failing tests**

Assert the plus button opens and closes a compact menu with "总结当前群聊", "问截止", "Agent 找文件", "Agent 写回复", and "进入 Agent 操作台".

- [ ] **Step 2: Implement menu**

Replace the upload-only composer left button with a plus button that toggles the menu. Keep upload as one item inside the menu and preserve current upload behavior.

- [ ] **Step 3: Verify**

Run: `npm run test -- src/App.test.tsx`
Expected: PASS.

### Task 3: Dedicated Agent Console Layout

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Modify: `src/App.test.tsx`

- [ ] **Step 1: Write failing tests**

Assert the console shows a room navigation rail, central operation desk, right runtime panel, pending confirmations, handled files, and an input for Agent commands.

- [ ] **Step 2: Implement console**

Reuse `Sidebar`, `ResultPanel`, `AgentTracePanel`, pending action rendering, A2A rendering, and autopilot controls, but compose them into a full-page console with left/middle/right columns.

- [ ] **Step 3: Verify**

Run: `npm run test -- src/App.test.tsx`
Expected: PASS.

### Task 4: Build And Browser Check

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Run type/build checks**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 2: Start local app and inspect**

Run: `npm run dev`
Expected: app is available at `http://127.0.0.1:5175/`.

- [ ] **Step 3: Browser verify**

Verify default IM, plus menu, Agent Console transition, and mobile layout have no obvious overlap.
