import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { createDemoState } from './domain/demoState';
import type { AgentRunResult } from './domain/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  askDeadline: vi.fn(),
  checkAiStatus: vi.fn(),
  confirmAgentAction: vi.fn(),
  coordinate: vi.fn(),
  createStateEventSource: vi.fn(),
  downloadFile: vi.fn(),
  fetchState: vi.fn(),
  getAutopilotWorkerStatus: vi.fn(),
  generateDemoAssets: vi.fn(),
  humanReply: vi.fn(),
  runAgent: vi.fn(),
  runAutopilotWorkerOnce: vi.fn(),
  sendMessage: vi.fn(),
  shareFile: vi.fn(),
  summarize: vi.fn(),
  syncMatrixOnce: vi.fn(),
  rejectAgentAction: vi.fn(),
  runPendingAutopilot: vi.fn(),
  updateAutopilotPolicy: vi.fn(),
  uploadFile: vi.fn()
}));

vi.mock('./client/apiClient', () => apiMocks);

describe('App runtime upgrade controls', () => {
  let host: HTMLDivElement;
  let root: Root;
  let eventListeners: Record<string, (event: { type: string; data: string }) => void>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    eventListeners = {};
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.getAutopilotWorkerStatus.mockResolvedValue({ worker: createAutopilotWorkerStatus() });
    apiMocks.runAutopilotWorkerOnce.mockResolvedValue({
      worker: createAutopilotWorkerStatus({ runCount: 1 }),
      processedMessageIds: [],
      skippedMessageIds: [],
      sessions: [],
      messages: [],
      logs: []
    });
    apiMocks.downloadFile.mockResolvedValue({
      blob: new Blob(['download body'], { type: 'text/plain' }),
      filename: 'download.txt',
      contentType: 'text/plain'
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:agentbridge-download')
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn()
    });
    apiMocks.createStateEventSource.mockReturnValue({
      ready: Promise.resolve(),
      addEventListener: vi.fn((eventName: string, listener: (event: { type: string; data: string }) => void) => {
        eventListeners[eventName] = listener;
      }),
      removeEventListener: vi.fn((eventName: string, listener: (event: { type: string; data: string }) => void) => {
        if (eventListeners[eventName] === listener) {
          delete eventListeners[eventName];
        }
      }),
      close: vi.fn()
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('renders only working runtime controls and real room context', async () => {
    await act(async () => {
      root.render(<App />);
    });

    expect(host.textContent).toContain('聊天');
    expect(host.querySelector('input[aria-label="search rooms"]')).toBeTruthy();
    expect(host.textContent).toContain('Agent 找文件');
    expect(host.textContent).toContain('请求代发');
    expect(host.textContent).toContain('陈晨');
    expect(host.textContent).not.toContain('从当前对话中提取的任务');
    expect(host.textContent).not.toContain('让陈晨回复');
    expect(host.textContent).not.toContain('让赵一鸣回复');
    expect(host.textContent).not.toContain('判断依据');
    expect(host.textContent).not.toContain('运行记录');
    expect(host.textContent).not.toContain('自动回复状态');
    expect(host.textContent).not.toContain('系统状态');
    expect(host.textContent).not.toContain('生成真实文件');
    expect(host.textContent).not.toContain('同步 Matrix');
    expect(host.textContent).not.toContain('结构化记忆');
    expect(host.textContent).not.toContain('Agent 设置');
  });

  it('keeps room intelligence panels collapsed until their top tabs are clicked', async () => {
    await act(async () => {
      root.render(<App />);
    });

    expect(host.textContent).not.toContain('最近来源');
    expect(host.textContent).not.toContain('可用文件');

    const taskTab = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('任务'));
    expect(taskTab).toBeTruthy();
    await act(async () => {
      taskTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.textContent).toContain('从当前对话中提取的任务');
    expect(host.textContent).toContain('最近来源');

    const fileTab = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('文件'));
    expect(fileTab).toBeTruthy();
    await act(async () => {
      fileTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.textContent).toContain('可用文件');
    expect(host.textContent).not.toContain('从当前对话中提取的任务');
  });

  it('downloads files without entering global busy state or refreshing state', async () => {
    vi.useFakeTimers();
    const state = createDemoState();
    const downloadableFile = state.files.find((file) => file.roomId === 'room-team')!;
    downloadableFile.localPath = 'uploads/report.txt';
    apiMocks.fetchState.mockResolvedValue(state);
    let resolveDownload!: (file: { blob: Blob; filename: string; contentType: string }) => void;
    apiMocks.downloadFile.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDownload = resolve;
      })
    );
    const linkClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await act(async () => {
      root.render(<App />);
    });
    apiMocks.fetchState.mockClear();

    const fileTab = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('文件'));
    expect(fileTab).toBeTruthy();
    await act(async () => {
      fileTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const downloadLink = host.querySelector<HTMLAnchorElement>('a[aria-label^="download "]');
    expect(downloadLink).toBeTruthy();

    await act(async () => {
      downloadLink!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiMocks.downloadFile).toHaveBeenCalledWith('', downloadableFile.id);
    expect(apiMocks.fetchState).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('download-file');

    await act(async () => {
      resolveDownload({
        blob: new Blob(['download body'], { type: 'text/plain' }),
        filename: 'report.txt',
        contentType: 'text/plain'
      });
      await Promise.resolve();
    });
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(linkClick).toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:agentbridge-download');
  });

  it('keeps room filter counts based on all rooms after switching filters', async () => {
    await act(async () => {
      root.render(<App />);
    });

    const directTab = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('私聊 1'));
    expect(directTab).toBeTruthy();

    await act(async () => {
      directTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('群聊 2');
    expect(host.textContent).toContain('私聊 1');
    expect(host.textContent).not.toContain('群聊 0');
  });

  it('keeps both chat and Agent composers in bottom dock positions', async () => {
    await act(async () => {
      root.render(<App />);
    });

    const chatComposer = host.querySelector('.chat-panel > .composer input[aria-label="chat composer"]');
    expect(chatComposer).toBeTruthy();

    const workbenchChildren = [...host.querySelector('.agent-workbench')!.children];
    const outputIndex = workbenchChildren.findIndex((node) => node.classList.contains('agent-output-area'));
    const dockIndex = workbenchChildren.findIndex((node) => node.classList.contains('agent-dock'));
    expect(outputIndex).toBeGreaterThan(-1);
    expect(dockIndex).toBeGreaterThan(outputIndex);
    expect(host.querySelector('.agent-dock .agent-query #agent-prompt')).toBeTruthy();
    expect(host.querySelector('.agent-dock .action-grid')).toBeTruthy();
  });

  it('renders the global AI connection status from server state', async () => {
    const state = {
      ...createDemoState(),
      aiStatus: {
        configured: true,
        provider: 'deepseek' as const,
        health: 'connected' as const,
        agentModel: 'deepseek-chat',
        humanModel: 'deepseek-chat',
        baseUrlHost: 'api.deepseek.com',
        cache: {
          requestCount: 3,
          promptCacheHitTokens: 750,
          promptCacheMissTokens: 250,
          promptCacheHitRate: 0.75
        }
      }
    };
    apiMocks.fetchState.mockResolvedValue(state);

    await act(async () => {
      root.render(<App />);
    });

    expect(host.textContent).toContain('LLM connected');
    expect(host.textContent).toContain('deepseek-chat');
    expect(host.textContent).toContain('cache 75%');
  });

  it('renders real A2A autopilot sessions in the Agent workbench', async () => {
    const state = createDemoState();
    state.a2aSessions = [
      {
        id: 'a2a-session-1',
        roomId: 'room-team',
        initiatorAgentId: 'agent-chen',
        targetAgentIds: ['agent-lin'],
        goal: 'Chen asked Lin Agent to send the latest slides.',
        status: 'completed',
        turns: [
          {
            id: 'a2a-turn-1',
            agentId: 'agent-lin',
            kind: 'tool_result',
            message: 'Delivered file-slides-v3 to the room.',
            toolCalls: ['file.share'],
            createdAt: '2026-05-04T08:04:00.000Z'
          }
        ],
        proposedActionRequestIds: [],
        contextIds: ['msg-03', 'file-slides-v3'],
        risk: {
          level: 'low',
          score: 0.18,
          reason: 'Authorized room file handoff.',
          model: 'runtime-confirmation-gate-v1'
        },
        createdAt: '2026-05-04T08:04:00.000Z',
        updatedAt: '2026-05-04T08:04:00.000Z'
      }
    ];
    apiMocks.fetchState.mockResolvedValue(state);

    await act(async () => {
      root.render(<App />);
    });

    expect(host.querySelector('[data-testid="a2a-session-panel"]')).toBeTruthy();
    expect(host.querySelector('.autopilot-policy.enabled')).toBeTruthy();
    expect(host.textContent).toContain('Chen asked Lin Agent to send the latest slides.');
    expect(host.textContent).toContain('Delivered file-slides-v3 to the room.');
    expect(host.textContent).toContain('low');
  });

  it('toggles current-room Agent autopilot from the workbench', async () => {
    const initial = createDemoState();
    const updated = {
      ...initial,
      agentAutopilotPolicies: initial.agentAutopilotPolicies.map((policy) =>
        policy.agentId === 'agent-lin'
          ? {
              ...policy,
              enabled: false,
              allowedRoomIds: []
            }
          : policy
      )
    };
    apiMocks.fetchState.mockResolvedValueOnce(initial).mockResolvedValueOnce(updated);
    apiMocks.updateAutopilotPolicy.mockResolvedValue({
      policy: updated.agentAutopilotPolicies.find((policy) => policy.agentId === 'agent-lin')
    });

    await act(async () => {
      root.render(<App />);
    });

    const toggle = host.querySelector<HTMLButtonElement>('.autopilot-policy button');
    expect(toggle).toBeTruthy();

    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(apiMocks.updateAutopilotPolicy).toHaveBeenCalledWith('', {
      agentId: 'agent-lin',
      enabled: false,
      roomId: 'room-team',
      roomEnabled: false
    });
    expect(host.querySelector('.autopilot-policy.disabled')).toBeTruthy();
  });

  it('runs the autopilot worker from the workbench', async () => {
    const initial = createDemoState();
    const updated = {
      ...initial,
      a2aSessions: [
        {
          id: 'a2a-from-sweep',
          roomId: 'room-team',
          initiatorAgentId: 'agent-chen',
          targetAgentIds: ['agent-lin'],
          goal: 'Backlog handoff',
          status: 'completed',
          turns: [],
          proposedActionRequestIds: [],
          contextIds: ['msg-06'],
          risk: {
            level: 'low',
            score: 0.1,
            reason: 'Backlog sweep',
            model: 'runtime-confirmation-gate-v1'
          },
          createdAt: '2026-05-04T09:00:00.000Z',
          updatedAt: '2026-05-04T09:00:00.000Z'
        }
      ]
    };
    apiMocks.fetchState.mockResolvedValueOnce(initial).mockResolvedValueOnce(updated);
    apiMocks.runAutopilotWorkerOnce.mockResolvedValue({
      worker: createAutopilotWorkerStatus({ runCount: 1, lastProcessedCount: 1 }),
      processedMessageIds: ['msg-06'],
      skippedMessageIds: [],
      sessions: updated.a2aSessions,
      messages: [],
      logs: []
    });

    await act(async () => {
      root.render(<App />);
    });

    const sweep = host.querySelector<HTMLButtonElement>('.autopilot-sweep-button');
    expect(sweep).toBeTruthy();

    await act(async () => {
      sweep!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(apiMocks.runAutopilotWorkerOnce).toHaveBeenCalledWith('');
    expect(host.textContent).toContain('Backlog handoff');
  });

  it('marks the system event stream as disconnected when SSE fails', async () => {
    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      eventListeners.error?.({ type: 'error', data: 'Event stream disconnected' });
    });

    expect(host.textContent).toContain('实时连接已断开');
    expect(host.querySelector('.system-section')).toBeNull();
  });

  it('clears only stale realtime disconnect errors when the SSE stream reconnects', async () => {
    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      eventListeners.error?.({ type: 'error', data: 'Event stream disconnected' });
    });
    expect(host.textContent).toContain('实时连接已断开');

    await act(async () => {
      eventListeners.ready?.({ type: 'ready', data: '{"ok":true}' });
      await waitForMotionExit();
    });
    expect(host.textContent).not.toContain('实时连接已断开');

    apiMocks.runAgent.mockRejectedValueOnce(new Error('operation failed'));
    const deadlineButton = [...host.querySelectorAll('.action-grid button')].find((button) =>
      button.textContent?.includes('问截止')
    );
    expect(deadlineButton).toBeTruthy();
    await act(async () => {
      deadlineButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.textContent).toContain('operation failed');

    await act(async () => {
      eventListeners.ready?.({ type: 'ready', data: '{"ok":true}' });
    });
    expect(host.textContent).toContain('operation failed');
  });

  it('clears stale realtime disconnect errors when a state SSE event arrives', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      eventListeners.error?.({ type: 'error', data: 'Event stream disconnected' });
    });
    expect(host.textContent).toContain('实时连接已断开');

    await act(async () => {
      eventListeners.state?.({ data: JSON.stringify(state) } as MessageEvent);
      await waitForMotionExit();
    });
    expect(host.textContent).not.toContain('实时连接已断开');
  });

  it('keeps the AI connection state compact instead of exposing a status panel', async () => {
    const state = {
      ...createDemoState(),
      aiStatus: {
        configured: true,
        provider: 'deepseek' as const,
        health: 'unknown' as const,
        agentModel: 'deepseek-chat',
        humanModel: 'deepseek-chat',
        baseUrlHost: 'api.deepseek.com'
      }
    };
    apiMocks.fetchState.mockResolvedValue(state);

    await act(async () => {
      root.render(<App />);
    });

    expect(host.textContent).toContain('LLM configured, not checked');
    expect(host.textContent).not.toContain('检查 LLM');
    expect(host.querySelector('.system-section')).toBeNull();
  });

  it('keeps low-level Agent progress events out of the compact workbench', async () => {
    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      eventListeners['agent-progress']?.({
        data: JSON.stringify({
          id: 'progress-1',
          runId: 'run-1',
          sequence: 1,
          agentId: 'agent-lin',
          roomId: 'room-team',
          phase: 'planning',
          label: '规划 Agent 动作',
          detail: '谁负责访谈材料？',
          toolCalls: [],
          createdAt: '2026-05-04T10:00:00.000Z'
        })
      } as MessageEvent);
      eventListeners['agent-progress']?.({
        data: JSON.stringify({
          id: 'progress-0',
          runId: 'run-1',
          sequence: 0,
          agentId: 'agent-lin',
          roomId: 'room-team',
          phase: 'started',
          label: '收到 Agent 请求',
          detail: '谁负责访谈材料？',
          toolCalls: [],
          createdAt: '2026-05-04T10:00:00.000Z'
        })
      } as MessageEvent);
    });

    expect(host.textContent).not.toContain('实时步骤');
    expect(host.textContent).not.toContain('规划 Agent 动作');
    expect(host.textContent).not.toContain('收到 Agent 请求');
  });

  it('does not render a separate runtime progress list in the compact workbench', async () => {
    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      for (const progress of [
        { id: 'progress-search', sequence: 5, label: '检索截止信息' },
        { id: 'progress-memory', sequence: 6, label: '写入 Agent 记忆' }
      ]) {
        eventListeners['agent-progress']?.({
          data: JSON.stringify({
            ...progress,
            runId: 'run-seq',
            agentId: 'agent-lin',
            roomId: 'room-team',
            phase: 'executing',
            detail: '同一毫秒',
            toolCalls: [],
            createdAt: '2026-05-04T10:00:00.000Z'
          })
        } as MessageEvent);
      }
    });

    expect(host.textContent).not.toContain('检索截止信息');
    expect(host.textContent).not.toContain('写入 Agent 记忆');
  });

  it('does not render a separate evidence panel in the compact workbench', async () => {
    const state = createDemoState();
    state.memories = Array.from({ length: 7 }, (_, index) => ({
      id: `memory-overload-${index}`,
      ownerAgentId: 'agent-lin',
      scopeRoomIds: ['room-team'],
      kind: 'note' as const,
      content: `memory content ${index}`,
      sourceIds: [],
      createdAt: '2026-05-04T10:00:00.000Z',
      updatedAt: '2026-05-04T10:00:00.000Z'
    }));
    state.actionLogs = [
      {
        id: 'log-many-contexts',
        agentId: 'agent-lin',
        roomId: 'room-team',
        action: 'agent_run:deadline:test',
        status: 'executed',
        risk: {
          level: 'low',
          score: 0.1,
          reason: 'test',
          model: 'test'
        },
        contextIds: state.memories.map((memory) => memory.id),
        toolCalls: ['deadline.answer'],
        createdAt: '2026-05-04T10:00:00.000Z'
      }
    ];
    apiMocks.fetchState.mockResolvedValue(state);

    await act(async () => {
      root.render(<App />);
    });

    expect(host.querySelector('.evidence-list')).toBeNull();
    expect(host.textContent).not.toContain('判断依据');
  });

  it('uses action-specific prompts for all workbench shortcuts', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult());

    await act(async () => {
      root.render(<App />);
    });

    const actionButtons = [...host.querySelectorAll<HTMLButtonElement>('.action-grid button')];
    const summaryButton = actionButtons.find((button) => button.textContent?.includes('总结群聊'));
    const deadlineButton = actionButtons.find((button) => button.textContent?.includes('问截止'));
    const findFileButton = actionButtons.find((button) => button.textContent?.includes('Agent 找文件'));
    const fileShareButton = actionButtons.find((button) => button.textContent?.includes('请求代发'));
    const coordinateButton = actionButtons.find((button) => button.textContent?.includes('Agent 协调'));
    expect(summaryButton).toBeTruthy();
    expect(deadlineButton).toBeTruthy();
    expect(findFileButton).toBeTruthy();
    expect(fileShareButton).toBeTruthy();
    expect(coordinateButton).toBeTruthy();

    await act(async () => {
      summaryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      deadlineButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      findFileButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      fileShareButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      coordinateButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(apiMocks.runAgent).toHaveBeenNthCalledWith(1, '', {
      agentId: 'agent-lin',
      roomId: 'room-team',
      intent: 'summary',
      userText: '总结当前群聊：列出关键结论、已确认事项、待办、风险和下一步。'
    });
    expect(apiMocks.runAgent).toHaveBeenNthCalledWith(2, '', {
      agentId: 'agent-lin',
      roomId: 'room-team',
      intent: 'deadline',
      userText: '只根据当前聊天、任务和日程回答：这次作业什么时候截止？还有哪些临近时间点？'
    });
    expect(apiMocks.runAgent).toHaveBeenNthCalledWith(3, '', {
      agentId: 'agent-lin',
      roomId: 'room-team',
      intent: 'find_file',
      userText: '在当前聊天可用文件里查找最新行动计划、演示稿、证据包或引用材料，列出文件名和用途。'
    });
    expect(apiMocks.runAgent).toHaveBeenNthCalledWith(4, '', {
      agentId: 'agent-lin',
      roomId: 'room-team',
      intent: 'share_file',
      userText: '把最新行动计划发给陈晨'
    });
    expect(apiMocks.runAgent).toHaveBeenNthCalledWith(5, '', {
      agentId: 'agent-lin',
      roomId: 'room-team',
      intent: 'coordinate',
      userText: '把周二 20:30 的合稿检查改到周三 23:00，并确认大家是否同意。'
    });
    expect(apiMocks.runAgent.mock.calls.map(([, body]) => body.userText)).not.toContain('这次作业什么时候截止？');
  });

  it('keeps other Agent shortcuts clickable while one shortcut is running', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    let resolveSummary!: (result: AgentRunResult) => void;
    apiMocks.runAgent
      .mockImplementationOnce(
        () =>
          new Promise<AgentRunResult>((resolve) => {
            resolveSummary = resolve;
          })
      )
      .mockResolvedValueOnce(createAgentRunResult({ intent: 'deadline' }));

    await act(async () => {
      root.render(<App />);
    });

    const actionButtons = [...host.querySelectorAll<HTMLButtonElement>('.action-grid button')];
    const summaryButton = actionButtons.find((button) => button.textContent?.includes('总结群聊'));
    const deadlineButton = actionButtons.find((button) => button.textContent?.includes('问截止'));
    expect(summaryButton).toBeTruthy();
    expect(deadlineButton).toBeTruthy();

    await act(async () => {
      summaryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(summaryButton!.disabled).toBe(true);
    expect(deadlineButton!.disabled).toBe(false);

    await act(async () => {
      deadlineButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiMocks.runAgent).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSummary(createAgentRunResult({ intent: 'summary' }));
      await Promise.resolve();
    });
  });

  it('keeps Agent planner text compact instead of rendering raw thinking', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    const longPlan = Array.from(
      { length: 18 },
      (_, index) => `item ${index + 1}: current room still has tasks, files, and schedule follow-up.`
    ).join(' ');
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult({ plan: longPlan }));

    await act(async () => {
      root.render(<App />);
    });

    const summaryButton = [...host.querySelectorAll<HTMLButtonElement>('.action-grid button')].find((button) =>
      button.textContent?.includes('总结群聊')
    );
    expect(summaryButton).toBeTruthy();
    await act(async () => {
      summaryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const planLine = host.querySelector('.agent-thought');
    expect(planLine).toBeTruthy();
    expect(planLine!.textContent).toContain('\u5904\u7406\u65b9\u5f0f');
    expect(planLine!.textContent).not.toContain('\u601d\u8003\u8fc7\u7a0b');
    expect(planLine!.textContent).not.toContain('item 18');
    expect(planLine!.textContent!.length).toBeLessThan(180);
  });

  it('renders pending Agent actions and lets the current user confirm them', async () => {
    const state = createDemoState();
    state.actionRequests = [
      {
        id: 'action-review-1',
        agentId: 'agent-lin',
        roomId: 'room-team',
        kind: 'share_file',
        status: 'needs_confirmation',
        input: {
          requesterId: 'user-chen',
          requestText: '请把文件发一下'
        },
        risk: {
          level: 'medium',
          score: 0.48,
          reason: '请求意图不够明确，建议确认后执行。',
          model: 'risk-mini-v1'
        },
        createdAt: '2026-05-04T08:00:00.000Z',
        updatedAt: '2026-05-04T08:00:00.000Z',
        requiresHuman: true
      }
    ];
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.confirmAgentAction.mockResolvedValue({
      action: {
        ...state.actionRequests[0],
        status: 'executed',
        requiresHuman: false,
        logId: 'log-confirm'
      },
      log: {
        id: 'log-confirm',
        agentId: 'agent-lin',
        roomId: 'room-team',
        action: 'confirm_action:action-review-1',
        status: 'executed',
        risk: state.actionRequests[0].risk,
        contextIds: ['action-review-1', 'user-lin'],
        toolCalls: ['agent_action.confirm'],
        createdAt: '2026-05-04T08:01:00.000Z'
      }
    });

    await act(async () => {
      root.render(<App />);
    });

    expect(host.textContent).toContain('待确认动作');
    expect(host.textContent).toContain('请求意图不够明确');

    const confirmButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('确认')
    );
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(apiMocks.confirmAgentAction).toHaveBeenCalledWith('', {
      actionId: 'action-review-1',
      reviewerId: 'user-lin',
      reason: '用户在 Agent 工作台确认'
    });
  });

  it('renders only current Agent confirmation actions for the current room', async () => {
    const state = createDemoState();
    const baseAction = {
      agentId: 'agent-lin',
      roomId: 'room-team',
      kind: 'share_file' as const,
      status: 'needs_confirmation' as const,
      input: {},
      risk: {
        level: 'medium' as const,
        score: 0.48,
        reason: 'visible confirmation',
        model: 'risk-mini-v1'
      },
      createdAt: '2026-05-04T08:00:00.000Z',
      updatedAt: '2026-05-04T08:00:00.000Z',
      requiresHuman: true
    };
    state.actionRequests = [
      {
        ...baseAction,
        id: 'visible-action',
        input: { requestText: 'visible action' }
      },
      {
        ...baseAction,
        id: 'pending-action',
        status: 'pending',
        input: { requestText: 'hidden pending action' }
      },
      {
        ...baseAction,
        id: 'other-agent-action',
        agentId: 'agent-chen',
        input: { requestText: 'hidden other agent action' }
      },
      {
        ...baseAction,
        id: 'other-room-action',
        roomId: 'room-class',
        input: { requestText: 'hidden other room action' }
      },
      {
        ...baseAction,
        id: 'no-human-action',
        requiresHuman: false,
        input: { requestText: 'hidden no human action' }
      }
    ];
    apiMocks.fetchState.mockResolvedValue(state);

    await act(async () => {
      root.render(<App />);
    });

    expect(host.textContent).toContain('visible action');
    expect(host.textContent).toContain('visible confirmation');
    expect(host.textContent).not.toContain('hidden pending action');
    expect(host.textContent).not.toContain('hidden other agent action');
    expect(host.textContent).not.toContain('hidden other room action');
    expect(host.textContent).not.toContain('hidden no human action');
  });

  it('renders Agent citations as readable source labels', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue({
      intent: 'deadline',
      requiresHuman: false,
      result: {
        answer: '截止时间是 5月12日 23:59。',
        citations: ['msg-02', 'file-brief']
      },
      log: {
        id: 'log-deadline',
        agentId: 'agent-lin',
        roomId: 'room-team',
        action: 'agent_run:deadline:这次作业什么时候截止？',
        status: 'executed',
        risk: {
          level: 'low',
          score: 0.12,
          reason: '只读检索授权房间、文件和结构化记忆。',
          model: 'risk-mini-v1'
        },
        contextIds: ['msg-02', 'file-brief'],
        toolCalls: ['room_search', 'file_library.search'],
        createdAt: '2026-05-04T08:02:00.000Z'
      }
    });

    await act(async () => {
      root.render(<App />);
    });
    const deadlineButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('问截止')
    );

    await act(async () => {
      deadlineButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('王老师 09:15 的消息');
    expect(host.textContent).toContain('信息系统课程作业要求.pdf');
    expect(host.textContent).not.toContain('msg-02');
  });

  it('submits the Agent input as free chat and renders the chat reply', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue({
      intent: 'chat',
      requiresHuman: false,
      plan: 'Answer from room context.',
      result: {
        reply: 'This room is coordinating the assignment handoff.'
      },
      log: {
        id: 'log-chat',
        agentId: 'agent-lin',
        roomId: 'room-team',
        action: 'agent_run:chat',
        status: 'executed',
        risk: {
          level: 'low',
          score: 0.12,
          reason: 'Read-only chat response.',
          model: 'llm-router-v1'
        },
        contextIds: [],
        toolCalls: ['deepseek.pro.chat.completions'],
        createdAt: '2026-05-04T08:03:00.000Z'
      }
    });

    await act(async () => {
      root.render(<App />);
    });

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    expect(prompt).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, 'What is this room about?');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(sendButton).toBeTruthy();
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(apiMocks.runAgent).toHaveBeenCalledWith('', {
      agentId: 'agent-lin',
      roomId: 'room-team',
      userText: 'What is this room about?'
    });
    expect(host.textContent).toContain('处理方式');
    expect(host.textContent).not.toContain('思考过程');
    expect(host.textContent).toContain('最终回答');
    expect(host.textContent).toContain('This room is coordinating the assignment handoff.');
    expect(host.textContent).toContain('Answer from room context.');
  });

  it('submits Agent commands from natural language without visible target controls', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult());

    await act(async () => {
      root.render(<App />);
    });

    expect(host.querySelector('.agent-command-controls')).toBeNull();
    expect(host.textContent).not.toContain('目标房间');
    expect(host.textContent).not.toContain('目标成员');
    expect(host.textContent).not.toContain('指定文件');

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    expect(prompt).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, '告诉陈晨：我晚点发演示稿');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(apiMocks.runAgent).toHaveBeenCalledWith('', {
      agentId: 'agent-lin',
      roomId: 'room-team',
      intent: 'send_message',
      userText: '告诉陈晨：我晚点发演示稿',
      messageBody: '我晚点发演示稿'
    });
  });
});

function createAutopilotWorkerStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    running: false,
    intervalMs: 60_000,
    roomIds: [],
    limit: 20,
    runCount: 0,
    lastProcessedCount: 0,
    lastSkippedCount: 0,
    ...overrides
  };
}

function createAgentRunResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  const base: AgentRunResult = {
    intent: 'chat',
    requiresHuman: false,
    result: {
      reply: 'ok'
    },
    log: {
      id: `log-${Math.random()}`,
      agentId: 'agent-lin',
      roomId: 'room-team',
      action: 'agent_run:test',
      status: 'executed',
      risk: {
        level: 'low',
        score: 0.12,
        reason: 'test',
        model: 'test'
      },
      contextIds: [],
      toolCalls: [],
      createdAt: '2026-05-04T08:03:00.000Z'
    }
  };
  return {
    ...base,
    ...overrides,
    log: {
      ...base.log,
      ...overrides.log
    }
  };
}

function waitForMotionExit(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 250));
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
}
