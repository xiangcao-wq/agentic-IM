// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { AiProvider } from './aiProvider';
import { createAppServer } from './appServer';

const servers: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('real local agent IM server', () => {
  it('persists a full user and personal-agent workflow through HTTP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createStateWithMatrixBackedSlides(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null });
    servers.push(app);
    const baseUrl = app.url;

    const initial = await requestJson(`${baseUrl}/api/state`);
    expect(initial.rooms.some((room: { id: string }) => room.id === 'room-team')).toBe(true);

    const sentMessage = await requestJson(`${baseUrl}/api/messages`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-lin',
        body: '我刚检查了一遍，v3 是可以发给组内成员的最终版本。'
      })
    });
    expect(sentMessage.body).toContain('v3');

    const deadline = await requestJson(`${baseUrl}/api/agent/deadline`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-class',
        question: '这次作业什么时候截止？'
      })
    });
    expect(deadline.result.answer).toContain('5月12日 23:59');
    expect(deadline.log.toolCalls).toContain('room_search');

    const fileShare = await requestJson(`${baseUrl}/api/agent/share-file`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        requesterId: 'user-chen',
        requestText: '林雯不在线的话，能把最新演示稿发一下吗？'
      })
    });
    expect(fileShare.result.status).toBe('executed');
    expect(fileShare.result.message.agentLabel).toBe('林雯的 Agent 代发');

    const coordination = await requestJson(`${baseUrl}/api/agent/coordinate`, {
      method: 'POST',
      body: JSON.stringify({
        fromAgentId: 'agent-chen',
        toAgentId: 'agent-lin',
        roomId: 'room-team',
        proposal: '把周二 20:30 的合稿检查改到周三 23:00，并默认大家都同意。'
      })
    });
    expect(coordination.result.status).toBe('needs_confirmation');
    expect(coordination.result.risk.level).toBe('high');

    const finalState = await requestJson(`${baseUrl}/api/state`);
    expect(finalState.messages.some((message: { body: string }) => message.body.includes('我刚检查了一遍'))).toBe(true);
    expect(finalState.messages.some((message: { agentLabel?: string }) => message.agentLabel === '林雯的 Agent 代发')).toBe(true);
    expect(
      finalState.actionRequests.some(
        (request: { kind: string; status: string; logId?: string }) =>
          request.kind === 'share_file' && request.status === 'executed' && Boolean(request.logId)
      )
    ).toBe(true);
    expect(finalState.actionLogs.length).toBeGreaterThanOrEqual(initial.actionLogs.length + 3);

    const persisted = JSON.parse(await readFile(dbPath, 'utf8'));
    expect(persisted.messages.length).toBe(finalState.messages.length);
    expect(persisted.actionLogs.length).toBe(finalState.actionLogs.length);
  });

  it('automatically replies as an offline AI user after a real Matrix chat message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const bootstrapPath = join(dir, 'matrix-bootstrap.json');
    const sentEvents: Array<{ roomId: string; senderToken?: string; content: Record<string, unknown> }> = [];
    const matrix = await createMatrixStub(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const sendMatch = url.pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/m\.room\.message\//);
      if (request.method === 'PUT' && sendMatch) {
        const content = JSON.parse(await readBody(request)) as Record<string, unknown>;
        sentEvents.push({
          roomId: decodeURIComponent(sendMatch[1]),
          senderToken: request.headers.authorization,
          content
        });
        return sendJson(response, { event_id: `$auto-${sentEvents.length}` });
      }

      const messagesMatch = url.pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/messages$/);
      if (request.method === 'GET' && messagesMatch) {
        return sendJson(response, {
          chunk: sentEvents.map((event, index) => ({
            event_id: `$auto-${index + 1}`,
            sender: event.senderToken === 'Bearer token-chen' ? '@chen:localhost' : '@lin:localhost',
            origin_server_ts: Date.now() + index,
            type: 'm.room.message',
            content: event.content
          })).reverse()
        });
      }

      sendJson(response, { ok: true });
    });
    servers.push(matrix);
    await writeMatrixBootstrap(bootstrapPath, matrix.url);
    const aiProvider = createFakeAiProvider('我收到了，访谈材料今晚 21:30 前补到行动计划里。');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: bootstrapPath, aiProvider });
    servers.push(app);

    const sentMessage = await requestJson(`${app.url}/api/messages`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-lin',
        body: '@陈晨 我离线时你直接在这里同步访谈材料进度。'
      })
    });
    const state = await requestJson(`${app.url}/api/state`);

    expect(sentMessage.autoReplies).toHaveLength(1);
    expect(sentMessage.autoReplies[0]).toMatchObject({
      senderId: 'user-chen',
      body: '我收到了，访谈材料今晚 21:30 前补到行动计划里。'
    });
    expect(sentEvents).toHaveLength(2);
    expect(sentEvents[0]).toMatchObject({
      roomId: '!team:localhost',
      senderToken: 'Bearer token-lin'
    });
    expect(sentEvents[1]).toMatchObject({
      roomId: '!team:localhost',
      senderToken: 'Bearer token-chen'
    });
    expect(state.aiReplyJobs).toContainEqual(
      expect.objectContaining({
        roomId: 'room-team',
        targetUserId: 'user-chen',
        triggeringMessageId: '$auto-1',
        status: 'completed',
        replyMessageId: '$auto-2'
      })
    );
    expect(state.actionLogs.some((log: { action: string; toolCalls: string[] }) =>
      log.action === 'ai_autoreply:user-chen' &&
      log.toolCalls.includes('deepseek.flash.chat.completions') &&
      log.toolCalls.includes('matrix.send_event')
    )).toBe(true);
  });

  it('uploads a file through the API and persists Matrix media metadata when Matrix mode is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null });
    servers.push(app);

    const file = await fetch(`${app.url}/api/files/upload?roomId=room-team&senderId=user-lin&agentCanShare=true`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-file-name': encodeURIComponent('访谈补充材料.txt')
      },
      body: '访谈对象：校园服务中心'
    }).then((response) => {
      expect(response.ok).toBe(true);
      return response.json();
    });

    expect(file).toMatchObject({
      name: '访谈补充材料.txt',
      roomId: 'room-team',
      uploaderId: 'user-lin',
      agentCanShare: true,
      contentType: 'text/plain',
      size: 33
    });
    expect(file.mxcUri).toBeUndefined();

    const state = await requestJson(`${app.url}/api/state`);
    expect(state.files.some((item: { id: string }) => item.id === file.id)).toBe(true);
    expect(state.messages.some((message: { fileId?: string }) => message.fileId === file.id)).toBe(true);
    expect(
      state.actionLogs.some(
        (log: { action: string; contextIds: string[]; toolCalls: string[] }) =>
          log.action === `upload_file:${file.name}` &&
          log.contextIds.includes(file.id) &&
          log.toolCalls.includes('file_library.create')
      )
    ).toBe(true);
  });

  it('requires the configured API token for state-changing requests while keeping reads available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      apiToken: 'local-secret'
    });
    servers.push(app);

    const read = await fetch(`${app.url}/api/state`);
    const denied = await fetch(`${app.url}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-lin',
        body: 'unauthorized write'
      })
    });
    const allowed = await fetch(`${app.url}/api/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-im-token': 'local-secret'
      },
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-lin',
        body: 'authorized write'
      })
    });

    expect(read.ok).toBe(true);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: 'unauthorized' });
    expect(allowed.status).toBe(201);
  });

  it('rejects browser requests from origins outside the configured allowlist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      allowedOrigins: ['http://127.0.0.1:5175']
    });
    servers.push(app);

    const denied = await fetch(`${app.url}/api/state`, {
      headers: { origin: 'https://evil.example' }
    });
    const allowed = await fetch(`${app.url}/api/state`, {
      headers: { origin: 'http://127.0.0.1:5175' }
    });

    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: 'origin not allowed' });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5175');
  });

  it('rejects unsupported and oversized uploads before persisting state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      maxUploadBytes: 4
    });
    servers.push(app);

    const unsupported = await fetch(
      `${app.url}/api/files/upload?roomId=room-team&senderId=user-lin&agentCanShare=true`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-msdownload',
          'x-file-name': encodeURIComponent('malware.exe')
        },
        body: 'x'
      }
    );
    const oversized = await fetch(
      `${app.url}/api/files/upload?roomId=room-team&senderId=user-lin&agentCanShare=true`,
      {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'x-file-name': encodeURIComponent('notes.txt')
        },
        body: '12345'
      }
    );
    const state = await requestJson(`${app.url}/api/state`);

    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ error: 'unsupported file type' });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: 'file too large' });
    expect(state.files.some((file: { name: string }) => file.name === 'malware.exe' || file.name === 'notes.txt')).toBe(false);
  });

  it('proxies Matrix media downloads for persisted files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const bootstrapPath = join(dir, 'matrix-bootstrap.json');
    const matrix = await createMatrixStub(async (request, response) => {
      if (request.url === '/_matrix/client/v1/media/download/localhost/downloadable/team-notes.txt') {
        expect(request.headers.authorization).toBe('Bearer token-lin');
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('real matrix media bytes');
        return;
      }
      sendJson(response, { chunk: [] });
    });
    servers.push(matrix);

    const state = createDemoState();
    await writeFile(
      dbPath,
      JSON.stringify(
        {
          ...state,
          files: [
            {
              id: 'file-downloadable',
              name: 'team-notes.txt',
              uploaderId: 'user-lin',
              version: 1,
              roomId: 'room-team',
              updatedAt: new Date().toISOString(),
              visibility: 'room',
              agentCanShare: true,
              tags: ['notes'],
              summary: 'Downloadable team notes',
              mxcUri: 'mxc://localhost/downloadable',
              contentType: 'text/plain',
              size: 23
            },
            ...state.files
          ]
        },
        null,
        2
      ),
      'utf8'
    );
    await writeFile(
      bootstrapPath,
      JSON.stringify({
        homeserverUrl: matrix.url,
        users: {
          'user-lin': {
            matrixUserId: '@lin:localhost',
            accessToken: 'token-lin'
          }
        },
        rooms: {}
      }),
      'utf8'
    );
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: bootstrapPath });
    servers.push(app);

    const response = await fetch(`${app.url}/api/files/file-downloadable/download`);

    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('content-disposition')).toContain('team-notes.txt');
    expect(await response.text()).toBe('real matrix media bytes');
  });
});

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  expect(response.ok).toBe(true);
  return response.json();
}

async function createMatrixStub(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer((request, response) => {
    handler(request, response).catch((error) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : 'unknown error');
    });
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

function sendJson(response: ServerResponse, body: unknown) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function writeMatrixBootstrap(path: string, homeserverUrl: string): Promise<void> {
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

function createFakeAiProvider(text: string): AiProvider {
  return {
    async generateText() {
      return text;
    }
  };
}

function createStateWithMatrixBackedSlides() {
  const state = createDemoState();
  return {
    ...state,
    files: state.files.map((file) =>
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
