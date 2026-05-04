// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { DemoState } from '../domain/types';
import type { AiProvider } from './aiProvider';
import { createAppServer } from './appServer';

const servers: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runtime upgrade APIs', () => {
  it('generates a real-time AI human reply and writes it through Matrix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const bootstrapPath = join(dir, 'matrix-bootstrap.json');
    const matrix = await createMatrixStub();
    servers.push(matrix);
    await writeBootstrap(bootstrapPath, matrix.url);
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const aiProvider = createFakeAiProvider('陈晨：我刚看了行动计划，今晚可以先补访谈截图。');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: bootstrapPath, aiProvider });
    servers.push(app);

    const reply = await requestJson(`${app.url}/api/ai/human-reply`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        userId: 'user-chen',
        prompt: '请基于当前小组任务自然回复一句。'
      })
    });
    const state = await requestJson(`${app.url}/api/state`);

    expect(reply.message.body).toContain('访谈截图');
    expect(reply.log.toolCalls).toContain('deepseek.flash.chat.completions');
    expect(aiProvider.calls[0]).toMatchObject({ actorRole: 'human_user', actorId: 'user-chen' });
    expect(state.messages.some((message: { id: string; body: string }) => message.id.startsWith('$') && message.body.includes('访谈截图'))).toBe(true);
  });

  it('runs unified Agent intents, writes memory, and enforces cross-room authorization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createStateWithShareablePlan(), null, 2), 'utf8');
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      aiProvider: createFakeAiProvider('Agent 计划：先检索任务和文件，再执行低风险动作。')
    });
    servers.push(app);

    const summary = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'summary',
        userText: '总结小组和班级上下文'
      })
    });
    const memories = await requestJson(`${app.url}/api/memories?agentId=agent-lin`);
    const deadline = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'deadline',
        userText: '这次作业什么时候截止？'
      })
    });
    const share = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'share_file',
        userText: '把最新行动计划发一下'
      })
    });
    const denied = await fetch(`${app.url}/api/agent/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-chen',
        roomId: 'room-class',
        intent: 'deadline',
        userText: '读取班级群截止日期'
      })
    });

    expect(summary.memory.kind).toBe('summary');
    expect(memories.memories.some((memory: { id: string }) => memory.id === summary.memory.id)).toBe(true);
    expect(deadline.result.answer).toContain('5月12日 23:59');
    expect(deadline.memory.sourceIds.length).toBeGreaterThan(0);
    expect(share.result.status).toBe('executed');
    expect(share.result.file).toMatchObject({
      name: '第4组-校园服务数字化调研-行动计划.pdf',
      mxcUri: 'mxc://localhost/plan'
    });
    expect(share.result.message).toMatchObject({
      agentLabel: '林雯的 Agent 代发',
      mxcUri: 'mxc://localhost/plan',
      contentType: 'application/pdf',
      size: 708
    });
    expect(denied.ok).toBe(false);
    expect(await denied.text()).toContain('cannot read room-class');
  });

  it('generates openable demo assets and uploads them to Matrix media', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const bootstrapPath = join(dir, 'matrix-bootstrap.json');
    const matrix = await createMatrixStub();
    servers.push(matrix);
    await writeBootstrap(bootstrapPath, matrix.url);
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: bootstrapPath });
    servers.push(app);

    const generated = await requestJson(`${app.url}/api/demo/assets/generate`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-lin'
      })
    });

    expect(generated.files).toHaveLength(4);
    expect(generated.files.map((file: { contentType: string }) => file.contentType)).toEqual([
      'text/plain; charset=utf-8',
      'text/markdown; charset=utf-8',
      'application/pdf',
      'image/png'
    ]);
    expect(generated.files.every((file: { mxcUri?: string }) => file.mxcUri?.startsWith('mxc://localhost/'))).toBe(true);
  });

  it('writes unified Agent coordination into the Matrix agent room', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const bootstrapPath = join(dir, 'matrix-bootstrap.json');
    const matrix = await createMatrixStub();
    servers.push(matrix);
    await writeBootstrap(bootstrapPath, matrix.url);
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: bootstrapPath,
      aiProvider: createFakeAiProvider('Agent 计划：先检查日程影响，再向对方 Agent 提出可审计安排。')
    });
    servers.push(app);

    const coordination = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'coordinate',
        targetUserId: 'user-chen',
        userText: '把周二 20:30 的合稿检查改到周三 23:00，请和陈晨的 Agent 协调。'
      })
    });
    const state = await requestJson(`${app.url}/api/state`);

    expect(coordination.message).toMatchObject({
      roomId: 'room-agent',
      agentLabel: '林雯的 Agent 协调',
      sourceAgentId: 'agent-lin'
    });
    expect(state.messages.some((message: { id: string; roomId: string; agentLabel?: string }) =>
      message.id.startsWith('$') &&
      message.roomId === 'room-agent' &&
      message.agentLabel === '林雯的 Agent 协调'
    )).toBe(true);
  });

  it('syncs Matrix events once, persists checkpoints, and avoids duplicates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const bootstrapPath = join(dir, 'matrix-bootstrap.json');
    const matrix = await createMatrixStub({
      roomEvents: {
        '!team:localhost': [
          {
            event_id: '$external-1',
            sender: '@chen:localhost',
            origin_server_ts: Date.now(),
            type: 'm.room.message',
            content: {
              msgtype: 'm.text',
              body: '外部 Matrix 客户端发来的真实消息'
            }
          }
        ]
      }
    });
    servers.push(matrix);
    await writeBootstrap(bootstrapPath, matrix.url);
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: bootstrapPath });
    servers.push(app);

    const first = await requestJson(`${app.url}/api/matrix/sync-once`, { method: 'POST' });
    const second = await requestJson(`${app.url}/api/matrix/sync-once`, { method: 'POST' });
    const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as DemoState;

    expect(first.messagesAdded).toBe(1);
    expect(second.messagesAdded).toBe(0);
    expect(persisted.messages.filter((message) => message.id === '$external-1')).toHaveLength(1);
    expect(persisted.matrixObserverCheckpoints).toContainEqual({
      roomId: 'room-team',
      lastEventId: '$external-1'
    });
  });

  it('does not inject Matrix room history into plain state reads before explicit sync', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const bootstrapPath = join(dir, 'matrix-bootstrap.json');
    const matrix = await createMatrixStub({
      roomEvents: {
        '!team:localhost': [
          {
            event_id: '$history-noise',
            sender: '@chen:localhost',
            origin_server_ts: Date.now(),
            type: 'm.room.message',
            content: {
              msgtype: 'm.text',
              body: '联调测试消息不应在普通 state read 中自动污染 demo'
            }
          }
        ]
      }
    });
    servers.push(matrix);
    await writeBootstrap(bootstrapPath, matrix.url);
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: bootstrapPath });
    servers.push(app);

    const beforeSync = await requestJson(`${app.url}/api/state`);
    const sync = await requestJson(`${app.url}/api/matrix/sync-once`, { method: 'POST' });
    const afterSync = await requestJson(`${app.url}/api/state`);

    expect(beforeSync.messages.some((message: { id: string }) => message.id === '$history-noise')).toBe(false);
    expect(sync.messagesAdded).toBe(1);
    expect(afterSync.messages.some((message: { id: string }) => message.id === '$history-noise')).toBe(true);
  });
});

function createFakeAiProvider(text: string): AiProvider & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async generateText(prompt) {
      calls.push(prompt as unknown as Record<string, unknown>);
      return text;
    }
  };
}

function createStateWithShareablePlan(): DemoState {
  const state = createDemoState();
  return {
    ...state,
    files: [
      {
        id: 'file-plan-latest',
        name: '第4组-校园服务数字化调研-行动计划.pdf',
        uploaderId: 'user-lin',
        version: 9,
        roomId: 'room-team',
        updatedAt: '2026-05-04T09:00:00.000Z',
        visibility: 'room',
        agentCanShare: true,
        tags: ['plan', 'pdf', 'slides'],
        summary: '行动计划，截止时间 5月12日 23:59，可由 Agent 代发。',
        mxcUri: 'mxc://localhost/plan',
        contentType: 'application/pdf',
        size: 708
      },
      ...state.files
    ]
  };
}

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  expect(response.ok).toBe(true);
  return response.json();
}

async function writeBootstrap(path: string, homeserverUrl: string): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      homeserverUrl,
      users: {
        'user-lin': { matrixUserId: '@lin:localhost', accessToken: 'token-lin' },
        'user-chen': { matrixUserId: '@chen:localhost', accessToken: 'token-chen' },
        'user-zhao': { matrixUserId: '@zhao:localhost', accessToken: 'token-zhao' },
        'user-teacher': { matrixUserId: '@teacher:localhost', accessToken: 'token-teacher' }
      },
      rooms: {
        'room-class': '!class:localhost',
        'room-team': '!team:localhost',
        'room-agent': '!agent:localhost'
      }
    }),
    'utf8'
  );
}

interface MatrixStubEvent {
  event_id: string;
  sender: string;
  origin_server_ts: number;
  type: string;
  content?: Record<string, unknown>;
}

async function createMatrixStub(input: { roomEvents?: Record<string, MatrixStubEvent[]> } = {}) {
  const roomEvents: Record<string, MatrixStubEvent[]> = {
    '!class:localhost': [],
    '!team:localhost': [],
    '!agent:localhost': [],
    ...(input.roomEvents ?? {})
  };
  const tokenToSender: Record<string, string> = {
    'Bearer token-lin': '@lin:localhost',
    'Bearer token-chen': '@chen:localhost',
    'Bearer token-zhao': '@zhao:localhost',
    'Bearer token-teacher': '@teacher:localhost'
  };
  let counter = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const sendMatch = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/m\.room\.message\//);
      if (request.method === 'PUT' && sendMatch) {
        const roomId = decodeURIComponent(sendMatch[1]);
        const content = JSON.parse(await readBody(request)) as Record<string, unknown>;
        const event = {
          event_id: `$runtime-${++counter}`,
          sender: tokenToSender[request.headers.authorization ?? ''] ?? '@unknown:localhost',
          origin_server_ts: Date.now(),
          type: 'm.room.message',
          content
        };
        roomEvents[roomId] = [...(roomEvents[roomId] ?? []), event];
        sendJson(response, { event_id: event.event_id });
        return;
      }

      const messagesMatch = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/messages$/);
      if (request.method === 'GET' && messagesMatch) {
        const roomId = decodeURIComponent(messagesMatch[1]);
        sendJson(response, { chunk: [...(roomEvents[roomId] ?? [])].reverse() });
        return;
      }

      if (request.method === 'POST' && path === '/_matrix/media/v3/upload') {
        sendJson(response, { content_uri: `mxc://localhost/upload-${++counter}` });
        return;
      }

      sendJson(response, { ok: true });
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : 'unknown error');
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
