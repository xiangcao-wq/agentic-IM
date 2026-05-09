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
    const app = await startTestServer(createStateWithMatrixBackedSlides());
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

  it('returns 409 without new logs when already resolved actions are reviewed again', async () => {
    const app = await startTestServer(createStateWithMatrixBackedSlides());
    const executed = await createHighRiskShareAction(app.url);
    await requestJson(`${app.url}/api/agent/actions/${executed.action.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: 'user-lin',
        reason: 'Approve once'
      })
    });

    const rejected = await createHighRiskShareAction(app.url);
    await requestJson(`${app.url}/api/agent/actions/${rejected.action.id}/reject`, {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: 'user-lin',
        reason: 'Reject once'
      })
    });
    const before = await requestJson(`${app.url}/api/state`);

    for (const action of [executed.action, rejected.action]) {
      for (const decision of ['confirm', 'reject']) {
        const response = await requestJsonAllowError(`${app.url}/api/agent/actions/${action.id}/${decision}`, {
          method: 'POST',
          body: JSON.stringify({
            reviewerId: 'user-lin',
            reason: 'Duplicate review'
          })
        });
        expect(response.status).toBe(409);
      }
    }

    const after = await requestJson(`${app.url}/api/state`);
    expect(after.actionLogs).toHaveLength(before.actionLogs.length);
    expect(after.actionRequests.find((action: { id: string }) => action.id === executed.action.id)).toEqual(
      before.actionRequests.find((action: { id: string }) => action.id === executed.action.id)
    );
    expect(after.actionRequests.find((action: { id: string }) => action.id === rejected.action.id)).toEqual(
      before.actionRequests.find((action: { id: string }) => action.id === rejected.action.id)
    );
  });

  it('serializes concurrent reviews of the same queued action', async () => {
    const app = await startTestServer(createStateWithMatrixBackedSlides());
    const queued = await createHighRiskShareAction(app.url);

    const reviews = await Promise.all([
      requestJsonAllowError(`${app.url}/api/agent/actions/${queued.action.id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({
          reviewerId: 'user-lin',
          reason: 'Approve concurrently A'
        })
      }),
      requestJsonAllowError(`${app.url}/api/agent/actions/${queued.action.id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({
          reviewerId: 'user-lin',
          reason: 'Approve concurrently B'
        })
      })
    ]);
    const state = await requestJson(`${app.url}/api/state`);

    expect(reviews.map((review) => review.status).sort()).toEqual([200, 409]);
    expect(state.actionRequests.find((action: { id: string }) => action.id === queued.action.id)).toMatchObject({
      status: 'executed',
      requiresHuman: false
    });
    expect(
      state.actionLogs.filter((log: { action: string }) => log.action === `confirm_action:${queued.action.id}`)
    ).toHaveLength(1);
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

  it('requires the reviewer to exist and belong to the action room', async () => {
    const app = await startTestServer(createStateWithMatrixBackedSlides());
    const unknownReviewer = await createHighRiskShareAction(app.url);
    const outsiderReviewer = await createHighRiskShareAction(app.url);
    const before = await requestJson(`${app.url}/api/state`);

    const unknownResponse = await requestJsonAllowError(`${app.url}/api/agent/actions/${unknownReviewer.action.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: 'user-missing',
        reason: 'Unknown reviewer'
      })
    });
    const outsiderResponse = await requestJsonAllowError(`${app.url}/api/agent/actions/${outsiderReviewer.action.id}/reject`, {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: 'user-teacher',
        reason: 'Not in this room'
      })
    });
    const after = await requestJson(`${app.url}/api/state`);

    expect(unknownResponse.status).toBe(403);
    expect(outsiderResponse.status).toBe(403);
    expect(after.actionLogs).toHaveLength(before.actionLogs.length);
    expect(after.actionRequests.find((action: { id: string }) => action.id === unknownReviewer.action.id)).toMatchObject({
      status: 'needs_confirmation',
      requiresHuman: true
    });
    expect(after.actionRequests.find((action: { id: string }) => action.id === outsiderReviewer.action.id)).toMatchObject({
      status: 'needs_confirmation',
      requiresHuman: true
    });
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

  it('updates linked A2A session status after confirmed or rejected actions', async () => {
    const base = createDemoState();
    const app = await startTestServer({
      ...base,
      actionRequests: [
        {
          id: 'action-a2a-confirm',
          agentId: 'agent-lin',
          roomId: 'room-team',
          kind: 'coordinate',
          status: 'needs_confirmation',
          input: {
            calendarPatch: {
              itemId: 'cal-review',
              oldStartsAt: '2026-05-05T20:30:00+08:00',
              newStartsAt: '2026-05-06T23:00:00+08:00'
            }
          },
          risk: {
            level: 'high',
            score: 0.82,
            reason: 'Schedule change requires human review',
            model: 'test'
          },
          createdAt: '2026-05-04T08:00:00.000Z',
          updatedAt: '2026-05-04T08:00:00.000Z',
          requiresHuman: true
        },
        {
          id: 'action-a2a-reject',
          agentId: 'agent-lin',
          roomId: 'room-team',
          kind: 'task_update_suggest',
          status: 'needs_confirmation',
          input: {
            taskPatch: {
              taskId: 'task-report',
              oldStatus: 'in_progress',
              newStatus: 'done'
            }
          },
          risk: {
            level: 'medium',
            score: 0.52,
            reason: 'Task change requires human review',
            model: 'test'
          },
          createdAt: '2026-05-04T08:01:00.000Z',
          updatedAt: '2026-05-04T08:01:00.000Z',
          requiresHuman: true
        }
      ],
      a2aSessions: [
        createA2ASessionForAction('a2a-confirm', 'action-a2a-confirm'),
        createA2ASessionForAction('a2a-reject', 'action-a2a-reject')
      ]
    });

    await requestJson(`${app.url}/api/agent/actions/action-a2a-confirm/confirm`, {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: 'user-lin',
        reason: 'Approve A2A proposal'
      })
    });
    await requestJson(`${app.url}/api/agent/actions/action-a2a-reject/reject`, {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: 'user-lin',
        reason: 'Reject A2A proposal'
      })
    });
    const state = await requestJson(`${app.url}/api/state`);

    expect(state.a2aSessions.find((session: { id: string }) => session.id === 'a2a-confirm')).toMatchObject({
      status: 'completed'
    });
    expect(state.a2aSessions.find((session: { id: string }) => session.id === 'a2a-reject')).toMatchObject({
      status: 'blocked'
    });
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

  it('blocks file share confirmation when the queued action has no downloadable file binding', async () => {
    const app = await startTestServer();
    const queued = await createHighRiskShareAction(app.url);
    const before = await requestJson(`${app.url}/api/state`);

    const confirmed = await requestJson(`${app.url}/api/agent/actions/${queued.action.id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: 'user-lin',
        reason: 'Try to confirm without downloadable backing'
      })
    });
    const after = await requestJson(`${app.url}/api/state`);

    expect(confirmed.action).toMatchObject({
      id: queued.action.id,
      status: 'blocked',
      requiresHuman: true
    });
    expect(after.messages).toHaveLength(before.messages.length);
    expect(after.messages.some((message: { fileId?: string }) => message.fileId === 'file-slides-v3')).toBe(
      before.messages.some((message: { fileId?: string }) => message.fileId === 'file-slides-v3')
    );
  });

  it('blocks file share confirmation when the bound file version changed before review', async () => {
    const base = createStateWithMatrixBackedSlides();
    const app = await startTestServer({
      ...base,
      files: base.files.map((file) =>
        file.id === 'file-slides-v3'
          ? {
              ...file,
              version: 4
            }
          : file
      ),
      actionRequests: [
        {
          id: 'action-stale-file',
          agentId: 'agent-lin',
          roomId: 'room-team',
          kind: 'share_file',
          status: 'needs_confirmation',
          input: {
            requesterId: 'user-chen',
            requestText: 'send latest slides',
            fileId: 'file-slides-v3',
            fileVersion: 3
          },
          risk: {
            level: 'medium',
            score: 0.58,
            reason: 'Confirm file handoff',
            model: 'test'
          },
          createdAt: '2026-05-04T08:00:00.000Z',
          updatedAt: '2026-05-04T08:00:00.000Z',
          requiresHuman: true
        }
      ]
    });
    const before = await requestJson(`${app.url}/api/state`);

    const confirmed = await requestJson(`${app.url}/api/agent/actions/action-stale-file/confirm`, {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: 'user-lin',
        reason: 'Confirm stale file'
      })
    });
    const after = await requestJson(`${app.url}/api/state`);

    expect(confirmed.action).toMatchObject({
      status: 'blocked',
      requiresHuman: true
    });
    expect(after.messages).toHaveLength(before.messages.length);
    expect(after.messages.some((message: { id: string }) => message.id === 'msg-agent-share-file-slides-v3')).toBe(false);
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

function createA2ASessionForAction(id: string, actionId: string): DemoState['a2aSessions'][number] {
  return {
    id,
    roomId: 'room-team',
    initiatorAgentId: 'agent-chen',
    targetAgentIds: ['agent-lin'],
    goal: `test session for ${actionId}`,
    status: 'needs_confirmation',
    turns: [],
    proposedActionRequestIds: [actionId],
    contextIds: [actionId],
    risk: {
      level: 'medium',
      score: 0.5,
      reason: 'A2A proposal requires human review',
      model: 'test'
    },
    createdAt: '2026-05-04T08:00:00.000Z',
    updatedAt: '2026-05-04T08:00:00.000Z'
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

async function requestJsonAllowError(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  return {
    status: response.status,
    body: await response.json()
  };
}
