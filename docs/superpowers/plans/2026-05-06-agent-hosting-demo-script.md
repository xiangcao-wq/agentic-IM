# Agent Hosting Demo Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved “林雯离线后的 30 分钟” scripted demo as deterministic, state-backed interactions with real file handoff, A2A negotiation, confirmation queue updates, and a visible safety block.

**Architecture:** Add a small scripted-demo layer on top of the existing runtime instead of replacing the Agent engine. Seed data supplies the stronger schedule conflict and downloadable screenshot asset; a server-side script runner injects fixed human/Agent turns into real `messages`, `a2aSessions`, `actionRequests`, and `actionLogs`; the React UI exposes compact demo controls and renders A2A checks as human-readable tables with technical details folded below.

**Tech Stack:** TypeScript, React, Vite, Node HTTP server, JSON state store, Vitest, existing Agent IM domain/runtime modules.

---

## File Structure

- Modify `src/domain/types.ts`: add optional `endsAt` to `CalendarItem` so 19:30-20:45 can be represented.
- Modify `src/domain/demoState.ts`: update the base scenario date/time conflict, add the screenshot metadata, and align task/calendar copy with the script.
- Modify `src/server/demoAssets.ts`: add a downloadable runtime asset named `访谈流程截图-服务入口分散.png`.
- Modify `scripts/prepare-demo-db.mjs`: ensure the prepared runtime DB maps that asset onto the fixed `file-interview-flow-screenshot` id with real bytes and a `localPath`.
- Create `src/server/demoScriptRuntime.ts`: deterministic script runner for four human turns and their state-backed Agent effects.
- Create `src/server/demoScriptRuntime.test.ts`: tests for script turns, file handoff, safety block, and calendar confirmation request.
- Modify `src/server/appServer.ts`: add `/api/demo/script/turn` endpoint and use existing state publish/write flow.
- Modify `src/client/apiClient.ts` and `src/client/apiClient.test.ts`: expose `runDemoScriptTurn`.
- Modify `src/App.tsx`: add demo turn controls, update quick prompts, and render readable A2A check tables.
- Modify `src/App.test.tsx`: assert demo controls and A2A checks render without reintroducing noisy panels.
- Modify `src/styles.css`: style demo turn controls and check tables.
- Modify `scripts/record-demo-video.mjs`: update the recording flow to follow the approved 3-minute script.

## Task 1: Seed The Stronger Story State

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/demoState.ts`
- Modify: `src/server/demoAssets.ts`
- Modify: `scripts/prepare-demo-db.mjs`
- Test: `src/domain/demoState.test.ts`
- Test: `src/server/demoAssets.test.ts`
- Test: `src/server/demoAssets.test.ts` and `npm run demo:prepare` output/state checks

- [ ] **Step 1: Write the failing demo state test**

Add these assertions to `src/domain/demoState.test.ts` inside the existing scenario test:

```ts
const linFocus = state.calendar.find((item) => item.id === 'cal-lin-focus-block');
expect(linFocus).toMatchObject({
  title: '林雯演示稿更新专注时间',
  startsAt: '2026-05-06T19:30:00+08:00',
  endsAt: '2026-05-06T20:45:00+08:00',
  attendees: ['user-lin']
});

expect(state.calendar.find((item) => item.id === 'cal-review')).toMatchObject({
  title: '第 4 组最后一次合稿检查',
  startsAt: '2026-05-06T20:30:00+08:00',
  endsAt: '2026-05-06T21:00:00+08:00',
  attendees: ['user-lin', 'user-chen', 'user-zhao']
});

expect(state.files.find((file) => file.id === 'file-interview-flow-screenshot')).toMatchObject({
  name: '访谈流程截图-服务入口分散.png',
  uploaderId: 'user-lin',
  roomId: 'room-team',
  visibility: 'room',
  agentCanShare: true,
  contentType: 'image/png'
});

expect(state.files.find((file) => file.id === 'file-private-notes')).toMatchObject({
  visibility: 'owner',
  agentCanShare: false
});
```

- [ ] **Step 2: Run the focused failing test**

Run: `npm run test -- src/domain/demoState.test.ts`

Expected: FAIL because `CalendarItem` has no `endsAt`, `cal-review` is still on the old date, and the screenshot file is missing from the base state.

- [ ] **Step 3: Add the optional calendar end time type**

In `src/domain/types.ts`, change `CalendarItem` to:

```ts
export interface CalendarItem {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  roomId: string;
  attendees: string[];
  sourceTaskId: string;
}
```

- [ ] **Step 4: Update the base seed state**

In `src/domain/demoState.ts`, update `cal-lin-focus-block`, `cal-review`, and add the screenshot file before `file-private-notes`:

```ts
{
  id: 'file-interview-flow-screenshot',
  name: '访谈流程截图-服务入口分散.png',
  uploaderId: 'user-lin',
  version: 1,
  roomId: 'room-team',
  updatedAt: '2026-05-04T16:05:00+08:00',
  visibility: 'room',
  agentCanShare: true,
  tags: ['访谈', '流程截图', '服务入口分散', '证据图', '图片'],
  summary: '林雯上传的访谈流程截图，用于报告“服务入口分散”段落的证据图；陈晨可能需要 Agent 定位准确版本并重新发到群聊。',
  contentType: 'image/png',
  size: 0
}
```

Use these calendar objects:

```ts
{
  id: 'cal-lin-focus-block',
  title: '林雯演示稿更新专注时间',
  startsAt: '2026-05-06T19:30:00+08:00',
  endsAt: '2026-05-06T20:45:00+08:00',
  roomId: 'room-team',
  attendees: ['user-lin'],
  sourceTaskId: 'task-slides'
},
{
  id: 'cal-review',
  title: '第 4 组最后一次合稿检查',
  startsAt: '2026-05-06T20:30:00+08:00',
  endsAt: '2026-05-06T21:00:00+08:00',
  roomId: 'room-team',
  attendees: ['user-lin', 'user-chen', 'user-zhao'],
  sourceTaskId: 'task-check'
}
```

- [ ] **Step 5: Add the downloadable runtime asset**

In `src/server/demoAssets.ts`, add this `binaryAsset` near the other Image-2 PNG assets in `createRuntimeDemoAssets()`:

```ts
binaryAsset(
  '访谈流程截图-服务入口分散.png',
  'image/png',
  'Downloadable interview flow screenshot for the service-entry-fragmentation evidence section.',
  ['访谈', '流程截图', '服务入口分散', '证据图', 'image-2', 'png', 'ai-seed']
)
```

Add a fallback mapping in `readWorkspaceAsset` so the Chinese asset name reuses the existing workspace PNG:

```ts
const assetName = name === '访谈流程截图-服务入口分散.png'
  ? 'image2-campus-service-research-board.png'
  : name;
const filePath = join(process.cwd(), 'data', 'demo-assets', assetName);
```

Update `scripts/prepare-demo-db.mjs` so this runtime asset reuses the fixed seed file id instead of a generated Chinese-name slug:

```js
function runtimeAssetFileId(assetName) {
  if (assetName === '访谈流程截图-服务入口分散.png') {
    return 'file-interview-flow-screenshot';
  }
  return `file-demo-runtime-${safeId(assetName)}`;
}
```

Use `const fileId = runtimeAssetFileId(asset.name);` in the asset loop. Keep writing a real `localPath` and replacing any existing file with the same id so the generated DB contains `size > 0` and `localPath`.

- [ ] **Step 6: Update demo asset tests**

In `src/server/demoAssets.test.ts`, add:

```ts
const runtimeAssets = createRuntimeDemoAssets();
const screenshot = runtimeAssets.find((asset) => asset.name === '访谈流程截图-服务入口分散.png');
expect(screenshot).toBeTruthy();
expect(screenshot?.contentType).toBe('image/png');
expect(screenshot?.bytes.byteLength).toBeGreaterThan(0);
expect(screenshot?.tags).toEqual(expect.arrayContaining(['服务入口分散', '证据图']));
```

Add a prepare-state verification by running `npm run demo:prepare` in the task and checking the generated `data/agent-im-db.json` contains:

```ts
const screenshot = state.files.find((file) => file.id === 'file-interview-flow-screenshot');
expect(screenshot?.name).toBe('访谈流程截图-服务入口分散.png');
expect(screenshot?.size).toBeGreaterThan(0);
expect(screenshot?.localPath ?? screenshot?.mxcUri).toBeTruthy();
```

- [ ] **Step 7: Run tests**

Run: `npm run test -- src/domain/demoState.test.ts src/server/demoAssets.test.ts`

Run: `npm run demo:prepare`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/domain/types.ts src/domain/demoState.ts src/domain/demoState.test.ts src/server/demoAssets.ts src/server/demoAssets.test.ts scripts/prepare-demo-db.mjs
git commit -m "feat: seed agent hosting demo story"
```

## Task 2: Add Deterministic Script Runtime

**Files:**
- Create: `src/server/demoScriptRuntime.ts`
- Test: `src/server/demoScriptRuntime.test.ts`

- [ ] **Step 1: Write the failing script runtime tests**

Create `src/server/demoScriptRuntime.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { DemoState } from '../domain/types';
import { runDemoScriptTurn } from './demoScriptRuntime';

function withDownloadableScreenshot(state: DemoState): DemoState {
  return {
    ...state,
    files: state.files.map((file) =>
      file.id === 'file-interview-flow-screenshot'
        ? {
            ...file,
            localPath: 'file-demo-runtime-interview-flow.png',
            size: 4096
          }
        : file
    )
  };
}

describe('demo script runtime', () => {
  it('runs the Zhao conflict turn with a natural Agent response', async () => {
    const result = await runDemoScriptTurn(createDemoState(), { turnId: 'zhao-conflict-request' });

    expect(result.messages.map((message) => message.body)).toEqual([
      '@林雯 今晚能不能 20:30 做最后一次合稿检查？陈晨说她找不到那张“服务入口分散”截图的准确版本，你那边能不能顺手发一下？',
      '我代表林雯回应：她 19:30 到 20:45 已锁定演示稿更新，20:30 与当前日程冲突。建议把合稿检查改到 21:20 到 21:50。截图请求我会单独检查授权；如果是本组可见且允许代发的文件，我可以先发给陈晨。'
    ]);
    expect(result.state.messages.at(-1)?.sourceAgentId).toBe('agent-lin');
  });

  it('runs the Chen screenshot handoff and records a completed A2A checklist', async () => {
    const result = await runDemoScriptTurn(withDownloadableScreenshot(createDemoState()), {
      turnId: 'chen-screenshot-request'
    });

    expect(result.messages.some((message) => message.fileId === 'file-interview-flow-screenshot')).toBe(true);
    expect(result.sessions[0]).toMatchObject({
      roomId: 'room-team',
      initiatorAgentId: 'agent-chen',
      targetAgentIds: ['agent-lin'],
      status: 'completed',
      risk: { level: 'low' }
    });
    expect(result.sessions[0].turns.at(-1)?.message).toContain('风险等级 low，可以自动代发');
  });

  it('keeps script turns idempotent when a demo button is clicked twice', async () => {
    const first = await runDemoScriptTurn(withDownloadableScreenshot(createDemoState()), {
      turnId: 'chen-screenshot-request'
    });
    const second = await runDemoScriptTurn(first.state, { turnId: 'chen-screenshot-request' });

    expect(second.state.messages.filter((message) => message.fileId === 'file-interview-flow-screenshot')).toHaveLength(1);
    expect(second.state.a2aSessions.filter((session) => session.id === 'a2a-script-image')).toHaveLength(1);
  });

  it('blocks the private note request without queueing a confirmation', async () => {
    const result = await runDemoScriptTurn(createDemoState(), { turnId: 'chen-private-note-request' });

    expect(result.messages.at(-1)?.body).toBe('我不能代发这个文件。它是林雯个人可见备注，未授权 Agent 分享。需要林雯本人确认后才能处理。');
    expect(result.logs[0]).toMatchObject({
      agentId: 'agent-lin',
      status: 'blocked',
      risk: { level: 'high' }
    });
    expect(result.state.actionRequests).toHaveLength(0);
  });

  it('creates a calendar confirmation request for the 21:20 review time', async () => {
    const result = await runDemoScriptTurn(createDemoState(), { turnId: 'zhao-2120-confirmation' });

    expect(result.sessions[0]).toMatchObject({
      status: 'needs_confirmation',
      targetAgentIds: ['agent-lin', 'agent-chen']
    });
    const request = result.state.actionRequests.find((action) => result.sessions[0].proposedActionRequestIds.includes(action.id));
    expect(request).toMatchObject({
      kind: 'coordinate',
      status: 'needs_confirmation',
      requiresHuman: true,
      input: {
        calendarPatch: {
          itemId: 'cal-review',
          oldStartsAt: '2026-05-06T20:30:00+08:00',
          oldEndsAt: '2026-05-06T21:00:00+08:00',
          newStartsAt: '2026-05-06T21:20:00+08:00',
          newEndsAt: '2026-05-06T21:50:00+08:00'
        }
      }
    });
    expect(result.state.calendar.find((item) => item.id === 'cal-review')?.startsAt).toBe('2026-05-06T20:30:00+08:00');
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npm run test -- src/server/demoScriptRuntime.test.ts`

Expected: FAIL because `demoScriptRuntime.ts` does not exist.

- [ ] **Step 3: Implement the script runtime**

Create `src/server/demoScriptRuntime.ts` with these exports and helpers. Keep imports tight; do not leave unused `blockAgentAction`/`RiskAssessment` imports if the final implementation does not use them.

```ts
import { enqueueAgentAction, requireActionConfirmation } from '../domain/actionQueue';
import { sortMessagesChronologically } from '../domain/messages';
import type { A2ASession, AgentActionLog, AgentActionRequest, DemoState, Message } from '../domain/types';

export type DemoScriptTurnId =
  | 'zhao-conflict-request'
  | 'chen-screenshot-request'
  | 'chen-private-note-request'
  | 'zhao-2120-confirmation';

export interface DemoScriptTurnInput {
  turnId: DemoScriptTurnId;
}

export interface DemoScriptTurnResult {
  state: DemoState;
  messages: Message[];
  sessions: A2ASession[];
  actionRequests: AgentActionRequest[];
  logs: AgentActionLog[];
}

export const DEMO_SCRIPT_TURNS = new Set<DemoScriptTurnId>([
  'zhao-conflict-request',
  'chen-screenshot-request',
  'chen-private-note-request',
  'zhao-2120-confirmation'
]);

export function isDemoScriptTurnId(value: unknown): value is DemoScriptTurnId {
  return typeof value === 'string' && DEMO_SCRIPT_TURNS.has(value as DemoScriptTurnId);
}

export async function runDemoScriptTurn(state: DemoState, input: DemoScriptTurnInput): Promise<DemoScriptTurnResult> {
  switch (input.turnId) {
    case 'zhao-conflict-request':
      return appendScriptMessages(state, [
        userMessage(state, 'msg-script-zhao-conflict', 'user-zhao', '@林雯 今晚能不能 20:30 做最后一次合稿检查？陈晨说她找不到那张“服务入口分散”截图的准确版本，你那边能不能顺手发一下？'),
        agentMessage(state, 'msg-script-lin-conflict-reply', 'agent-lin', '我代表林雯回应：她 19:30 到 20:45 已锁定演示稿更新，20:30 与当前日程冲突。建议把合稿检查改到 21:20 到 21:50。截图请求我会单独检查授权；如果是本组可见且允许代发的文件，我可以先发给陈晨。')
      ]);
    case 'chen-screenshot-request':
      return runScreenshotHandoff(state);
    case 'chen-private-note-request':
      return runPrivateNoteBlock(state);
    case 'zhao-2120-confirmation':
      return runScheduleConfirmation(state);
    default:
      const exhaustive: never = input.turnId;
      throw new Error(`unknown demo script turn: ${exhaustive}`);
  }
}
```

The implementation must:

- Use `userMessage` for Zhao/Chen human messages with `senderId` matching the real user.
- Use `agentMessage` for Lin Agent text messages with `type: 'agent'`, `agentLabel: '林雯的 Agent'`, and `sourceAgentId: 'agent-lin'`.
- Use a file `Message` for `file-interview-flow-screenshot` with `type: 'file'`, `agentLabel: '林雯的 Agent 代发'`, and the file metadata from state.
- Create a completed screenshot A2A session with two turns and context IDs `['file-interview-flow-screenshot']`.
- Create a blocked private-note `AgentActionLog` with `risk.level='high'`, `toolCalls=['file.search', 'risk.gate', 'file.share.blocked']`, and no `actionRequests`.
- Create a `coordinate` action request by calling `enqueueAgentAction` and `requireActionConfirmation`, then create a `needs_confirmation` A2A session whose `proposedActionRequestIds` contains that action id.
- Make every fixed-id turn idempotent. If a message/session/log/action request id already exists, do not append another copy. Repeated demo button clicks should return empty additions or the existing turn outputs without duplicating React keys or confirmation queue entries.
- The 21:20 calendar patch must include `oldEndsAt` and `newEndsAt` as well as starts: `20:30-21:00` -> `21:20-21:50`.

- [ ] **Step 4: Run the script runtime tests**

Run: `npm run test -- src/server/demoScriptRuntime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/demoScriptRuntime.ts src/server/demoScriptRuntime.test.ts
git commit -m "feat: add deterministic demo script runtime"
```

## Task 3: Expose Script Turns Through The API Client

**Files:**
- Modify: `src/server/appServer.ts`
- Modify: `src/client/apiClient.ts`
- Test: `src/server/appServer.test.ts`
- Test: `src/client/apiClient.test.ts`

- [ ] **Step 1: Write the API client test**

In `src/client/apiClient.test.ts`, add:

```ts
it('runs demo script turns', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ messages: [], sessions: [], actionRequests: [], logs: [] })
  });

  await runDemoScriptTurn('/api-root', { turnId: 'zhao-conflict-request' }, fetchMock);

  expect(fetchMock).toHaveBeenCalledWith(
    '/api-root/api/demo/script/turn',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ turnId: 'zhao-conflict-request' })
    })
  );
});
```

- [ ] **Step 2: Add the client function**

In `src/client/apiClient.ts`, import the script turn id type or define the input locally:

```ts
export interface DemoScriptTurnInput {
  turnId: 'zhao-conflict-request' | 'chen-screenshot-request' | 'chen-private-note-request' | 'zhao-2120-confirmation';
}

export function runDemoScriptTurn(
  baseUrl: string,
  input: DemoScriptTurnInput,
  fetcher: Fetcher = fetch
): Promise<{
  messages: Message[];
  sessions: DemoState['a2aSessions'];
  actionRequests: AgentActionRequest[];
  logs: AgentActionLog[];
}> {
  return requestJson(fetcher, endpoint(baseUrl, '/api/demo/script/turn'), post(input));
}
```

- [ ] **Step 3: Write the server endpoint test**

In `src/server/appServer.test.ts`, add a test matching the local server helper style already used in that file:

```ts
it('runs a deterministic demo script turn and persists state', async () => {
  const harness = await createTestServer();
  try {
    const response = await harness.fetch('/api/demo/script/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnId: 'zhao-conflict-request' })
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.messages.map((message: { body: string }) => message.body).join('\n')).toContain('20:30 与当前日程冲突');

    const state = await harness.store.read();
    expect(state.messages.some((message) => message.id === 'msg-script-lin-conflict-reply')).toBe(true);
  } finally {
    await harness.close();
  }
});

it('rejects invalid demo script turn ids', async () => {
  const harness = await createTestServer();
  try {
    const response = await harness.fetch('/api/demo/script/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnId: 'bad-turn' })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'Invalid demo script turnId' });
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 4: Add the endpoint**

In `src/server/appServer.ts`, import `runDemoScriptTurn`, `isDemoScriptTurnId`, and `type DemoScriptTurnResult`; add this route before the file upload routes:

```ts
if (request.method === 'POST' && url.pathname === '/api/demo/script/turn') {
  const body = await readJson<{ turnId?: unknown }>(request);
  if (!isDemoScriptTurnId(body.turnId)) {
    return sendJson(response, { error: 'Invalid demo script turnId' }, 400);
  }
  const turnId = body.turnId;

  let scripted: DemoScriptTurnResult | undefined;
  await updateStoredState(async (currentState) => {
    scripted = await runDemoScriptTurn(currentState, { turnId });
    return scripted.state;
  });

  if (!scripted) {
    return sendJson(response, { error: 'Script turn failed' }, 500);
  }

  await publishRuntimeState();
  return sendJson(response, {
    messages: scripted.messages,
    sessions: scripted.sessions,
    actionRequests: scripted.actionRequests,
    logs: scripted.logs
  });
}
```

Do not use the return value of `updateStoredState` as the script result; in this server it returns the new `DemoState`, not the per-turn payload.

- [ ] **Step 5: Run API tests**

Run: `npm run test -- src/client/apiClient.test.ts src/server/appServer.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/appServer.ts src/server/appServer.test.ts src/client/apiClient.ts src/client/apiClient.test.ts
git commit -m "feat: expose demo script turn API"
```

## Task 4: Add Demo Controls And Readable A2A Check Tables

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Write the UI tests**

In `src/App.test.tsx`, add:

```ts
it('renders compact demo script controls for the approved story', async () => {
  await act(async () => {
    root.render(<App />);
  });

  expect(host.textContent).toContain('剧本推进');
  expect(host.textContent).toContain('赵一鸣：20:30 + 找截图');
  expect(host.textContent).toContain('陈晨：找截图');
  expect(host.textContent).toContain('陈晨：请求私人备注');
  expect(host.textContent).toContain('赵一鸣：21:20 确认');
});

it('runs a demo script turn from the UI', async () => {
  const initial = createDemoState();
  const updated = {
    ...initial,
    messages: [
      ...initial.messages,
      {
        id: 'msg-script-lin-conflict-reply',
        roomId: 'room-team',
        senderId: 'user-lin',
        senderName: '林雯的 Agent',
        body: '我代表林雯回应：她 19:30 到 20:45 已锁定演示稿更新，20:30 与当前日程冲突。',
        sentAt: '2026-05-06T19:41:00+08:00',
        type: 'agent',
        agentLabel: '林雯的 Agent',
        sourceAgentId: 'agent-lin'
      }
    ]
  };
  apiMocks.fetchState.mockResolvedValueOnce(initial).mockResolvedValueOnce(updated);
  apiMocks.runDemoScriptTurn.mockResolvedValue({
    messages: updated.messages.slice(-1),
    sessions: [],
    actionRequests: [],
    logs: []
  });

  await act(async () => {
    root.render(<App />);
  });

  const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('赵一鸣：20:30'));
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  expect(apiMocks.runDemoScriptTurn).toHaveBeenCalledWith('', { turnId: 'zhao-conflict-request' });
  expect(host.textContent).toContain('20:30 与当前日程冲突');
});

it('renders readable A2A checks before technical details', async () => {
  const state = createDemoState();
  state.a2aSessions = [
    {
      id: 'a2a-script-image',
      roomId: 'room-team',
      initiatorAgentId: 'agent-chen',
      targetAgentIds: ['agent-lin'],
      goal: '定位并重新发送访谈流程截图',
      status: 'completed',
      turns: [],
      proposedActionRequestIds: [],
      contextIds: ['file-interview-flow-screenshot'],
      risk: { level: 'low', score: 0.18, reason: 'Authorized screenshot handoff.', model: 'demo-script-v1' },
      createdAt: '2026-05-06T19:42:00+08:00',
      updatedAt: '2026-05-06T19:42:00+08:00'
    }
  ];
  apiMocks.fetchState.mockResolvedValue(state);

  await act(async () => {
    root.render(<App />);
  });

  expect(host.textContent).toContain('请求者是否同组');
  expect(host.textContent).toContain('是否定位到准确版本');
  expect(host.textContent).toContain('技术详情');
  expect(host.textContent.indexOf('请求者是否同组')).toBeLessThan(host.textContent.indexOf('技术详情'));
});
```

- [ ] **Step 2: Import and mock the client function**

In `src/App.test.tsx`, add `runDemoScriptTurn: vi.fn()` to `apiMocks` and ensure `vi.mock('./client/apiClient', () => apiMocks);` exposes it.

In `src/App.tsx`, import both the function and its input type:

```ts
import { runDemoScriptTurn, type DemoScriptTurnInput } from './client/apiClient';
```

- [ ] **Step 3: Wire the controls**

Add this handler in `App`:

```ts
async function handleRunDemoScriptTurn(turnId: DemoScriptTurnInput['turnId']) {
  await runAction(`demo-script-${turnId}`, async () => {
    const response = await runDemoScriptTurn(apiBaseUrl, { turnId });
    if (response.messages.length > 0) {
      setAgentResult({ kind: 'human-reply', value: response.messages.at(-1)! });
    }
    return response;
  });
}
```

Pass `onRunDemoScriptTurn={handleRunDemoScriptTurn}` into `ChatPanel`.

Add a compact control row above `.message-list` in `ChatPanel`:

```tsx
<div className="demo-script-bar" aria-label="demo script controls">
  <span>剧本推进</span>
  <button type="button" onClick={() => props.onRunDemoScriptTurn('zhao-conflict-request')} disabled={Boolean(props.busyAction)}>
    赵一鸣：20:30 + 找截图
  </button>
  <button type="button" onClick={() => props.onRunDemoScriptTurn('chen-screenshot-request')} disabled={Boolean(props.busyAction)}>
    陈晨：找截图
  </button>
  <button type="button" onClick={() => props.onRunDemoScriptTurn('chen-private-note-request')} disabled={Boolean(props.busyAction)}>
    陈晨：请求私人备注
  </button>
  <button type="button" onClick={() => props.onRunDemoScriptTurn('zhao-2120-confirmation')} disabled={Boolean(props.busyAction)}>
    赵一鸣：21:20 确认
  </button>
</div>
```

- [ ] **Step 4: Render readable A2A checks**

Add helpers in `src/App.tsx`:

```ts
function a2aDisplayChecks(session: DemoState['a2aSessions'][number]): Array<{ label: string; result: string }> {
  if (session.contextIds.includes('file-interview-flow-screenshot')) {
    return [
      { label: '请求者是否同组', result: '通过' },
      { label: '是否定位到准确版本', result: '通过' },
      { label: '文件是否本组可见', result: '通过' },
      { label: '是否允许 Agent 代发', result: '通过' },
      { label: '是否存在真实图片', result: '通过' },
      { label: '风险等级', result: '低' },
      { label: '处理结果', result: '自动代发' }
    ];
  }
  if (session.proposedActionRequestIds.length > 0) {
    return [
      { label: '林雯 20:30 是否可用', result: '冲突，19:30-20:45 已锁定' },
      { label: '林雯 21:20 是否可用', result: '通过' },
      { label: '陈晨 21:20 是否可用', result: '通过' },
      { label: '是否影响多人日程', result: '是' },
      { label: '风险等级', result: '中' },
      { label: '处理结果', result: '进入确认队列' }
    ];
  }
  return [];
}
```

Render the checks inside each `.a2a-row` before the latest-turn text:

```tsx
const checks = a2aDisplayChecks(session);
{checks.length > 0 ? (
  <dl className="a2a-check-grid">
    {checks.map((check) => (
      <div key={check.label}>
        <dt>{check.label}</dt>
        <dd>{check.result}</dd>
      </div>
    ))}
  </dl>
) : null}
<details className="a2a-technical-details">
  <summary>技术详情</summary>
  {latestTurn ? <small>{latestTurn.message}</small> : null}
</details>
```

- [ ] **Step 5: Style the controls and check table**

Add to `src/styles.css`:

```css
.demo-script-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px 24px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}

.demo-script-bar span {
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}

.demo-script-bar button {
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text);
  font-size: 12px;
}

.a2a-check-grid {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 10px;
  margin: 8px 0;
}

.a2a-check-grid div {
  display: contents;
}

.a2a-check-grid dt,
.a2a-check-grid dd {
  margin: 0;
  font-size: 12px;
}

.a2a-check-grid dt {
  color: var(--muted);
}

.a2a-check-grid dd {
  color: var(--text);
  font-weight: 700;
}

.a2a-technical-details summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 12px;
}
```

- [ ] **Step 6: Run UI tests**

Run: `npm run test -- src/App.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/App.test.tsx src/styles.css
git commit -m "feat: add scripted demo controls"
```

## Task 5: Align Quick Actions And Runtime Edge Cases

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/domain/agentEngine.ts`
- Modify: `src/server/agentRuntime.ts`
- Modify: `src/server/agentRunRuntime.ts`
- Modify: `src/server/agentAutopilotRuntime.ts`
- Test: `src/server/agentRuntime.test.ts`
- Test: `src/server/agentAutopilotRuntime.test.ts`

- [ ] **Step 1: Write file-share runtime tests**

In `src/server/agentRuntime.test.ts`, add:

```ts
it('shares the interview screenshot when Chen asks for the exact evidence image', async () => {
  const baseState = createDemoState();
  const state = {
    ...baseState,
    files: baseState.files.map((file) =>
      file.id === 'file-interview-flow-screenshot'
        ? { ...file, localPath: 'file-demo-runtime-interview-flow.png', size: 4096 }
        : file
    )
  };

  const result = await runFileShareAction(state, {
    agentId: 'agent-lin',
    roomId: 'room-team',
    requesterId: 'user-chen',
    requestText: '我找不到服务入口分散截图的准确版本，能不能发一下？'
  });

  expect(result.result.status).toBe('executed');
  expect(result.result.file?.id).toBe('file-interview-flow-screenshot');
  expect(result.result.message?.body).toContain('访谈流程截图-服务入口分散.png');
});

it('blocks owner-only private notes instead of asking for confirmation', async () => {
  const result = await runFileShareAction(createDemoState(), {
    agentId: 'agent-lin',
    roomId: 'room-team',
    requesterId: 'user-chen',
    requestText: '林雯个人答辩备注也能发我吗？'
  });

  expect(result.result.status).toBe('blocked');
  expect(result.result.requiresHuman).toBe(false);
  expect(result.actionRequest.status).toBe('blocked');
  expect(result.result.risk.level).toBe('high');
});
```

Add a schedule parsing assertion in the existing coordinate/runtime test style:

```ts
expect(request?.input.calendarPatch).toMatchObject({
  itemId: 'cal-review',
  oldStartsAt: '2026-05-06T20:30:00+08:00',
  oldEndsAt: '2026-05-06T21:00:00+08:00',
  newStartsAt: '2026-05-06T21:20:00+08:00',
  newEndsAt: '2026-05-06T21:50:00+08:00'
});
```

Cover the ambiguous-time phrase explicitly: `把 20:30 改到 21:20` must resolve to `21:20`, not the first time in the sentence.

- [ ] **Step 2: Update quick prompts**

In `src/App.tsx`, replace the prompt constants:

```ts
const quickFindFilePrompt = '定位“服务入口分散”访谈流程截图的准确版本，并列出它是否允许 Agent 代发。';
const defaultFileSharePrompt = '陈晨找不到“服务入口分散”截图的准确版本，请定位最新版并发到当前群聊。';
const defaultCoordinatePrompt = '那就 21:20 到 21:50。两个 Agent 先帮忙确认下时间，最后让林雯点确认就行。';
```

- [ ] **Step 3: Make private-note requests blocked**

In `src/domain/agentEngine.ts`, update `FileShareAction` creation so owner-only matches return `blocked`.

Add helper:

```ts
function findSensitiveBlockedFile(state: DemoState, ownerId: string, roomId: string, requestText: string): FileItem | undefined {
  const terms = buildFileSearchTerms(requestText);
  return state.files.find((file) => {
    if (file.uploaderId !== ownerId || file.roomId !== roomId) {
      return false;
    }
    if (file.visibility === 'room' && file.agentCanShare) {
      return false;
    }
    return scoreFileAgainstRequest(file, terms) > 0 || requestText.includes('个人答辩备注');
  });
}
```

In `createFileShareActionFallback`, before `assessFileShareRisk`, block sensitive files even if the normal matcher already selected one. Extract a helper so the branch is reused:

```ts
function blockFileShare(blockedFile: FileItem): FileShareAction {
  const risk: RiskAssessment = {
    level: 'high',
    score: 0.93,
    reason: '请求命中林雯个人可见备注，visibility=owner 且 agentCanShare=false，Agent 不会代发。',
    model: lowRiskModel
  };
  const log = createActionLog({
    agentId: agent.id,
    roomId: input.roomId,
    action: `阻断文件代发：${blockedFile.name}`,
    status: 'blocked',
    risk,
    contextIds: [blockedFile.id],
    toolCalls: ['room_search', 'file_library.lookup_latest', 'risk.gate', 'file.share.blocked']
  });
  return { status: 'blocked', requiresHuman: false, risk, file: blockedFile, log };
}

if (file && (file.visibility !== 'room' || !file.agentCanShare)) {
  return blockFileShare(file);
}

const blockedFile = findSensitiveBlockedFile(state, agent.ownerId, input.roomId, input.requestText);
if (blockedFile) {
  return blockFileShare(blockedFile);
}
```

In `src/server/agentRuntime.ts`, import `blockAgentAction` and handle `result.status === 'blocked'`:

```ts
if (result.status === 'blocked') {
  const blocked = blockAgentAction(withLog, queued.request.id, {
    logId: result.log.id,
    risk: result.risk,
    updatedAt: result.log.createdAt
  });
  return {
    state: blocked.state,
    result,
    actionRequest: blocked.request
  };
}
```

- [ ] **Step 4: Improve 21:20 schedule parsing**

In `src/server/agentRunRuntime.ts`, expand calendar patch inference from start-only to start/end-aware:

```ts
function replaceTime(iso: string, hour: string, minute: string): string {
  return iso.replace(/T\d{2}:\d{2}:/, `T${hour.padStart(2, '0')}:${minute}:`);
}

const range = text.match(/(\d{1,2})[:：](\d{2})\s*(?:到|-|—|~)\s*(\d{1,2})[:：](\d{2})/);
if (range) {
  return {
    startsAt: replaceTime(oldStartsAt, range[1], range[2]),
    endsAt: replaceTime(oldEndsAt ?? oldStartsAt, range[3], range[4])
  };
}

const changeTo = text.match(/(?:改到|调整到|改成|挪到)\s*(\d{1,2})[:：](\d{2})/);
if (changeTo) {
  return {
    startsAt: replaceTime(oldStartsAt, changeTo[1], changeTo[2])
  };
}

const explicitTime = text.match(/(\d{1,2})[:：](\d{2})/);
if (explicitTime && !text.match(/(?:改到|调整到|改成|挪到)/)) {
  return {
    startsAt: replaceTime(oldStartsAt, explicitTime[1], explicitTime[2])
  };
}
```

Place the `range` and `changeTo` checks before broader weekday/day inference so `把 20:30 改到 21:20` picks `21:20`, not `20:30`.

Update `createCalendarPatch` to include:

```ts
{
  itemId: item.id,
  title: item.title,
  oldStartsAt: item.startsAt,
  oldEndsAt: item.endsAt,
  newStartsAt: inferred.startsAt,
  newEndsAt: inferred.endsAt ?? inferShiftedEnd(item, inferred.startsAt)
}
```

`inferShiftedEnd` should preserve the old event duration when no explicit end is provided. For `20:30-21:00` moved to `21:20`, it should produce `21:50`.

- [ ] **Step 5: Make schedule conflict detection use `endsAt`**

In `src/server/agentAutopilotRuntime.ts`, change `buildScheduleConstraint` conflict detection:

```ts
interface CalendarPatch {
  itemId: string;
  oldStartsAt: string;
  oldEndsAt?: string;
  newStartsAt: string;
  newEndsAt?: string;
  title: string;
}

const proposedStart = Date.parse(patch.newStartsAt);
const proposedEnd = Date.parse(patch.newEndsAt ?? patch.newStartsAt);
const conflict = state.calendar.find((item) => {
  if (item.id === patch.itemId) {
    return false;
  }
  if (!item.attendees.includes(ownerId)) {
    return false;
  }
  const startsAt = Date.parse(item.startsAt);
  const endsAt = Date.parse(item.endsAt ?? item.startsAt);
  return Number.isFinite(proposedStart) &&
    Number.isFinite(proposedEnd) &&
    Number.isFinite(startsAt) &&
    Number.isFinite(endsAt) &&
    proposedStart < endsAt &&
    proposedEnd > startsAt;
});
```

Update `parseCalendarPatch` to preserve optional `oldEndsAt` and `newEndsAt`.

- [ ] **Step 6: Run runtime tests**

Run: `npm run test -- src/server/agentRuntime.test.ts src/server/agentAutopilotRuntime.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/domain/agentEngine.ts src/server/agentRuntime.ts src/server/agentRunRuntime.ts src/server/agentAutopilotRuntime.ts src/server/agentRuntime.test.ts src/server/agentAutopilotRuntime.test.ts
git commit -m "feat: align agent runtime with demo script"
```

## Task 6: Update Recording And Smoke Coverage

**Files:**
- Modify: `scripts/record-demo-video.mjs`
- Modify: `scripts/browser-smoke.mjs`

- [ ] **Step 1: Update the recording script sequence**

In `scripts/record-demo-video.mjs`, replace the manual `postJson('/api/messages', ...)` story beats with script turns:

```js
await postJson(`${apiBaseUrl}/api/demo/script/turn`, { turnId: 'zhao-conflict-request' });
await sleep(8_000);

await postJson(`${apiBaseUrl}/api/demo/script/turn`, { turnId: 'chen-screenshot-request' });
await sleep(12_000);

await postJson(`${apiBaseUrl}/api/demo/script/turn`, { turnId: 'chen-private-note-request' });
await sleep(8_000);

await postJson(`${apiBaseUrl}/api/demo/script/turn`, { turnId: 'zhao-2120-confirmation' });
await sleep(12_000);
```

Keep the existing approval and worker-run steps after the confirmation queue appears.

- [ ] **Step 2: Update smoke script assertions**

In `scripts/browser-smoke.mjs`, add checks for:

```js
await expectText(page, '剧本推进');
await expectText(page, '赵一鸣：20:30 + 找截图');
await clickText(page, '陈晨：找截图');
await expectText(page, '请求者是否同组');
await expectText(page, '技术详情');
```

Use the local helper style already present in that script. The A2A table assertions must run only after triggering `chen-screenshot-request`; otherwise a fresh page has no A2A session yet.

- [ ] **Step 3: Run browser-related checks**

Run: `npm run build`

Expected: PASS.

Run: `npm run smoke:browser`

Expected: PASS. If this fails because the local dev server is not running, start `npm run dev:full` in a separate terminal and rerun `npm run smoke:browser`.

- [ ] **Step 4: Commit**

```bash
git add scripts/record-demo-video.mjs scripts/browser-smoke.mjs
git commit -m "test: update demo script recording flow"
```

## Task 7: Final Verification

**Files:**
- No planned source edits.

- [ ] **Step 1: Run full test suite**

Run: `npm run test`

Expected: PASS.

- [ ] **Step 2: Run production build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 3: Prepare demo state**

Run: `npm run demo:prepare`

Expected: output JSON includes `"ok": true`, `files` greater than `0`, and the generated state includes `访谈流程截图-服务入口分散.png`.

- [ ] **Step 4: Manual demo rehearsal**

Run: `npm run dev:full`

Open the local URL printed by the script. Click the script controls in this order:

1. `开启托管`
2. `赵一鸣：20:30 + 找截图`
3. `陈晨：找截图`
4. `陈晨：请求私人备注`
5. `赵一鸣：21:20 确认`
6. `确认` on the calendar action
7. `立即巡检`
8. Ask Agent: `现在谁卡住了？下一步先做什么？`

Expected visible results:

- 20:30 conflict mentions `19:30 到 20:45`.
- Screenshot handoff sends `访谈流程截图-服务入口分散.png`.
- Private note request shows blocked/high-risk result.
- A2A panel shows check tables before technical details.
- Calendar confirmation updates `cal-review` to `2026-05-06T21:20:00+08:00` through `2026-05-06T21:50:00+08:00`.
- Worker creates a task update confirmation instead of mutating task state immediately.

- [ ] **Step 5: Final status check**

Run: `git status --short`

Expected: only intended working changes remain, or clean if all tasks were committed.

## Self-Review

Spec coverage:

- Strong 20:30 conflict is covered by Task 1 seed state and Task 5 conflict parsing.
- Room-visible file handoff rationale is covered by Task 1 screenshot asset, Task 2 scripted handoff, and Task 5 file selection.
- Human-readable A2A tables are covered by Task 4.
-托管巡检 continuity is covered by Task 6 smoke and Task 7 rehearsal; the existing worker remains the execution path.
- Private-note safety block is covered by Task 2 script runtime, Task 4 UI display, and Task 5 runtime edge case.
- Natural human lines are covered by Task 2 scripted turn constants and Task 4 controls.

Placeholder scan:

- This plan contains no placeholder markers or unspecified implementation steps.
- Every new file has a corresponding test.
- Every source-changing task has a command and expected result.

Type consistency:

- `DemoScriptTurnId` is used by server, client, and UI.
- `CalendarItem.endsAt` is optional, so existing calendar objects remain valid.
- `FileShareAction.status` already includes `blocked`; Task 5 aligns `runFileShareAction` with that status.
