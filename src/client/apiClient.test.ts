import { describe, expect, it, vi } from 'vitest';
import {
  askDeadline,
  checkAiStatus,
  confirmAgentAction,
  createStateEventSource,
  generateDemoAssets,
  fetchState,
  fileDownloadUrl,
  getAutopilotWorkerStatus,
  humanReply,
  listAgentActions,
  listMemories,
  rejectAgentAction,
  runAgent,
  runAutopilotWorkerOnce,
  sendMessage,
  shareFile,
  runPendingAutopilot,
  syncMatrixOnce,
  updateAutopilotPolicy
} from './apiClient';

describe('api client', () => {
  it('adds the configured API token header to write requests', async () => {
    vi.stubEnv('VITE_AGENT_API_TOKEN', 'local-secret');
    vi.resetModules();
    const { sendMessage: sendMessageWithToken } = await import('./apiClient');
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return Response.json({ ok: true, body });
    });

    await sendMessageWithToken('/api-root', { roomId: 'room-team', senderId: 'user-lin', body: 'hello' }, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api-root/api/messages',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-agent-im-token': 'local-secret'
        })
      })
    );
    vi.unstubAllEnvs();
  });

  it('uses the real backend endpoints for state, messages, and agent actions', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return Response.json({ ok: true, body });
    });

    await fetchState('/api-root', fetchMock);
    await sendMessage('/api-root', { roomId: 'room-team', senderId: 'user-lin', body: 'hello' }, fetchMock);
    await askDeadline(
      '/api-root',
      { agentId: 'agent-lin', roomId: 'room-class', question: '什么时候截止？' },
      fetchMock
    );
    await shareFile(
      '/api-root',
      {
        agentId: 'agent-lin',
        roomId: 'room-team',
        requesterId: 'user-chen',
        requestText: '发一下最新版'
      },
      fetchMock
    );

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api-root/api/state', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api-root/api/messages',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api-root/api/agent/deadline',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      '/api-root/api/agent/share-file',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('builds encoded file download URLs', () => {
    expect(fileDownloadUrl('/api-root/', 'file uploaded/report')).toBe(
      '/api-root/api/files/file%20uploaded%2Freport/download'
    );
  });

  it('adds the configured API token to browser-only GET URLs', async () => {
    vi.stubEnv('VITE_AGENT_API_TOKEN', 'local-secret');
    vi.resetModules();
    const { createStateEventSource: createStateEventSourceWithToken, fileDownloadUrl: fileDownloadUrlWithToken } =
      await import('./apiClient');
    const created: string[] = [];
    vi.stubGlobal(
      'EventSource',
      class {
        constructor(url: string) {
          created.push(url);
        }
      }
    );

    fileDownloadUrlWithToken('/api-root/', 'file uploaded/report');
    createStateEventSourceWithToken('/api-root/');

    expect(fileDownloadUrlWithToken('/api-root/', 'file uploaded/report')).toBe(
      '/api-root/api/files/file%20uploaded%2Freport/download?agent_im_token=local-secret'
    );
    expect(created).toEqual(['/api-root/api/events?agent_im_token=local-secret']);

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('surfaces backend error messages to the UI', async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: 'AI provider is not configured' }, { status: 503 }));

    await expect(humanReply('/api-root', { roomId: 'room-team', userId: 'user-chen' }, fetchMock)).rejects.toThrow(
      'AI provider is not configured'
    );
  });

  it('uses confirmation queue endpoints', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return Response.json({ ok: true, body });
    });

    await listAgentActions('/api-root', fetchMock);
    await confirmAgentAction(
      '/api-root',
      { actionId: 'action-1', reviewerId: 'user-lin', reason: 'approved' },
      fetchMock
    );
    await rejectAgentAction(
      '/api-root',
      { actionId: 'action-2', reviewerId: 'user-lin', reason: 'rejected' },
      fetchMock
    );

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api-root/api/agent/actions', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api-root/api/agent/actions/action-1/confirm',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api-root/api/agent/actions/action-2/reject',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('uses runtime upgrade endpoints', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return Response.json({ ok: true, body });
    });

    await humanReply('/api-root', { roomId: 'room-team', userId: 'user-chen', prompt: 'reply' }, fetchMock);
    await runAgent(
      '/api-root',
      { agentId: 'agent-lin', roomId: 'room-team', intent: 'find_file', userText: '行动计划' },
      fetchMock
    );
    await listMemories('/api-root', 'agent-lin', fetchMock);
    await generateDemoAssets('/api-root', { roomId: 'room-team', senderId: 'user-lin' }, fetchMock);
    await syncMatrixOnce('/api-root', fetchMock);
    await checkAiStatus('/api-root', fetchMock);
    await updateAutopilotPolicy(
      '/api-root',
      { agentId: 'agent-lin', roomId: 'room-team', roomEnabled: false },
      fetchMock
    );
    await runPendingAutopilot('/api-root', { roomId: 'room-team', limit: 10 }, fetchMock);
    await getAutopilotWorkerStatus('/api-root', fetchMock);
    await runAutopilotWorkerOnce('/api-root', fetchMock);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api-root/api/ai/human-reply',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api-root/api/agent/run',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api-root/api/memories?agentId=agent-lin', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      '/api-root/api/demo/assets/generate',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      '/api-root/api/matrix/sync-once',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      '/api-root/api/ai/status/check',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      7,
      '/api-root/api/agent/autopilot-policy',
      expect.objectContaining({ method: 'PATCH' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      8,
      '/api-root/api/agent/autopilot/run-pending',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(9, '/api-root/api/agent/autopilot/worker', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(
      10,
      '/api-root/api/agent/autopilot/worker/run',
      expect.objectContaining({ method: 'POST' })
    );
  });
});
