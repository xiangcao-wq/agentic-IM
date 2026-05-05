// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { AgentAutopilotAction } from '../domain/types';
import type { AiProvider, AiUsageSnapshot } from './aiProvider';
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

  it('uses local message storage when MATRIX_BOOTSTRAP_PATH disables Matrix', async () => {
    const previousMatrixPath = process.env.MATRIX_BOOTSTRAP_PATH;
    process.env.MATRIX_BOOTSTRAP_PATH = 'none';
    try {
      const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
      tempDirs.push(dir);
      const dbPath = join(dir, 'db.json');
      await writeFile(dbPath, JSON.stringify(createStateWithMatrixBackedSlides(), null, 2), 'utf8');
      const app = await createAppServer({ dbPath, port: 0, aiProvider: null });
      servers.push(app);

      const sentMessage = await requestJson(`${app.url}/api/messages`, {
        method: 'POST',
        body: JSON.stringify({
          roomId: 'room-team',
          senderId: 'user-chen',
          body: 'Lin is offline. Can her Agent send the latest slides to Chen?'
        })
      });

      expect(sentMessage.body).toContain('latest slides');
      expect(sentMessage.autopilotSessions).toHaveLength(1);
      expect(sentMessage.autopilotSessions[0].targetAgentIds).toContain('agent-lin');
    } finally {
      if (previousMatrixPath === undefined) {
        delete process.env.MATRIX_BOOTSTRAP_PATH;
      } else {
        process.env.MATRIX_BOOTSTRAP_PATH = previousMatrixPath;
      }
    }
  });

  it('returns an Agent chat message for explicit delegated A2A chat over HTTP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const sentMessage = await requestJson(`${app.url}/api/messages`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-chen',
        body: 'Lin Agent, who is responsible for interview materials?'
      })
    });

    expect(sentMessage.autopilotSessions).toHaveLength(1);
    expect(sentMessage.autopilotSessions[0]).toMatchObject({
      status: 'completed',
      targetAgentIds: ['agent-lin']
    });
    expect(sentMessage.autopilotMessages).toHaveLength(1);
    expect(sentMessage.autopilotMessages[0]).toMatchObject({
      type: 'agent',
      roomId: 'room-team',
      senderId: 'user-lin',
      sourceAgentId: 'agent-lin'
    });

    const state = await requestJson(`${app.url}/api/state`);
    expect(state.messages.some((message: { id: string }) => message.id === sentMessage.autopilotMessages[0].id)).toBe(true);
  });

  it('returns a negotiated A2A schedule session and queued calendar patch over HTTP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const state = createDemoState();
    await writeFile(
      dbPath,
      JSON.stringify(
        {
          ...state,
          agentAutopilotPolicies: state.agentAutopilotPolicies.map((policy) => ({
            ...policy,
            enabled: ['agent-lin', 'agent-chen'].includes(policy.agentId)
          }))
        },
        null,
        2
      ),
      'utf8'
    );
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const sentMessage = await requestJson(`${app.url}/api/messages`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-zhao',
        body: 'Lin Agent, please negotiate with Chen Agent and move the final review to Wednesday 23:00.'
      })
    });

    expect(sentMessage.autopilotSessions).toHaveLength(1);
    expect(sentMessage.autopilotSessions[0]).toMatchObject({
      status: 'needs_confirmation',
      targetAgentIds: ['agent-lin', 'agent-chen']
    });
    expect(sentMessage.autopilotSessions[0].turns.map((turn: { kind: string }) => turn.kind)).toEqual([
      'observation',
      'proposal',
      'response',
      'response',
      'proposal'
    ]);

    const currentState = await requestJson(`${app.url}/api/state`);
    const actionId = sentMessage.autopilotSessions[0].proposedActionRequestIds[0];
    const action = currentState.actionRequests.find((request: { id: string }) => request.id === actionId);
    expect(action).toMatchObject({
      kind: 'coordinate',
      status: 'needs_confirmation',
      input: {
        toAgentId: 'agent-chen',
        calendarPatch: {
          itemId: 'cal-review',
          newStartsAt: expect.stringContaining('23:00')
        }
      }
    });
    expect(currentState.calendar.find((item: { id: string }) => item.id === 'cal-review').startsAt).toBe(
      '2026-05-05T20:30:00+08:00'
    );
  });

  it('returns a schedule counter-proposal when the requested time conflicts over HTTP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const state = createDemoState();
    await writeFile(
      dbPath,
      JSON.stringify(
        {
          ...state,
          calendar: [
            ...state.calendar,
            {
              id: 'cal-chen-conflict',
              title: 'Chen interview material sync',
              startsAt: '2026-05-06T21:00:00+08:00',
              roomId: 'room-team',
              attendees: ['user-chen'],
              sourceTaskId: 'task-interview-materials'
            }
          ],
          agentAutopilotPolicies: state.agentAutopilotPolicies.map((policy) => ({
            ...policy,
            enabled: ['agent-lin', 'agent-chen'].includes(policy.agentId)
          }))
        },
        null,
        2
      ),
      'utf8'
    );
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const sentMessage = await requestJson(`${app.url}/api/messages`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-zhao',
        body: 'Lin Agent, please negotiate with Chen Agent and move the final review to Wednesday 21:00.'
      })
    });

    const chenTurn = sentMessage.autopilotSessions[0].turns.find((turn: { agentId: string }) => turn.agentId === 'agent-chen');
    expect(chenTurn).toMatchObject({
      kind: 'counter_proposal'
    });
    expect(chenTurn.message).toContain('Chen interview material sync');

    const currentState = await requestJson(`${app.url}/api/state`);
    const actionId = sentMessage.autopilotSessions[0].proposedActionRequestIds[0];
    const action = currentState.actionRequests.find((request: { id: string }) => request.id === actionId);
    expect(action.input.calendarPatch).toMatchObject({
      itemId: 'cal-review',
      newStartsAt: '2026-05-06T23:00:00+08:00'
    });
  });

  it('updates an Agent autopilot policy and changes later message automation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const state = createStateWithMatrixBackedSlides();
    await writeFile(dbPath, JSON.stringify(state, null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const disabled = await requestJson(`${app.url}/api/agent/autopilot-policy`, {
      method: 'PATCH',
      body: JSON.stringify({
        agentId: 'agent-lin',
        enabled: false,
        roomId: 'room-team',
        roomEnabled: false
      })
    });

    expect(disabled.policy).toMatchObject({
      agentId: 'agent-lin',
      enabled: false,
      allowedRoomIds: []
    });

    const noAutomation = await requestJson(`${app.url}/api/messages`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-chen',
        body: 'Lin is offline. Can her Agent send the latest slides to Chen?'
      })
    });
    expect(noAutomation.autopilotSessions).toHaveLength(0);

    const enabled = await requestJson(`${app.url}/api/agent/autopilot-policy`, {
      method: 'PATCH',
      body: JSON.stringify({
        agentId: 'agent-lin',
        enabled: true,
        roomId: 'room-team',
        roomEnabled: true
      })
    });
    expect(enabled.policy).toMatchObject({
      agentId: 'agent-lin',
      enabled: true,
      allowedRoomIds: ['room-team']
    });

    const automated = await requestJson(`${app.url}/api/messages`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-chen',
        body: 'Lin is offline. Can her Agent send the latest slides to Chen?'
      })
    });
    expect(automated.autopilotSessions).toHaveLength(1);
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

  it('records skipped auto reply jobs instead of fabricating replies when AI is not configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const before = await requestJson(`${app.url}/api/state`);
    const beforeChenMessages = before.messages.filter((message: { senderId: string }) => message.senderId === 'user-chen').length;
    const sentMessage = await requestJson(`${app.url}/api/messages`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-lin',
        body: '每天出去玩吗'
      })
    });
    const after = await requestJson(`${app.url}/api/state`);

    expect(sentMessage.autoReplies).toEqual([]);
    expect(sentMessage.autoReplyJobs).toHaveLength(1);
    expect(sentMessage.autoReplyJobs[0]).toMatchObject({
      roomId: 'room-team',
      targetUserId: 'user-chen',
      status: 'skipped'
    });
    expect(sentMessage.autoReplyJobs[0].reason).toContain('AI provider is not configured');
    expect(after.messages).toHaveLength(before.messages.length + 1);
    expect(after.messages.filter((message: { senderId: string }) => message.senderId === 'user-chen')).toHaveLength(
      beforeChenMessages
    );
    expect(after.aiReplyJobs[0]).toMatchObject({
      triggeringMessageId: sentMessage.id,
      status: 'skipped'
    });
  });

  it('uploads a file through the API and stores local downloadable media when Matrix mode is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, mediaDir: join(dir, 'media') });
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
    expect(file.localPath).toContain(file.id);

    const download = await fetch(`${app.url}/api/files/${file.id}/download`);
    expect(download.ok).toBe(true);
    expect(download.headers.get('content-type')).toContain('text/plain');
    expect(await download.text()).toBe('访谈对象：校园服务中心');

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

  it('runs Agent autopilot from a real user message and records the A2A handoff', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const state = createDemoState();
    await writeFile(
      dbPath,
      JSON.stringify(
        {
          ...state,
          files: state.files.map((file) =>
            file.id === 'file-slides-v3'
              ? {
                  ...file,
                  localPath: 'seed-slides-v3.pptx',
                  contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                  size: 4096
                }
              : file
          )
        },
        null,
        2
      ),
      'utf8'
    );
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const sentMessage = await requestJson(`${app.url}/api/messages`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-chen',
        body: 'Lin is offline. Can her Agent send the latest slides to Chen?'
      })
    });

    expect(sentMessage.autopilotSessions).toHaveLength(1);
    expect(sentMessage.autopilotMessages).toHaveLength(1);
    expect(sentMessage.autopilotMessages[0]).toMatchObject({
      type: 'file',
      sourceAgentId: 'agent-lin',
      fileId: 'file-slides-v3'
    });

    const finalState = await requestJson(`${app.url}/api/state`);
    expect(finalState.a2aSessions[0]).toMatchObject({
      initiatorAgentId: 'agent-chen',
      targetAgentIds: ['agent-lin'],
      status: 'completed'
    });
    expect(finalState.actionLogs[0].toolCalls).toContain('a2a.session');
  });

  it('records multiple A2A sessions from one explicitly addressed user message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const state = createDemoState();
    await writeFile(
      dbPath,
      JSON.stringify(
        {
          ...state,
          agentAutopilotPolicies: state.agentAutopilotPolicies.map((policy) => ({
            ...policy,
            enabled: policy.agentId === 'agent-lin' || policy.agentId === 'agent-chen'
          }))
        },
        null,
        2
      ),
      'utf8'
    );
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const sentMessage = await requestJson(`${app.url}/api/messages`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-zhao',
        body: 'Lin Agent and Chen Agent, what is the deadline?'
      })
    });

    expect(sentMessage.autopilotSessions).toHaveLength(2);
    expect(sentMessage.autopilotSessions.map((session: { targetAgentIds: string[] }) => session.targetAgentIds[0])).toEqual([
      'agent-lin',
      'agent-chen'
    ]);

    const finalState = await requestJson(`${app.url}/api/state`);
    expect(finalState.a2aSessions.slice(0, 2)).toHaveLength(2);
    expect(finalState.actionLogs.filter((log: { toolCalls: string[] }) => log.toolCalls.includes('a2a.session'))).toHaveLength(2);
  });

  it('sweeps pending room messages through the HTTP autopilot runner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const state = createDemoState();
    await writeFile(
      dbPath,
      JSON.stringify(
        {
          ...state,
          files: state.files.map((file) =>
            file.id === 'file-slides-v3'
              ? {
                  ...file,
                  localPath: 'seed-slides-v3.pptx',
                  contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                  size: 4096
                }
              : file
          ),
          messages: [
            ...state.messages,
            {
              id: 'msg-http-autopilot-backlog',
              roomId: 'room-team',
              senderId: 'user-chen',
              senderName: 'Chen Chen',
              body: 'Lin is offline. Can her Agent send the latest slides to Chen?',
              sentAt: '2026-05-04T21:00:00.000Z',
              type: 'text'
            }
          ]
        },
        null,
        2
      ),
      'utf8'
    );
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const first = await requestJson(`${app.url}/api/agent/autopilot/run-pending`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        limit: 5
      })
    });

    expect(first.processedMessageIds).toContain('msg-http-autopilot-backlog');
    expect(first.sessions).toHaveLength(1);
    expect(first.messages).toHaveLength(1);

    const second = await requestJson(`${app.url}/api/agent/autopilot/run-pending`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        limit: 5
      })
    });
    expect(second.processedMessageIds).not.toContain('msg-http-autopilot-backlog');
    expect(second.sessions).toHaveLength(0);
  });

  it('reports the automatic autopilot worker as disabled by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const status = await requestJson(`${app.url}/api/agent/autopilot/worker`);

    expect(status.worker).toMatchObject({
      enabled: false,
      running: false,
      intervalMs: 0,
      runCount: 0,
      lastProcessedCount: 0,
      lastSkippedCount: 0
    });
  });

  it('runs the automatic autopilot worker once and dedupes processed backlog messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const state = createDemoState();
    await writeFile(
      dbPath,
      JSON.stringify(
        {
          ...state,
          files: state.files.map((file) =>
            file.id === 'file-slides-v3'
              ? {
                  ...file,
                  localPath: 'seed-slides-v3.pptx',
                  contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                  size: 4096
                }
              : file
          ),
          messages: [
            ...state.messages,
            {
              id: 'msg-worker-autopilot-backlog',
              roomId: 'room-team',
              senderId: 'user-chen',
              senderName: 'Chen Chen',
              body: 'Lin is offline. Can her Agent send the latest slides to Chen?',
              sentAt: '2026-05-04T22:00:00.000Z',
              type: 'text'
            }
          ]
        },
        null,
        2
      ),
      'utf8'
    );
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      aiProvider: null,
      autopilotWorker: {
        enabled: true,
        intervalMs: 60_000,
        roomIds: ['room-team'],
        limit: 5,
        runOnStart: false
      }
    });
    servers.push(app);

    const first = await requestJson(`${app.url}/api/agent/autopilot/worker/run`, { method: 'POST' });

    expect(first.worker).toMatchObject({
      enabled: true,
      running: false,
      intervalMs: 60_000,
      runCount: 1,
      lastProcessedCount: 1
    });
    expect(first.processedMessageIds).toContain('msg-worker-autopilot-backlog');
    expect(first.sessions).toHaveLength(1);

    const persisted = await requestJson(`${app.url}/api/state`);
    expect(
      persisted.a2aSessions.some((session: { contextIds: string[] }) =>
        session.contextIds.includes('msg-worker-autopilot-backlog')
      )
    ).toBe(true);

    const second = await requestJson(`${app.url}/api/agent/autopilot/worker/run`, { method: 'POST' });
    expect(second.worker).toMatchObject({
      runCount: 2,
      lastProcessedCount: 0
    });
    expect(second.processedMessageIds).not.toContain('msg-worker-autopilot-backlog');
    expect(second.sessions).toHaveLength(0);
  });

  it('runs autonomous task follow-ups through the automatic autopilot worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const state = createDemoState();
    const owner = state.users.find((user: { id: string }) => user.id === 'user-chen');
    const sourceMessage = {
      id: 'msg-worker-task-follow-up-source',
      roomId: 'room-team',
      senderId: 'user-zhao',
      senderName: 'Zhao Yiming',
      body: 'Chen should start the interview appendix before tomorrow evening.',
      sentAt: '2026-05-05T09:00:00+08:00',
      type: 'text'
    };
    await writeFile(
      dbPath,
      JSON.stringify(
        {
          ...state,
          messages: [...state.messages, sourceMessage],
          tasks: [
            ...state.tasks.map((task) => ({ ...task, status: 'done' as const })),
            {
              id: 'task-worker-follow-up',
              title: 'Interview appendix screenshots',
              deadline: '5月6日 18:00',
              owners: [owner?.name ?? 'Chen Chen'],
              status: 'pending',
              sourceMessageId: sourceMessage.id
            }
          ],
          agentAutopilotPolicies: state.agentAutopilotPolicies.map((policy) =>
            policy.agentId === 'agent-chen'
              ? {
                  ...policy,
                  enabled: true,
                  allowedRoomIds: ['room-team'],
                  allowedActions: [...new Set([...policy.allowedActions, 'suggest_task_updates'])] as AgentAutopilotAction[]
                }
              : policy
          )
        },
        null,
        2
      ),
      'utf8'
    );
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      aiProvider: null,
      autopilotWorker: {
        enabled: true,
        intervalMs: 60_000,
        roomIds: ['room-team'],
        limit: 5,
        runOnStart: false
      }
    });
    servers.push(app);

    const first = await requestJson(`${app.url}/api/agent/autopilot/worker/run`, { method: 'POST' });

    expect(first.processedTaskIds).toContain('task-worker-follow-up');
    expect(first.worker).toMatchObject({
      runCount: 1,
      lastProcessedCount: 1
    });
    expect(first.sessions.some((session: { contextIds: string[] }) =>
      session.contextIds.includes('task-worker-follow-up')
    )).toBe(true);

    const persisted = await requestJson(`${app.url}/api/state`);
    const task = persisted.tasks.find((candidate: { id: string }) => candidate.id === 'task-worker-follow-up');
    expect(task.status).toBe('pending');
    expect(
      persisted.actionRequests.some(
        (request: { kind: string; status: string; input: { taskId?: string } }) =>
          request.kind === 'task_update_suggest' &&
          request.status === 'needs_confirmation' &&
          request.input.taskId === 'task-worker-follow-up'
      )
    ).toBe(true);

    const second = await requestJson(`${app.url}/api/agent/autopilot/worker/run`, { method: 'POST' });
    expect(second.processedTaskIds).not.toContain('task-worker-follow-up');
  });

  it('generates local demo assets that can be downloaded without Matrix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, mediaDir: join(dir, 'media') });
    servers.push(app);

    const generated = await requestJson(`${app.url}/api/demo/assets/generate`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-lin'
      })
    });

    expect(generated.files).toHaveLength(8);
    expect(generated.files.every((file: { localPath?: string; mxcUri?: string }) => file.localPath && !file.mxcUri)).toBe(true);

    const poster = generated.files.find((file: { name: string; id: string }) => file.name.endsWith('.svg'));
    expect(poster?.id).toBeTruthy();
    const posterResponse = await fetch(`${app.url}/api/files/${poster!.id}/download`);
    expect(posterResponse.ok).toBe(true);
    expect(posterResponse.headers.get('content-type')).toContain('image/svg+xml');
    expect(await posterResponse.text()).toContain('<svg');
  });

  it('indexes uploaded text files but skips binary document uploads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, mediaDir: join(dir, 'media') });
    servers.push(app);

    const textFile = await fetch(`${app.url}/api/files/upload?roomId=room-team&senderId=user-lin&agentCanShare=true`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-file-name': encodeURIComponent('interview-notes.txt')
      },
      body: '引用一致性需要陈晨核对，行动计划和访谈纪要要对齐。'
    }).then((response) => response.json());
    const pdfFile = await fetch(`${app.url}/api/files/upload?roomId=room-team&senderId=user-lin&agentCanShare=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        'x-file-name': encodeURIComponent('report.pdf')
      },
      body: '%PDF-1.4 fake bytes'
    }).then((response) => response.json());

    const state = await requestJson(`${app.url}/api/state`);

    expect(state.fileTextChunks.some((chunk: { fileId: string; text: string }) =>
      chunk.fileId === textFile.id && chunk.text.includes('引用一致性')
    )).toBe(true);
    expect(state.fileTextChunks.some((chunk: { fileId: string }) => chunk.fileId === pdfFile.id)).toBe(false);
  });

  it('returns global AI status in /api/state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      aiProvider: null
    });
    servers.push(app);

    const state = await requestJson(`${app.url}/api/state`);

    expect(state.aiStatus).toMatchObject({
      configured: false,
      provider: 'fallback',
      health: 'missing'
    });
  });

  it('checks configured AI provider health and stores the latest status for /api/state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const aiProvider = createRecordingAiProvider(['ok', 'ok']);
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      aiProvider
    });
    servers.push(app);

    const before = await requestJson(`${app.url}/api/state`);
    const checked = await requestJson(`${app.url}/api/ai/status/check`, { method: 'POST' });
    const after = await requestJson(`${app.url}/api/state`);

    expect(before.aiStatus).toMatchObject({
      configured: true,
      provider: 'deepseek',
      health: 'unknown'
    });
    expect(checked.aiStatus).toMatchObject({
      configured: true,
      provider: 'deepseek',
      health: 'connected'
    });
    expect(checked.aiStatus.lastCheckedAt).toBeTruthy();
    expect(checked.aiStatus.lastLatencyMs).toEqual(expect.any(Number));
    expect(JSON.stringify(checked)).not.toContain('sk-');
    expect(after.aiStatus).toMatchObject({
      configured: true,
      provider: 'deepseek',
      health: 'connected'
    });
    expect(aiProvider.calls.map((call) => call.actorRole)).toEqual(['human_user', 'personal_agent']);
  });

  it('includes DeepSeek cache usage in AI runtime status without exposing secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const aiProvider = createUsageAiProvider({
      requestCount: 3,
      promptTokens: 1000,
      completionTokens: 120,
      totalTokens: 1120,
      promptCacheHitTokens: 750,
      promptCacheMissTokens: 250,
      promptCacheHitRate: 0.75,
      lastUpdatedAt: '2026-05-04T08:00:00.000Z'
    });
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      aiProvider
    });
    servers.push(app);

    const state = await requestJson(`${app.url}/api/state`);

    expect(state.aiStatus.health).toBe('connected');
    expect(state.aiStatus.cache).toMatchObject({
      requestCount: 3,
      promptCacheHitTokens: 750,
      promptCacheMissTokens: 250,
      promptCacheHitRate: 0.75
    });
    expect(JSON.stringify(state)).not.toContain('deepseek-key');
  });

  it('reports failed AI health checks without silently marking the provider connected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      aiProvider: createFailingAiProvider('DeepSeek 401 invalid key')
    });
    servers.push(app);

    const checked = await requestJson(`${app.url}/api/ai/status/check`, { method: 'POST' });
    const state = await requestJson(`${app.url}/api/state`);

    expect(checked.aiStatus).toMatchObject({
      configured: true,
      provider: 'deepseek',
      health: 'failed',
      lastError: 'DeepSeek 401 invalid key'
    });
    expect(state.aiStatus).toMatchObject({
      configured: true,
      provider: 'deepseek',
      health: 'failed',
      lastError: 'DeepSeek 401 invalid key'
    });
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

  it('allows writes from the Vite fallback dev port by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null
    });
    servers.push(app);

    const allowed = await fetch(`${app.url}/api/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:5176'
      },
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-lin',
        body: 'write from vite fallback dev port'
      })
    });

    expect(allowed.status).toBe(201);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5176');
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

  it('streams Agent run progress events while an Agent request is executing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null });
    servers.push(app);

    const progress = await collectSseEvents<{ phase: string; roomId: string; label: string }>(
      `${app.url}/api/events`,
      'agent-progress',
      async () => {
        await requestJson(`${app.url}/api/agent/run`, {
          method: 'POST',
          body: JSON.stringify({
            agentId: 'agent-lin',
            roomId: 'room-team',
            userText: '谁负责访谈材料？'
          })
        });
      },
      8
    );

    expect(progress.at(0)?.phase).toBe('started');
    expect(progress.at(-1)?.phase).toBe('completed');
    expect(progress.every((event) => event.roomId === 'room-team')).toBe(true);
    expect(progress.map((event) => event.label)).toEqual(
      expect.arrayContaining([
        '收到 Agent 请求',
        '校验 Agent 权限',
        '构建授权上下文',
        '规划 Agent 动作',
        '执行工具：chat.answer',
        '写入 Agent 记忆',
        '写入运行日志'
      ])
    );
  });

  it('streams concrete read/write steps for deadline tool runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null });
    servers.push(app);

    const progress = await collectSseEvents<{ phase: string; label: string; detail?: string; toolCalls: string[] }>(
      `${app.url}/api/events`,
      'agent-progress',
      async () => {
        await requestJson(`${app.url}/api/agent/run`, {
          method: 'POST',
          body: JSON.stringify({
            agentId: 'agent-lin',
            roomId: 'room-team',
            userText: 'deadline 是？'
          })
        });
      },
      9
    );

    expect(progress.map((event) => event.label)).toEqual(
      expect.arrayContaining([
        '执行工具：deadline.answer',
        '检索截止信息',
        '写入 Agent 记忆',
        '写入运行日志'
      ])
    );
    expect(progress.find((event) => event.label === '检索截止信息')?.toolCalls).toContain('deadline.answer');
    expect(progress.at(-1)?.phase).toBe('completed');
  });

  it('streams progress events while confirming a queued coordination action', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const state = createDemoState();
    await writeFile(
      dbPath,
      JSON.stringify(
        {
          ...state,
          actionRequests: [
            {
              id: 'action-calendar-confirm',
              agentId: 'agent-lin',
              roomId: 'room-team',
              kind: 'coordinate',
              status: 'needs_confirmation',
              input: {
                proposal: 'Move the final review to Wednesday 23:00.',
                calendarPatch: {
                  itemId: 'cal-review',
                  oldStartsAt: '2026-05-05T20:30:00+08:00',
                  newStartsAt: '2026-05-06T23:00:00+08:00',
                  title: 'Final draft review'
                }
              },
              risk: {
                level: 'high',
                score: 0.9,
                reason: 'Needs human approval before changing calendar data.',
                model: 'test'
              },
              createdAt: '2026-05-04T08:00:00.000Z',
              updatedAt: '2026-05-04T08:00:00.000Z',
              requiresHuman: true
            }
          ]
        },
        null,
        2
      ),
      'utf8'
    );
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null });
    servers.push(app);

    const progress = await collectSseEvents<{ phase: string; label: string; toolCalls: string[] }>(
      `${app.url}/api/events`,
      'agent-progress',
      async () => {
        await requestJson(`${app.url}/api/agent/actions/action-calendar-confirm/confirm`, {
          method: 'POST',
          body: JSON.stringify({
            reviewerId: 'user-lin',
            reason: 'Approved in UI'
          })
        });
      },
      5
    );

    expect(progress.map((event) => event.label)).toEqual(
      expect.arrayContaining(['收到确认请求', '应用日程变更', '写入审计日志', '完成确认动作'])
    );
    expect(progress.find((event) => event.label === '应用日程变更')?.toolCalls).toContain('calendar.update');
    expect(progress.at(-1)?.phase).toBe('completed');
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

async function collectSseEvents<T>(
  url: string,
  eventName: string,
  action: () => Promise<void>,
  expectedCount: number
): Promise<T[]> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  expect(response.ok).toBe(true);
  expect(response.body).toBeTruthy();

  const events: T[] = [];
  const reader = response.body!.getReader();
  const readLoop = readSseStream(reader, eventName, events);

  await action();
  const deadline = Date.now() + 1500;
  while (events.length < expectedCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  controller.abort();
  await readLoop.catch(() => undefined);
  return events;
}

async function readSseStream<T>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  eventName: string,
  events: T[]
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const read = await reader.read();
    if (read.done) {
      return;
    }
    buffer += decoder.decode(read.value, { stream: true });
    let splitIndex = buffer.indexOf('\n\n');
    while (splitIndex >= 0) {
      const rawEvent = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      const parsed = parseSseEvent(rawEvent);
      if (parsed.event === eventName && parsed.data) {
        events.push(JSON.parse(parsed.data) as T);
      }
      splitIndex = buffer.indexOf('\n\n');
    }
  }
}

function parseSseEvent(rawEvent: string): { event?: string; data?: string } {
  const parsed: { event?: string; data?: string } = {};
  for (const line of rawEvent.split('\n')) {
    if (line.startsWith('event: ')) {
      parsed.event = line.slice('event: '.length);
    }
    if (line.startsWith('data: ')) {
      parsed.data = line.slice('data: '.length);
    }
  }
  return parsed;
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

function createRecordingAiProvider(texts: string[]): AiProvider & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  let index = 0;
  return {
    calls,
    async generateText(prompt) {
      calls.push(prompt as unknown as Record<string, unknown>);
      const text = texts[index] ?? texts[texts.length - 1] ?? 'ok';
      index += 1;
      return text;
    }
  };
}

function createUsageAiProvider(snapshot: AiUsageSnapshot): AiProvider & { getUsageSnapshot(): AiUsageSnapshot } {
  return {
    async generateText() {
      return 'ok';
    },
    getUsageSnapshot() {
      return snapshot;
    }
  };
}

function createFailingAiProvider(message: string): AiProvider {
  return {
    async generateText() {
      throw new Error(message);
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
