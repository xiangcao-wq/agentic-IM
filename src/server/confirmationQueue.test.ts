// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { DemoState } from '../domain/types';
import { createAppServer } from './appServer';

const servers: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('agent confirmation queue API', () => {
  it('lists and confirms queued Agent actions', async () => {
    const app = await startTestServer();
    const queued = await createHighRiskShareAction(app.url);
    const actions = await requestJson(`${app.url}/api/agent/actions`);
    const action = actions.actions.find((candidate: { id: string }) => candidate.id === queued.action.id);

    expect(action).toMatchObject({
      kind: 'share_file',
      status: 'needs_confirmation',
      requiresHuman: true
    });

    const confirmed = await requestJson(`${app.url}/api/agent/actions/${action.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: 'user-lin',
        reason: 'Human approved execution for demo review'
      })
    });

    expect(confirmed.action).toMatchObject({
      id: action.id,
      status: 'executed',
      requiresHuman: false,
      logId: confirmed.log.id
    });
    expect(confirmed.log).toMatchObject({
      agentId: action.agentId,
      roomId: action.roomId,
      action: `confirm_action:${action.id}`,
      status: 'executed'
    });
  });

  it('rejects queued Agent actions and records the reviewer reason', async () => {
    const app = await startTestServer();
    const queued = await createHighRiskShareAction(app.url);

    const rejected = await requestJson(`${app.url}/api/agent/actions/${queued.action.id}/reject`, {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: 'user-lin',
        reason: 'Requester identity is not trusted'
      })
    });

    expect(rejected.action).toMatchObject({
      id: queued.action.id,
      status: 'rejected',
      requiresHuman: false,
      logId: rejected.log.id
    });
    expect(rejected.log.action).toBe(`reject_action:${queued.action.id}`);
    expect(rejected.log.risk.reason).toContain('Requester identity is not trusted');

    const state = await requestJson(`${app.url}/api/state`);
    expect(
      state.actionRequests.some(
        (request: { id: string; status: string }) => request.id === queued.action.id && request.status === 'rejected'
      )
    ).toBe(true);
  });

  it('executes a queued file share after human confirmation', async () => {
    const app = await startTestServer(createStateWithMatrixBackedSlides());

    await requestJson(`${app.url}/api/agent/share-file`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        requesterId: 'user-chen',
        requestText: '请处理 pptx'
      })
    });
    const queued = await requestJson(`${app.url}/api/agent/actions`);
    const action = queued.actions.find(
      (candidate: { kind: string; status: string }) =>
        candidate.kind === 'share_file' && candidate.status === 'needs_confirmation'
    );
    expect(action).toBeTruthy();

    const confirmed = await requestJson(`${app.url}/api/agent/actions/${action.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: 'user-lin',
        reason: '用户确认可以代发这个文件'
      })
    });
    const state = await requestJson(`${app.url}/api/state`);

    expect(confirmed.action).toMatchObject({
      id: action.id,
      status: 'executed',
      requiresHuman: false
    });
    expect(state.messages.some((message: { fileId?: string; agentLabel?: string }) =>
      message.fileId === 'file-slides-v3' && message.agentLabel === '林雯的 Agent 代发'
    )).toBe(true);
    expect(state.actionLogs[0]).toMatchObject({
      action: `confirm_action:${action.id}`,
      status: 'executed'
    });
  });

  it('updates calendar data only after confirming a queued coordination action', async () => {
    const app = await startTestServer();

    const planned = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: 'Move the final review to Wednesday 23:00 and coordinate with Chen.'
      })
    });
    const beforeConfirm = await requestJson(`${app.url}/api/state`);

    expect(planned.actionRequest).toMatchObject({
      kind: 'coordinate',
      status: 'needs_confirmation'
    });
    expect(planned.actionRequest.input.calendarPatch).toMatchObject({
      itemId: 'cal-review',
      oldStartsAt: '2026-05-05T20:30:00+08:00',
      newStartsAt: '2026-05-06T23:00:00+08:00'
    });
    expect(beforeConfirm.calendar.find((item: { id: string }) => item.id === 'cal-review').startsAt).toBe(
      '2026-05-05T20:30:00+08:00'
    );

    const confirmed = await requestJson(`${app.url}/api/agent/actions/${planned.actionRequest.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: 'user-lin',
        reason: 'Human approved the new review time'
      })
    });
    const afterConfirm = await requestJson(`${app.url}/api/state`);

    expect(confirmed.action).toMatchObject({
      status: 'executed',
      requiresHuman: false
    });
    expect(afterConfirm.calendar.find((item: { id: string }) => item.id === 'cal-review').startsAt).toBe(
      '2026-05-06T23:00:00+08:00'
    );
  });

  it('updates task status only after confirming a queued task update suggestion', async () => {
    const base = createDemoState();
    const app = await startTestServer({
      ...base,
      tasks: [
        {
          id: 'task-interview',
          title: '访谈材料',
          deadline: '5月12日 23:59',
          owners: ['陈晨'],
          status: 'pending',
          sourceMessageId: 'msg-05'
        },
        ...base.tasks
      ]
    });

    const planned = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: '建议把访谈材料任务标记为进行中'
      })
    });
    const beforeConfirm = await requestJson(`${app.url}/api/state`);

    expect(planned.actionRequest.input.taskPatch).toMatchObject({
      taskId: 'task-interview',
      oldStatus: 'pending',
      newStatus: 'in_progress'
    });
    expect(beforeConfirm.tasks.find((task: { id: string }) => task.id === 'task-interview').status).toBe('pending');

    await requestJson(`${app.url}/api/agent/actions/${planned.actionRequest.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: 'user-lin',
        reason: 'Human approved status change'
      })
    });
    const afterConfirm = await requestJson(`${app.url}/api/state`);

    expect(afterConfirm.tasks.find((task: { id: string }) => task.id === 'task-interview').status).toBe('in_progress');
  });

  it('blocks confirmation instead of mutating state when a queued action has no explicit patch', async () => {
    const base = createDemoState();
    const app = await startTestServer({
      ...base,
      actionRequests: [
        {
          id: 'action-no-patch',
          agentId: 'agent-lin',
          roomId: 'room-team',
          kind: 'coordinate',
          status: 'needs_confirmation',
          input: {
            proposal: 'Move something sometime'
          },
          risk: {
            level: 'high',
            score: 0.9,
            reason: 'Missing explicit patch',
            model: 'test'
          },
          createdAt: '2026-05-04T08:00:00.000Z',
          updatedAt: '2026-05-04T08:00:00.000Z',
          requiresHuman: true
        }
      ]
    });

    const confirmed = await requestJson(`${app.url}/api/agent/actions/action-no-patch/confirm`, {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: 'user-lin',
        reason: 'Try to confirm without a patch'
      })
    });
    const state = await requestJson(`${app.url}/api/state`);

    expect(confirmed.action).toMatchObject({
      id: 'action-no-patch',
      status: 'blocked',
      requiresHuman: true
    });
    expect(state.calendar.find((item: { id: string }) => item.id === 'cal-review').startsAt).toBe(
      '2026-05-05T20:30:00+08:00'
    );
  });
});

async function startTestServer(initialState?: DemoState) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-im-confirm-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'db.json');
  if (initialState) {
    await writeFile(dbPath, JSON.stringify(initialState, null, 2), 'utf8');
  }
  const app = await createAppServer({
    dbPath,
    port: 0,
    matrixBootstrapPath: null
  });
  servers.push(app);
  return app;
}

function createStateWithMatrixBackedSlides(): DemoState {
  const baseState = createDemoState();
  return {
    ...baseState,
    files: baseState.files.map((file) =>
      file.id === 'file-slides-v3'
        ? {
            ...file,
            mxcUri: 'mxc://localhost/slides-v3',
            contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            size: 4096
          }
        : file
    )
  };
}

async function createHighRiskShareAction(baseUrl: string) {
  await requestJson(`${baseUrl}/api/agent/share-file`, {
    method: 'POST',
    body: JSON.stringify({
      agentId: 'agent-lin',
      roomId: 'room-team',
      requesterId: 'user-missing',
      requestText: '把最新演示稿发给我'
    })
  });
  const actions = await requestJson(`${baseUrl}/api/agent/actions`);
  const action = actions.actions.find(
    (candidate: { kind: string; status: string }) =>
      candidate.kind === 'share_file' && candidate.status === 'needs_confirmation'
  );
  expect(action).toBeTruthy();
  return { action };
}

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  expect(response.ok).toBe(true);
  return response.json();
}
