import { describe, expect, it, vi } from 'vitest';
import {
  askDeadline,
  checkAiStatus,
  confirmAgentAction,
  createStateEventSource,
  downloadFile,
  generateDemoAssets,
  fetchState,
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

  it('downloads encoded files and returns response metadata', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('report body', {
        headers: {
          'content-disposition': 'attachment; filename="report.txt"',
          'content-type': 'text/plain'
        }
      })
    );

    const downloaded = await downloadFile('/api-root/', 'file uploaded/report', fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api-root/api/files/file%20uploaded%2Freport/download',
      expect.objectContaining({ method: 'GET' })
    );
    expect(downloaded.filename).toBe('report.txt');
    expect(downloaded.contentType).toBe('text/plain');
    expect(await readBlobAsText(downloaded.blob)).toBe('report body');
  });

  it('adds the configured API token header to browser-only GET requests without URL tokens', async () => {
    vi.stubEnv('VITE_AGENT_API_TOKEN', 'local-secret');
    vi.resetModules();
    const { createStateEventSource: createStateEventSourceWithToken, downloadFile: downloadFileWithToken } =
      await import('./apiClient');
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/api/events')) {
        return new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }), {
          headers: { 'content-type': 'text/event-stream' }
        });
      }
      return new Response('report body');
    });

    await downloadFileWithToken('/api-root/', 'file uploaded/report', fetchMock);
    const events = createStateEventSourceWithToken('/api-root/', fetchMock);
    await events.ready;
    events.close();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api-root/api/files/file%20uploaded%2Freport/download',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-agent-im-token': 'local-secret'
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api-root/api/events',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-agent-im-token': 'local-secret'
        })
      })
    );
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain('agent_im_token');
    }
    vi.unstubAllEnvs();
  });

  it('parses fetch-based SSE frames and supports close', async () => {
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: ready\ndata: {"ok":true}\n\n'));
        controller.enqueue(encoder.encode('event: state\ndata: {"rooms":[]}\n\n'));
        controller.close();
      }
    });
    const fetchMock = vi.fn(async () => new Response(streamBody, { headers: { 'content-type': 'text/event-stream' } }));
    const received: Array<{ type: string; data: string }> = [];
    let resolveReceived!: () => void;
    const receivedAllEvents = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    const recordEvent = (event: { type: string; data: string }) => {
      received.push({ type: event.type, data: event.data });
      if (received.length === 2) {
        resolveReceived();
      }
    };

    const events = createStateEventSource('/api-root/', fetchMock);
    events.addEventListener('ready', recordEvent);
    events.addEventListener('state', recordEvent);
    await events.ready;
    await receivedAllEvents;
    events.close();

    expect(received).toEqual([
      { type: 'ready', data: '{"ok":true}' },
      { type: 'state', data: '{"rooms":[]}' }
    ]);
  });

  it('dispatches an error when an established SSE stream ends without close', async () => {
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: ready\ndata: {"ok":true}\n\n'));
        controller.close();
      }
    });
    const fetchMock = vi.fn(async () => new Response(streamBody, { headers: { 'content-type': 'text/event-stream' } }));
    const errors: Array<{ type: string; data: string }> = [];

    const events = createStateEventSource('/api-root/', fetchMock);
    events.addEventListener('error', (event) => errors.push({ type: event.type, data: event.data }));
    await events.ready;

    await vi.waitFor(() => {
      expect(errors).toEqual([{ type: 'error', data: 'Event stream disconnected' }]);
    });
    events.close();
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

function readBlobAsText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Unable to read blob')));
    reader.readAsText(blob);
  });
}
