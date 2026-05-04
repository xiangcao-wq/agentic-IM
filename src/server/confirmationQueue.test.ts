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
