// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import { MatrixStore, type MatrixBootstrap } from './matrixClient';

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('Matrix media repository integration', () => {
  it('uploads raw bytes to Matrix media and sends an m.file event with mxc metadata', async () => {
    const seen: Array<{ path: string; method: string; body: string; contentType?: string; authorization?: string }> = [];
    const app = await createMatrixStub(async (request, response) => {
      const body = await readBody(request);
      const path = request.url ?? '';
      seen.push({
        path,
        method: request.method ?? 'GET',
        body: body.toString('utf8'),
        contentType: request.headers['content-type'],
        authorization: request.headers.authorization
      });

      if (path.startsWith('/_matrix/media/v3/upload')) {
        sendJson(response, { content_uri: 'mxc://localhost/uploaded-report' });
        return;
      }

      if (path.includes('/send/m.room.message/')) {
        sendJson(response, { event_id: '$file-event' });
        return;
      }

      if (path.includes('/messages')) {
        sendJson(response, { chunk: [] });
        return;
      }

      sendJson(response, {});
    });
    servers.push(app);

    const bootstrap: MatrixBootstrap = {
      homeserverUrl: app.url,
      users: {
        'user-lin': {
          matrixUserId: '@lin:localhost',
          accessToken: 'token-lin'
        }
      },
      rooms: {
        'room-team': '!team:localhost'
      }
    };
    const store = new MatrixStore(bootstrap);
    const media = await store.uploadMedia({
      senderId: 'user-lin',
      filename: 'report.pdf',
      contentType: 'application/pdf',
      bytes: Buffer.from('real file bytes')
    });
    const message = await store.sendMessage(
      createDemoState(),
      {
        roomId: 'room-team',
        senderId: 'user-lin',
        body: 'report.pdf'
      },
      {
        fileId: 'file-uploaded-report',
        fileName: 'report.pdf',
        mxcUri: media.mxcUri,
        mimeType: 'application/pdf',
        size: media.size
      }
    );

    expect(media.mxcUri).toBe('mxc://localhost/uploaded-report');
    expect(media.size).toBe(15);
    expect(message.mxcUri).toBe('mxc://localhost/uploaded-report');
    expect(seen[0]).toMatchObject({
      method: 'POST',
      contentType: 'application/pdf',
      body: 'real file bytes'
    });
    const sentContent = JSON.parse(seen[1].body);
    expect(sentContent).toMatchObject({
      msgtype: 'm.file',
      body: 'report.pdf',
      url: 'mxc://localhost/uploaded-report',
      file_id: 'file-uploaded-report'
    });
    expect(sentContent.info).toMatchObject({
      mimetype: 'application/pdf',
      size: 15
    });
  });

  it('downloads Matrix media bytes from an mxc URI', async () => {
    const seen: Array<{ path: string; method: string; authorization?: string }> = [];
    const app = await createMatrixStub(async (request, response) => {
      const path = request.url ?? '';
      seen.push({
        path,
        method: request.method ?? 'GET',
        authorization: request.headers.authorization
      });

      if (path === '/_matrix/client/v1/media/download/localhost/uploaded-report/report.pdf') {
        response.writeHead(200, { 'content-type': 'application/pdf' });
        response.end(Buffer.from('downloaded file bytes'));
        return;
      }

      sendJson(response, {});
    });
    servers.push(app);

    const store = new MatrixStore({
      homeserverUrl: app.url,
      users: {
        'user-lin': {
          matrixUserId: '@lin:localhost',
          accessToken: 'token-lin'
        }
      },
      rooms: {}
    });

    const media = await store.downloadMedia('mxc://localhost/uploaded-report', 'report.pdf');

    expect(Buffer.from(media.bytes).toString('utf8')).toBe('downloaded file bytes');
    expect(media.contentType).toBe('application/pdf');
    expect(seen[0]).toMatchObject({
      method: 'GET',
      path: '/_matrix/client/v1/media/download/localhost/uploaded-report/report.pdf',
      authorization: 'Bearer token-lin'
    });
  });

  it('does not trust app-specific agent and file metadata from a different Matrix sender', async () => {
    const app = await createMatrixStub(async (request, response) => {
      if ((request.url ?? '').includes('/messages')) {
        sendJson(response, {
          chunk: [
            {
              event_id: '$spoofed-agent-file',
              sender: '@chen:localhost',
              origin_server_ts: Date.now(),
              type: 'm.room.message',
              content: {
                msgtype: 'm.file',
                body: 'spoofed agent file',
                agent_label: '个人助手代发',
                source_agent_id: 'agent-lin',
                file_id: 'file-slides-v3',
                url: 'mxc://localhost/spoofed',
                info: {
                  mimetype: 'application/pdf',
                  size: 1024
                }
              }
            }
          ]
        });
        return;
      }

      sendJson(response, {});
    });
    servers.push(app);

    const store = new MatrixStore({
      homeserverUrl: app.url,
      users: {
        'user-lin': { matrixUserId: '@lin:localhost', accessToken: 'token-lin' },
        'user-chen': { matrixUserId: '@chen:localhost', accessToken: 'token-chen' }
      },
      rooms: {
        'room-team': '!team:localhost'
      }
    });

    const synced = await store.syncStateOnce(createDemoState());
    const message = synced.state.messages.find((item) => item.id === '$spoofed-agent-file');

    expect(message).toMatchObject({
      senderId: 'user-chen',
      senderName: '陈晨',
      type: 'text',
      body: 'spoofed agent file'
    });
    expect(message?.agentLabel).toBeUndefined();
    expect(message?.sourceAgentId).toBeUndefined();
    expect(message?.fileId).toBeUndefined();
    expect(message?.mxcUri).toBeUndefined();
  });

  it('does not trust owner-matched app metadata outside the local room boundary', async () => {
    const app = await createMatrixStub(async (request, response) => {
      if ((request.url ?? '').includes('/messages')) {
        sendJson(response, {
          chunk: [
            {
              event_id: '$chen-agent-class-room',
              sender: '@chen:localhost',
              origin_server_ts: Date.now(),
              type: 'm.room.message',
              content: {
                msgtype: 'm.text',
                body: 'spoofed cross-room agent metadata',
                agent_label: '个人助手协商',
                source_agent_id: 'agent-chen'
              }
            },
            {
              event_id: '$lin-file-class-room',
              sender: '@lin:localhost',
              origin_server_ts: Date.now() + 1,
              type: 'm.room.message',
              content: {
                msgtype: 'm.file',
                body: 'spoofed cross-room file metadata',
                file_id: 'file-slides-v3',
                url: 'mxc://localhost/slides-v3',
                info: {
                  mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                  size: 4096
                }
              }
            }
          ]
        });
        return;
      }

      sendJson(response, {});
    });
    servers.push(app);

    const store = new MatrixStore({
      homeserverUrl: app.url,
      users: {
        'user-lin': { matrixUserId: '@lin:localhost', accessToken: 'token-lin' },
        'user-chen': { matrixUserId: '@chen:localhost', accessToken: 'token-chen' }
      },
      rooms: {
        'room-class': '!class:localhost'
      }
    });

    const synced = await store.syncStateOnce(createDemoState());
    const chenAgent = synced.state.messages.find((item) => item.id === '$chen-agent-class-room');
    const linFile = synced.state.messages.find((item) => item.id === '$lin-file-class-room');

    expect(chenAgent).toMatchObject({
      roomId: 'room-class',
      senderId: 'user-chen',
      type: 'text'
    });
    expect(chenAgent?.agentLabel).toBeUndefined();
    expect(chenAgent?.sourceAgentId).toBeUndefined();
    expect(linFile).toMatchObject({
      roomId: 'room-class',
      senderId: 'user-lin',
      type: 'text'
    });
    expect(linFile?.fileId).toBeUndefined();
    expect(linFile?.mxcUri).toBeUndefined();
  });
});

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

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, body: unknown) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
