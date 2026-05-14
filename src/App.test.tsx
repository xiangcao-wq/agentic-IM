import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { createDemoState } from './domain/demoState';
import type { AgentEvent, AgentRunResult, AgentTrace } from './domain/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  askDeadline: vi.fn(),
  checkAiStatus: vi.fn(),
  confirmAgentAction: vi.fn(),
  coordinate: vi.fn(),
  createStateEventSource: vi.fn(),
  downloadFile: vi.fn(),
  fetchState: vi.fn(),
  getAgentTrace: vi.fn(),
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
    window.localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    eventListeners = {};
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.getAgentTrace.mockResolvedValue(createAgentTrace());
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
    expect(host.querySelector('.agent-workbench')).toBeNull();
    expect(host.querySelector('.agent-console')).toBeNull();
    expect(host.querySelector('.app-shell-im')).toBeTruthy();
    expect(host.textContent).toContain('Agent 操作台');
    expect([...host.querySelectorAll('.action-grid button')].some((button) => button.textContent?.includes('请求代发'))).toBe(false);
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

  it('shows the reviewer guide on first load and keeps a reopen entry', async () => {
    await act(async () => {
      root.render(<App />);
    });

    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    expect(host.textContent).toContain('AgentBridge / A2A 原生聊天');
    expect(host.textContent).toContain('从消息流到 Agent 协作网络');
    expect(host.textContent).toContain('Agent 数量会多于人类用户');
    expect(host.textContent).toContain('聊天仍是入口');
    expect(host.textContent).toContain('A2A 是协作层');
    expect(host.textContent).toContain('风险门控是边界');
    expect(host.textContent).not.toContain('AI 用户');
    expect(host.textContent).not.toContain('演示角色');
    expect(host.textContent).not.toContain('评委');
    expect(host.textContent).toContain('Agent 操作台');
    expect(host.textContent).toContain('触发 A2A 交换约束和提案');
    expect(host.textContent).toContain('这不是内置了 Agent 的 IM');

    const startButton = host.querySelector<HTMLButtonElement>('.review-guide-primary');
    expect(startButton).toBeTruthy();
    await act(async () => {
      startButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitForMotionExit();
    });

    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(window.localStorage.getItem('agentbridge-review-guide-dismissed')).toBe('true');

    const reopenButton = host.querySelector<HTMLButtonElement>('.review-guide-button');
    expect(reopenButton).toBeTruthy();
    await act(async () => {
      reopenButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    expect(host.textContent).toContain('你正在以林雯视角查看');
  });

  it('uses a loading boundary when opening the Agent Console from chat', async () => {
    window.localStorage.setItem('agentbridge-review-guide-dismissed', 'true');
    await act(async () => {
      root.render(<App />);
    });

    const entry = host.querySelector<HTMLButtonElement>('.agent-console-entry');
    expect(entry).toBeTruthy();
    act(() => {
      entry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.querySelector('.agent-console-loading')).toBeTruthy();
    expect(host.textContent).toContain('正在打开 Agent 操作台');
  });

  it('shows natural member presence and assistant delegation without exposing demo mechanics', async () => {
    await act(async () => {
      root.render(<App />);
    });

    expect(host.querySelector('.brand-row h1')?.textContent).toBe('AgentBridge');
    expect(host.querySelector('.brand-row p')?.textContent).toBe('A2A 原生聊天空间');
    expect(host.textContent).toContain('林雯 · 离线，个人助手托管中');
    expect(host.textContent).toContain('陈晨在线');
    expect(host.textContent).toContain('赵一鸣忙碌');
    expect(host.textContent).toContain('陈晨 · 在线');
    expect(host.textContent).toContain('林雯 · 托管中');
    expect(host.textContent).not.toContain('AI Agent 协作工作台');
    expect(host.textContent).not.toContain('AI 成员协作');
  });

  it('shows each room member identity, current focus, and assistant scope in the member panel', async () => {
    await act(async () => {
      root.render(<App />);
    });

    const memberTab = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('成员'));
    expect(memberTab).toBeTruthy();
    await act(async () => {
      memberTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('演示稿结构、课堂展示和最终视觉表达');
    expect(host.textContent).toContain('等陈晨补齐访谈截图后更新演示稿第 5 页和结论页');
    expect(host.textContent).toContain('今天 18:30 后离线，19:30-21:30 是演示稿专注时间');
    expect(host.textContent).toContain('可托管：查找授权文件、代发演示稿、发起日程协商');
    expect(host.textContent).toContain('访谈材料、引用来源和流程截图');
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

  it('surfaces pending A2A confirmations from the chat view without exposing implementation details', async () => {
    window.localStorage.setItem('agentbridge-review-guide-dismissed', 'true');
    const state = createDemoState();
    state.actionRequests = [
      {
        id: 'action-a2a-confirm-chat',
        agentId: 'agent-lin',
        roomId: 'room-team',
        kind: 'coordinate',
        status: 'needs_confirmation',
        input: {
          requestText: '帮我和陈晨商量一下，把合稿检查改到周三 23:00。',
          calendarPatch: {
            itemId: 'cal-review',
            oldStartsAt: '2026-05-05T20:30:00+08:00',
            newStartsAt: '2026-05-06T23:00:00+08:00'
          },
          taskPatch: {
            taskId: 'task-check',
            oldStatus: 'pending',
            newStatus: 'in_progress'
          }
        },
        risk: {
          level: 'medium',
          score: 0.52,
          reason: '日程影响范围有限，但仍建议记录协商过程。',
          model: 'risk-mini-v1'
        },
        createdAt: '2026-05-04T08:00:00.000Z',
        updatedAt: '2026-05-04T08:00:00.000Z',
        requiresHuman: true
      }
    ];
    apiMocks.fetchState.mockResolvedValue(state);

    await act(async () => {
      root.render(<App />);
    });

    const banner = host.querySelector<HTMLElement>('.chat-pending-action-banner');
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain('A2A 协商待确认');
    expect(banner!.textContent).toContain('确认后写入日程并推进相关任务');
    expect(banner!.textContent).toContain('周三 23:00');
    expect(banner!.textContent).not.toContain('action-a2a-confirm-chat');
    expect(banner!.textContent).not.toContain('calendarPatch');

    const confirmEntry = [...banner!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('去确认')
    );
    expect(confirmEntry).toBeTruthy();
    await act(async () => {
      confirmEntry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitForMotionExit();
    });

    expect(host.querySelector('.agent-console')).toBeTruthy();
    expect(host.textContent).toContain('待确认动作');
  });

  it('shows confirmed A2A outcomes as a concise chat result with task and calendar entry points', async () => {
    window.localStorage.setItem('agentbridge-review-guide-dismissed', 'true');
    const state = createDemoState();
    state.calendar = state.calendar.map((item) =>
      item.id === 'cal-review' ? { ...item, startsAt: '2026-05-06T23:00:00+08:00' } : item
    );
    state.tasks = state.tasks.map((task) =>
      task.id === 'task-check' ? { ...task, status: 'in_progress' } : task
    );
    state.actionRequests = [
      {
        id: 'action-a2a-confirmed-chat',
        agentId: 'agent-lin',
        roomId: 'room-team',
        kind: 'coordinate',
        status: 'executed',
        input: {
          requestText: '帮我和陈晨商量一下，把合稿检查改到周三 23:00。',
          calendarPatch: {
            itemId: 'cal-review',
            oldStartsAt: '2026-05-05T20:30:00+08:00',
            newStartsAt: '2026-05-06T23:00:00+08:00'
          },
          taskPatch: {
            taskId: 'task-check',
            oldStatus: 'pending',
            newStatus: 'in_progress'
          }
        },
        risk: {
          level: 'medium',
          score: 0.52,
          reason: '日程影响范围有限，但仍建议记录协商过程。',
          model: 'risk-mini-v1'
        },
        createdAt: '2026-05-04T08:00:00.000Z',
        updatedAt: '2026-05-04T08:05:00.000Z',
        requiresHuman: false,
        logId: 'log-a2a-confirmed-chat'
      }
    ];
    apiMocks.fetchState.mockResolvedValue(state);

    await act(async () => {
      root.render(<App />);
    });

    const banner = host.querySelector<HTMLElement>('.chat-completed-action-banner');
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain('A2A 协商已完成');
    expect(banner!.textContent).toContain('周三 23:00');
    expect(banner!.textContent).toContain('任务已进入进行中');
    expect(banner!.textContent).not.toContain('action-a2a-confirmed-chat');
    expect(banner!.textContent).not.toContain('calendarPatch');
    expect(host.querySelector('.chat-pending-action-banner')).toBeNull();

    const calendarButton = [...banner!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('查看日程')
    );
    expect(calendarButton).toBeTruthy();
    await act(async () => {
      calendarButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.textContent).toContain('相关日程');
    expect(host.textContent).toContain('第 4 组最后一次合稿检查');
    expect(host.textContent).toContain('23:00');

    const taskButton = [...banner!.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('查看任务')
    );
    expect(taskButton).toBeTruthy();
    await act(async () => {
      taskButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.textContent).toContain('从当前对话中提取的任务');
    expect(host.textContent).toContain('最后一次合稿检查');
    expect(host.textContent).toContain('进行中');
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

  it('opens Agent shortcuts from the chat composer and switches to the full Agent console', async () => {
    await act(async () => {
      root.render(<App />);
    });

    const chatComposer = host.querySelector('.chat-panel > .composer input[aria-label="chat composer"]');
    expect(chatComposer).toBeTruthy();
    expect(host.querySelector('.agent-workbench')).toBeNull();

    await openComposerAgentMenu(host);
    expect(host.textContent).toContain('总结当前群聊');
    expect(host.textContent).toContain('问截止');
    expect(host.textContent).toContain('Agent 找文件');
    expect(host.textContent).toContain('Agent 写回复');

    const consoleButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('进入 Agent 操作台')
    );
    expect(consoleButton).toBeTruthy();

    await act(async () => {
      consoleButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitForMotionExit();
    });

    expect(host.querySelector('.app-shell-im')).toBeNull();
    expect(host.querySelector('.agent-console')).toBeTruthy();
    expect(host.textContent).toContain('返回聊天');
    expect(host.querySelector('.agent-console-command #agent-prompt')).toBeTruthy();
    expect(host.querySelector('.agent-inspector')).toBeTruthy();
    expect(host.textContent).toContain('Agent 活动');
    expect(host.textContent).toContain('边界与确认');
    expect(host.textContent).toContain('Files');
    expect(host.textContent).toContain('暂无边界决策');
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
    await openAgentConsole(host);

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
    await openAgentConsole(host);

    expect(host.querySelector('[data-testid="a2a-session-panel"]')).toBeTruthy();
    expect(host.querySelector('.autopilot-policy.enabled')).toBeTruthy();
    expect(host.textContent).toContain('陈晨 ↔ 林雯');
    expect(host.textContent).toContain('文件代发请求：对方请求发送最新材料，等待人工确认。');
    expect(host.textContent).toContain('Agent 已完成授权文件代发。');
    expect(host.textContent).not.toContain('Chen asked Lin Agent to send the latest slides.');
    expect(host.textContent).not.toContain('Delivered file-slides-v3 to the room.');
    expect(host.textContent).toContain('low');
  });

  it('shows the seeded A2A negotiation as a visible collaboration loop instead of a log row', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    expect(host.querySelector('[data-testid="a2a-session-panel"]')).toBeTruthy();
    expect(host.textContent).toContain('A2A 协商流');
    expect(host.textContent).toContain('赵一鸣 ↔ 林雯 ↔ 陈晨');
    expect(host.textContent).toContain('发起请求');
    expect(host.textContent).toContain('读取林雯约束');
    expect(host.textContent).toContain('读取陈晨约束');
    expect(host.textContent).toContain('形成提案');
    expect(host.textContent).toContain('等待确认后写入日程并更新任务；确认前不会改变任何数据。');
    expect(host.textContent).not.toContain('已阻止');
    expect(host.textContent).not.toContain('Lin Agent');
    expect(host.textContent).not.toContain('Chen Agent');
  });

  it('labels pending file handoff sessions as file confirmation instead of schedule writes', async () => {
    const state = createDemoState();
    state.actionRequests = [
      {
        id: 'action-file-confirm',
        agentId: 'agent-lin',
        roomId: 'room-team',
        kind: 'share_file',
        status: 'needs_confirmation',
        input: {
          requesterId: 'user-chen',
          requestText: '林雯不在电脑前，她的个人助手能不能把最新演示稿发给陈晨？'
        },
        risk: {
          level: 'medium',
          score: 0.46,
          reason: '文件可见范围需要确认。',
          model: 'risk-mini-v1'
        },
        createdAt: '2026-05-04T14:06:00+08:00',
        updatedAt: '2026-05-04T14:06:00+08:00',
        requiresHuman: true
      }
    ];
    state.a2aSessions = [
      {
        id: 'a2a-file-confirm',
        roomId: 'room-team',
        initiatorAgentId: 'agent-chen',
        targetAgentIds: ['agent-lin'],
        goal: '陈晨请求林雯的个人助手发送最新版演示稿。',
        status: 'needs_confirmation',
        turns: [
          {
            id: 'a2a-file-turn-1',
            agentId: 'agent-chen',
            kind: 'request',
            message: '陈晨请求发送最新版演示稿。',
            toolCalls: ['room_search'],
            createdAt: '2026-05-04T14:06:00+08:00'
          },
          {
            id: 'a2a-file-turn-2',
            agentId: 'agent-lin',
            kind: 'proposal',
            message: '林雯的分身确认文件范围，等待人类确认后才能代发。',
            toolCalls: ['file_library.lookup_latest', 'action_request.create'],
            createdAt: '2026-05-04T14:06:10+08:00'
          }
        ],
        proposedActionRequestIds: ['action-file-confirm'],
        contextIds: ['msg-06', 'file-slides-v3'],
        risk: {
          level: 'medium',
          score: 0.46,
          reason: '文件代发需要确认。',
          model: 'risk-mini-v1'
        },
        createdAt: '2026-05-04T14:06:00+08:00',
        updatedAt: '2026-05-04T14:06:10+08:00'
      }
    ];
    apiMocks.fetchState.mockResolvedValue(state);

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    expect(host.textContent).toContain('等待确认后代发授权文件；确认前不会发送任何文件。');
    expect(host.textContent).toContain('等待确认：文件代发');
    expect(host.textContent).not.toContain('等待人类确认后写入日程');
  });

  it('keeps A2A session rows as concise user-facing summaries', async () => {
    const state = createDemoState();
    const noisyMessage = 'Negotiation produced a schedule-change proposal and is waiting for human confirmation.';
    state.a2aSessions = [
      {
        id: 'a2a-session-noisy',
        roomId: 'room-team',
        initiatorAgentId: 'agent-chen',
        targetAgentIds: ['agent-lin'],
        goal: '我看到了赵一鸣的Agent要求我的Agent协商把合稿检查从周二20:30改到周三23:00。但我是陈晨本人，不是我的Agent。这段很长，不应该完整展示给用户。',
        status: 'needs_confirmation',
        turns: [
          {
            id: 'a2a-turn-noisy',
            agentId: 'agent-lin',
            kind: 'response',
            message: noisyMessage,
            toolCalls: ['agent.coordinate'],
            createdAt: '2026-05-04T08:04:00.000Z'
          }
        ],
        proposedActionRequestIds: [],
        contextIds: ['msg-03'],
        risk: {
          level: 'medium',
          score: 0.48,
          reason: 'Schedule change requires confirmation.',
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
    await openAgentConsole(host);

    expect(host.textContent).toContain('日程协调提案：把合稿检查从周二 20:30 调整到周三 23:00，等待人工确认。');
    expect(host.textContent).toContain('Agent 已完成上下文检查，并将日程变更提交人工确认。');
    expect(host.textContent).not.toContain('不是我的Agent');
    expect(host.textContent).not.toContain(noisyMessage);
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
    await openAgentConsole(host);

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
    await openAgentConsole(host);

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
    await openComposerAgentMenu(host);
    const deadlineButton = [...host.querySelectorAll('.agent-command-menu button')].find((button) =>
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

  it('clears stale realtime disconnect errors after repeated SSE failures reconnect', async () => {
    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      eventListeners.error?.({ type: 'error', data: 'Event stream disconnected' });
    });
    expect(host.textContent).toContain('实时连接已断开');

    await act(async () => {
      eventListeners.error?.({ type: 'error', data: 'Event stream disconnected' });
    });
    expect(host.textContent).toContain('实时连接已断开');

    await act(async () => {
      eventListeners.ready?.({ type: 'ready', data: '{"ok":true}' });
      await waitForMotionExit();
    });
    expect(host.textContent).not.toContain('实时连接已断开');
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
    await openAgentConsole(host);

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

  it('keeps runtime progress out of the default IM view until the Agent console opens', async () => {
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

    await openAgentConsole(host);
    expect(host.textContent).toContain('Agent 活动');
    expect(host.textContent).toContain('写入 Agent 记忆');
    expect(host.textContent).not.toContain('检索截止信息');

    const auditToggle = host.querySelector<HTMLButtonElement>('.audit-disclosure-button');
    expect(auditToggle).toBeTruthy();
    await act(async () => {
      auditToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('实时步骤');
    expect(host.textContent).toContain('检索截止信息');
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
    await openAgentConsole(host);

    await clickAgentAction(host, '总结群聊');
    await clickAgentAction(host, '问截止');
    await clickAgentAction(host, 'Agent 找文件');
    await clickAgentAction(host, '请求代发');
    await clickAgentAction(host, 'Agent 协调');

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
    await openAgentConsole(host);

    await openAgentActionMenu(host);
    let actionButtons = [...host.querySelectorAll<HTMLButtonElement>('.agent-command-menu button')];
    let summaryButton = actionButtons.find((button) => button.textContent?.includes('总结群聊'));
    let deadlineButton = actionButtons.find((button) => button.textContent?.includes('问截止'));
    expect(summaryButton).toBeTruthy();
    expect(deadlineButton).toBeTruthy();

    await act(async () => {
      summaryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(summaryButton!.disabled).toBe(true);
    expect(deadlineButton!.disabled).toBe(false);

    await openAgentActionMenu(host);
    actionButtons = [...host.querySelectorAll<HTMLButtonElement>('.agent-command-menu button')];
    deadlineButton = actionButtons.find((button) => button.textContent?.includes('问截止'));
    expect(deadlineButton).toBeTruthy();
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
    await openAgentConsole(host);

    await clickAgentAction(host, '总结群聊');

    const planLine = host.querySelector('.agent-thought');
    expect(planLine).toBeNull();
    expect(host.textContent).not.toContain('处理方式');
    expect(host.textContent).not.toContain('思考过程');
    expect(host.textContent).not.toContain('item 18');
    expect(host.textContent).toContain('回答');
  });

  it('renders goal plans as user-facing progress without exposing raw tool traces', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult({
      result: {
        reply: 'Use the latest report and confirm the handoff.'
      },
      log: {
        toolCalls: ['deepseek.pro.chat.completions', 'room.summarize', 'deadline.answer', 'file.search']
      },
      goalPlan: {
        id: 'goal-plan-ui',
        agentId: 'agent-lin',
        roomId: 'room-team',
        originRunId: 'agent-run-goal-plan',
        userText: 'Plan the next action',
        summary: 'Confirm the deadline, find the latest file, and prepare the next reply.',
        status: 'active',
        contextIds: ['msg-01', 'file-01'],
        actionRequestIds: [],
        createdAt: '2026-05-04T08:03:00.000Z',
        updatedAt: '2026-05-04T08:03:05.000Z',
        steps: [
          {
            id: 'step-context',
            title: 'Collect room context',
            tool: 'room.summarize',
            sideEffect: 'read',
            status: 'completed',
            requiresHuman: false,
            evidenceIds: ['msg-01'],
            outputSummary: 'Found the latest deadline and discussion owner.',
            createdAt: '2026-05-04T08:03:00.000Z',
            updatedAt: '2026-05-04T08:03:01.000Z'
          },
          {
            id: 'step-file',
            title: 'Find the current report',
            tool: 'file.search',
            sideEffect: 'read',
            status: 'completed',
            requiresHuman: false,
            evidenceIds: ['file-01'],
            outputSummary: 'Matched the newest authorized file.',
            createdAt: '2026-05-04T08:03:01.000Z',
            updatedAt: '2026-05-04T08:03:03.000Z'
          },
          {
            id: 'step-confirm',
            title: 'Wait for handoff confirmation',
            tool: 'message.send',
            sideEffect: 'write',
            status: 'needs_confirmation',
            requiresHuman: true,
            evidenceIds: [],
            outputSummary: 'Needs one confirmation before sending.',
            createdAt: '2026-05-04T08:03:03.000Z',
            updatedAt: '2026-05-04T08:03:05.000Z'
          }
        ]
      }
    }));

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(prompt).toBeTruthy();
    expect(sendButton).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, 'Plan the next action');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const goalPlanCard = host.querySelector('[data-testid="agent-goal-plan-card"]');
    expect(goalPlanCard).toBeTruthy();
    expect(goalPlanCard!.textContent).toContain('Confirm the deadline');
    expect(goalPlanCard!.querySelectorAll('.goal-plan-step')).toHaveLength(3);
    expect(goalPlanCard!.textContent).toContain('Collect room context');
    expect(goalPlanCard!.textContent).toContain('Wait for handoff confirmation');
    expect(goalPlanCard!.textContent).not.toContain('room.summarize');
    expect(goalPlanCard!.textContent).not.toContain('deadline.answer');
    expect(goalPlanCard!.textContent).not.toContain('file.search');

    const continueButton = goalPlanCard!.querySelector<HTMLButtonElement>('button[aria-label="continue goal plan"]');
    expect(continueButton).toBeTruthy();
    await act(async () => {
      continueButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(apiMocks.runAgent).toHaveBeenLastCalledWith('', expect.objectContaining({
      agentId: 'agent-lin',
      roomId: 'room-team',
      goalPlanId: 'goal-plan-ui'
    }));
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
      },
      {
        id: 'action-review-2',
        agentId: 'agent-lin',
        roomId: 'room-team',
        kind: 'coordinate',
        status: 'needs_confirmation',
        input: {
          proposal: '??? 20:30 ????????? 23:00,??????????'
        },
        risk: {
          level: 'medium',
          score: 0.52,
          reason: '日程影响范围有限，但仍建议记录协商过程。',
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
    await openAgentConsole(host);

    expect(host.textContent).toContain('待确认动作');
    expect(host.textContent).toContain('请求意图不够明确');
    expect(host.textContent).toContain('日程协调提案：把周二 20:30 的合稿检查改到周三 23:00');
    expect(host.textContent).not.toContain('??? 20:30');

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
    await openAgentConsole(host);

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
    await openAgentConsole(host);
    await clickAgentAction(host, '问截止');

    expect(host.textContent).toContain('依据：消息 1 条 · 文件 1 个');
    expect(host.textContent).not.toContain('王老师 09:15 的消息');
    expect(host.textContent).not.toContain('信息系统课程作业要求.pdf');
    expect(host.textContent).not.toContain('msg-02');

    const evidenceButton = host.querySelector<HTMLButtonElement>('.source-summary-button');
    expect(evidenceButton).toBeTruthy();
    await act(async () => {
      evidenceButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('王老师 09:15 的消息');
    expect(host.textContent).toContain('信息系统课程作业要求.pdf');
  });

  it('keeps routine Agent answers focused and hides source details until requested', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue({
      intent: 'deadline',
      requiresHuman: false,
      result: {
        answer: '截止时间是 5月12日 23:59，需要提交调研报告 PDF 和 8 分钟演示稿。',
        citations: ['msg-02', 'msg-03', 'file-brief']
      },
      log: {
        id: 'log-focused-deadline',
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
        contextIds: ['msg-02', 'msg-03', 'file-brief'],
        toolCalls: ['room_search', 'file_library.search'],
        createdAt: '2026-05-04T08:02:00.000Z'
      }
    });

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);
    await clickAgentAction(host, '问截止');

    expect(host.textContent).toContain('截止时间是 5月12日 23:59');
    expect(host.textContent).toContain('依据：消息 2 条 · 文件 1 个');
    expect(host.querySelector('.citation-row')).toBeNull();
    expect(host.textContent).not.toContain('王老师 09:15 的消息');
    expect(host.textContent).not.toContain('只读检索授权房间');

    const evidenceButton = host.querySelector<HTMLButtonElement>('.source-summary-button');
    expect(evidenceButton).toBeTruthy();
    await act(async () => {
      evidenceButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.querySelector('.citation-row')).toBeTruthy();
    expect(host.textContent).toContain('王老师 09:15 的消息');
  });

  it('renders unmatched Agent citations as user-facing context labels', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue({
      intent: 'deadline',
      requiresHuman: false,
      result: {
        answer: '截止时间来自任务、日程和 Agent 记忆的综合判断。',
        citations: ['task-report', 'task-slides', 'mem-agent-lin-1778401496762-bfe7aae3f9d9b8']
      },
      log: {
        id: 'log-context-labels',
        agentId: 'agent-lin',
        roomId: 'room-team',
        action: 'agent_run:deadline:这次作业什么时候截止？',
        status: 'executed',
        risk: {
          level: 'low',
          score: 0.12,
          reason: '只读检索授权房间、任务和记忆。',
          model: 'risk-mini-v1'
        },
        contextIds: ['task-report', 'task-slides', 'mem-agent-lin-1778401496762-bfe7aae3f9d9b8'],
        toolCalls: ['room_search', 'memory.search'],
        createdAt: '2026-05-04T08:02:00.000Z'
      }
    });

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);
    await clickAgentAction(host, '问截止');

    expect(host.textContent).toContain('依据：上下文 3 条');
    expect(host.textContent).not.toContain('task-report');
    expect(host.textContent).not.toContain('mem-agent-lin');

    const evidenceButton = host.querySelector<HTMLButtonElement>('.source-summary-button');
    expect(evidenceButton).toBeTruthy();
    await act(async () => {
      evidenceButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('任务：调研报告');
    expect(host.textContent).toContain('任务：演示稿');
    expect(host.textContent).toContain('Agent 记忆');
    expect(host.textContent).not.toContain('task-report');
    expect(host.textContent).not.toContain('mem-agent-lin');
  });

  it('fetches trace replay after an Agent run and renders audit timeline data', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    const baseResult = createAgentRunResult();
    apiMocks.runAgent.mockResolvedValue({
      ...baseResult,
      runId: 'agent-run-ui',
      sessionId: 'agent-session-ui',
      eventCursor: 'seq:5',
      intent: 'send_message',
      result: {
        status: 'executed',
        targetRoomId: 'room-team',
        messageBody: 'Trace replay message',
        risk: baseResult.log.risk
      },
      log: {
        ...baseResult.log,
        toolCalls: ['message.send']
      }
    });

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    expect(prompt).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, 'send message Trace replay message');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(sendButton).toBeTruthy();
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(apiMocks.getAgentTrace).toHaveBeenCalledWith('', 'agent-run-ui');
    expect(host.querySelector('[data-testid="agent-trace-panel"]')).toBeTruthy();
    expect(host.textContent).toContain('Agent 活动');
    expect(host.textContent).toContain('完成 5 个步骤');
    expect(host.textContent).toContain('边界与确认');
    expect(host.textContent).not.toContain('Tool requested');
    expect(host.textContent).not.toContain('message.send');

    const auditToggle = host.querySelector<HTMLButtonElement>('.audit-disclosure-button');
    expect(auditToggle).toBeTruthy();
    await act(async () => {
      auditToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('Tool requested');
    expect(host.textContent).toContain('Permission allowed');
    expect(host.textContent).toContain('message.send');
    expect(host.querySelector('.agent-timeline-list .trace-row')).toBeTruthy();
    expect(host.querySelector('.permission-center-list .permission-row')).toBeTruthy();
  });

  it('summarizes Agent runtime by default and keeps technical trace details behind an audit disclosure', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    const baseResult = createAgentRunResult();
    apiMocks.runAgent.mockResolvedValue({
      ...baseResult,
      runId: 'agent-run-audit-disclosure',
      eventCursor: 'seq:5',
      intent: 'deadline',
      result: {
        answer: '截止时间是 5月12日 23:59。',
        citations: ['msg-02']
      },
      log: {
        ...baseResult.log,
        action: 'agent_run:deadline:这次作业什么时候截止？',
        toolCalls: ['deepseek.pro.chat.completions', 'room_search', 'file_library.search']
      }
    });
    apiMocks.getAgentTrace.mockResolvedValueOnce(createAgentTrace({
      runId: 'agent-run-audit-disclosure',
      toolName: 'deepseek.pro.chat.completions'
    }));

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(prompt).toBeTruthy();
    expect(sendButton).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, '这次作业什么时候截止？');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const runtimePanel = host.querySelector('[data-testid="agent-trace-panel"]');
    expect(runtimePanel).toBeTruthy();
    expect(runtimePanel!.textContent).toContain('Agent 活动');
    expect(runtimePanel!.textContent).toContain('完成 5 个步骤');
    expect(runtimePanel!.textContent).not.toContain('deepseek.pro.chat.completions');
    expect(runtimePanel!.textContent).not.toContain('Tool requested');

    const auditToggle = runtimePanel!.querySelector<HTMLButtonElement>('.audit-disclosure-button');
    expect(auditToggle).toBeTruthy();
    await act(async () => {
      auditToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(runtimePanel!.textContent).toContain('deepseek.pro.chat.completions');
    expect(runtimePanel!.textContent).toContain('Tool requested');
  });

  it('marks trace replay as partial when the server truncated it', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult({
      runId: 'agent-run-truncated',
      eventCursor: 'seq:5',
      result: {
        reply: 'Trace may be partial.'
      }
    }));
    apiMocks.getAgentTrace.mockResolvedValueOnce(createAgentTrace({
      runId: 'agent-run-truncated',
      truncated: true
    }));

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(prompt).toBeTruthy();
    expect(sendButton).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, 'Show a truncated trace');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('partial trace');
  });

  it('shows only the latest eight permission decisions with a compact summary', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult({
      runId: 'agent-run-many-permissions',
      eventCursor: 'seq:12',
      result: {
        reply: 'Many permission decisions.'
      }
    }));
    apiMocks.getAgentTrace.mockResolvedValueOnce(createAgentTraceWithPermissionEvents(10));

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(prompt).toBeTruthy();
    expect(sendButton).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, 'Show many permissions');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const permissionRows = [...host.querySelectorAll('.permission-center-list .permission-row')];
    expect(permissionRows).toHaveLength(8);
    expect(host.textContent).toContain('显示最近 8 条，共 10 条');
    expect(permissionRows[0]?.textContent).toContain('permission reason 3');
    expect(permissionRows.some((row) => row.textContent?.includes('permission reason 2'))).toBe(false);
    expect(host.textContent).toContain('permission reason 10');
  });

  it('uses a neutral fallback when a trace has no permission decisions', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult({
      runId: 'agent-run-no-permissions',
      eventCursor: 'seq:2',
      result: {
        reply: 'No permissions needed.'
      }
    }));
    apiMocks.getAgentTrace.mockResolvedValueOnce(createAgentTraceWithoutPermissionEvents());

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(prompt).toBeTruthy();
    expect(sendButton).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, 'No permission path');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const fallback = host.querySelector('.permission-center-list .permission-row');
    expect(fallback?.textContent).toContain('暂无边界决策');
    expect(fallback?.classList.contains('outcome-neutral')).toBe(true);
    expect(fallback?.classList.contains('outcome-allow')).toBe(false);
  });

  it('keeps the Agent result visible when trace replay is unavailable', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult({
      runId: 'agent-run-missing-trace',
      eventCursor: 'seq:5',
      result: {
        reply: 'The answer still renders.'
      }
    }));
    apiMocks.getAgentTrace.mockRejectedValueOnce(new Error('trace not found'));

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    expect(prompt).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, 'What still renders?');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(sendButton).toBeTruthy();
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('The answer still renders.');
    expect(host.textContent).toContain('审计记录暂不可用');
    expect(host.textContent).not.toContain('trace not found');
  });

  it('does not keep the Agent action busy or block refresh while trace replay is loading', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult({
      runId: 'agent-run-slow-trace',
      eventCursor: 'seq:5',
      result: {
        reply: 'Primary answer rendered.'
      }
    }));
    apiMocks.getAgentTrace.mockReturnValue(new Promise(() => undefined));

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    expect(prompt).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, 'Will trace block?');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(sendButton).toBeTruthy();
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiMocks.fetchState).toHaveBeenCalledTimes(2);
    expect(sendButton!.disabled).toBe(false);
    expect(host.querySelector('.agent-busy-panel')).toBeNull();
    expect(host.textContent).toContain('Primary answer rendered.');
    expect(host.textContent).toContain('正在读取执行记录');
  });

  it('does not fetch trace replay when the Agent result has no run id', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult());

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);
    apiMocks.getAgentTrace.mockClear();

    await clickAgentAction(host, '总结群聊');

    expect(apiMocks.getAgentTrace).not.toHaveBeenCalled();
  });

  it('does not fetch trace replay when the Agent result has a run id but no event cursor', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult({
      runId: 'agent-run-without-cursor',
      result: {
        reply: 'Result without persisted events.'
      }
    }));

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);
    apiMocks.getAgentTrace.mockClear();

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(prompt).toBeTruthy();
    expect(sendButton).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, 'Run without event cursor');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(apiMocks.getAgentTrace).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Result without persisted events.');
    expect(host.textContent).not.toContain('审计记录暂不可用');
  });

  it('keeps stale trace replay responses from overwriting a newer Agent run', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    let resolveFirstTrace!: (trace: AgentTrace) => void;
    let resolveSecondTrace!: (trace: AgentTrace) => void;
    apiMocks.runAgent
      .mockResolvedValueOnce(createAgentRunResult({
        runId: 'first-run',
        eventCursor: 'seq:5',
        result: {
          reply: 'First run answer.'
        }
      }))
      .mockResolvedValueOnce(createAgentRunResult({
        runId: 'second-run',
        eventCursor: 'seq:5',
        result: {
          reply: 'Second run answer.'
        }
      }));
    apiMocks.getAgentTrace
      .mockReturnValueOnce(new Promise<AgentTrace>((resolve) => {
        resolveFirstTrace = resolve;
      }))
      .mockReturnValueOnce(new Promise<AgentTrace>((resolve) => {
        resolveSecondTrace = resolve;
      }));

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(prompt).toBeTruthy();
    expect(sendButton).toBeTruthy();

    await act(async () => {
      setInputValue(prompt!, 'first run');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      setInputValue(prompt!, 'second run');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      resolveSecondTrace(createAgentTrace({
        runId: 'second-run',
        toolName: 'second.tool',
        permissionReason: 'Second trace reason'
      }));
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Second trace reason');
    const auditToggle = host.querySelector<HTMLButtonElement>('.audit-disclosure-button');
    expect(auditToggle).toBeTruthy();
    await act(async () => {
      auditToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.textContent).toContain('second.tool');

    await act(async () => {
      resolveFirstTrace(createAgentTrace({
        runId: 'first-run',
        toolName: 'first.tool',
        permissionReason: 'First stale trace reason'
      }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Second trace reason');
    expect(host.textContent).toContain('second.tool');
    expect(host.textContent).not.toContain('First stale trace reason');
    expect(host.textContent).not.toContain('first.tool');
  });

  it('refreshes state after trace replay rejection', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult({
      runId: 'agent-run-rejected-trace',
      eventCursor: 'seq:5',
      result: {
        reply: 'Refresh still happens.'
      }
    }));
    apiMocks.getAgentTrace.mockRejectedValueOnce(new Error('trace not found'));

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(prompt).toBeTruthy();
    expect(sendButton).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, 'Reject trace');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiMocks.fetchState).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Refresh still happens.');
    expect(host.textContent).toContain('审计记录暂不可用');
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
    await openAgentConsole(host);

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
    expect(host.textContent).not.toContain('处理方式');
    expect(host.textContent).not.toContain('思考过程');
    expect(host.textContent).toContain('回答');
    expect(host.textContent).toContain('This room is coordinating the assignment handoff.');
    expect(host.textContent).not.toContain('Answer from room context.');
  });

  it('keeps tell-me planning prompts as free Agent chat instead of message sending', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult({
      intent: 'chat',
      result: {
        reply: 'Next, confirm the deadline and gather the latest files.'
      }
    }));

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(prompt).toBeTruthy();
    expect(sendButton).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, '告诉我下一步需要做什么');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(apiMocks.runAgent).toHaveBeenCalledWith('', {
      agentId: 'agent-lin',
      roomId: 'room-team',
      userText: '告诉我下一步需要做什么'
    });
    expect(apiMocks.runAgent.mock.calls[0]?.[1]).not.toHaveProperty('intent', 'send_message');
    expect(apiMocks.runAgent.mock.calls[0]?.[1]).not.toHaveProperty('messageBody');
  });

  it('keeps a successful Agent answer visible when post-run state refresh fails', async () => {
    const state = createDemoState();
    apiMocks.fetchState
      .mockResolvedValueOnce(state)
      .mockRejectedValueOnce(new Error('state refresh failed'));
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult({
      intent: 'chat',
      result: {
        reply: 'The Agent answer succeeded.'
      }
    }));

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(prompt).toBeTruthy();
    expect(sendButton).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, 'What should I do next?');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('The Agent answer succeeded.');
    expect(host.textContent).not.toContain('state refresh failed');
    expect(host.textContent).not.toContain('fetch failed');
  });

  it('renders Agent markdown replies as clean readable text', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult({
      intent: 'chat',
      result: {
        reply: '这次作业截止时间是 **5月12日 23:59**。 临近时间点： - 5月10日补齐访谈材料 - 周二 20:30 合稿检查'
      }
    }));

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

    const prompt = host.querySelector<HTMLInputElement>('#agent-prompt');
    const sendButton = host.querySelector<HTMLButtonElement>('button[aria-label="send agent prompt"]');
    expect(prompt).toBeTruthy();
    expect(sendButton).toBeTruthy();
    await act(async () => {
      setInputValue(prompt!, 'Give deadline');
      prompt!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('5月12日 23:59');
    expect(host.textContent).toContain('5月10日补齐访谈材料');
    expect(host.textContent).not.toContain('**');
    expect(host.querySelectorAll('.agent-final li')).toHaveLength(2);
  });

  it('submits Agent commands from natural language without visible target controls', async () => {
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.runAgent.mockResolvedValue(createAgentRunResult());

    await act(async () => {
      root.render(<App />);
    });
    await openAgentConsole(host);

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

async function openAgentConsole(host: HTMLElement) {
  const consoleButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes('Agent 操作台')
  );
  expect(consoleButton).toBeTruthy();
  await act(async () => {
    consoleButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForMotionExit();
  });
}

async function openComposerAgentMenu(host: HTMLElement) {
  const menuButton = host.querySelector<HTMLButtonElement>('button[aria-label="打开 Agent 快捷菜单"]');
  expect(menuButton).toBeTruthy();
  await act(async () => {
    menuButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForMotionExit();
  });
}

async function openAgentActionMenu(host: HTMLElement) {
  if (host.querySelector('.agent-command-menu')) {
    return;
  }
  const menuButton = host.querySelector<HTMLButtonElement>('button[aria-label="打开 Agent 操作菜单"]');
  expect(menuButton).toBeTruthy();
  await act(async () => {
    menuButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForMotionExit();
  });
}

async function clickAgentAction(host: HTMLElement, label: string) {
  await openAgentActionMenu(host);
  const actionButton = [...host.querySelectorAll<HTMLButtonElement>('.agent-command-menu button')].find((button) =>
    button.textContent?.includes(label)
  );
  expect(actionButton).toBeTruthy();
  await act(async () => {
    actionButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

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

type AgentRunResultOverrides = Partial<Omit<AgentRunResult, 'log'>> & {
  log?: Partial<AgentRunResult['log']>;
};

function createAgentRunResult(overrides: AgentRunResultOverrides = {}): AgentRunResult {
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

function createAgentTrace(overrides: {
  runId?: string;
  toolName?: string;
  permissionReason?: string;
  truncated?: boolean;
  events?: AgentEvent[];
  eventCount?: number;
} = {}): AgentTrace {
  const createdAt = '2026-05-04T08:03:00.000Z';
  const runId = overrides.runId ?? 'agent-run-ui';
  const toolName = overrides.toolName ?? 'message.send';
  const permissionReason = overrides.permissionReason ?? 'Allowed by room policy';
  const baseEvent = {
    tenantId: 'tenant-ui',
    sessionId: 'agent-session-ui',
    runId,
    agentId: 'agent-lin',
    roomId: 'room-team',
    visibility: 'audit' as const,
    riskLevel: 'low' as const,
    createdAt
  };

  return {
    runId,
    sessionId: 'agent-session-ui',
    tenantId: 'tenant-ui',
    agentId: 'agent-lin',
    roomId: 'room-team',
    status: 'completed',
    startedAt: createdAt,
    finishedAt: '2026-05-04T08:03:05.000Z',
    phases: ['created', 'tool', 'permission', 'completed'],
    toolCalls: [toolName],
    eventCount: overrides.eventCount ?? overrides.events?.length ?? 5,
    ...(overrides.truncated === undefined ? {} : { truncated: overrides.truncated }),
    events: overrides.events ?? [
      {
        ...baseEvent,
        id: 'trace-event-1',
        sequence: 1,
        cursor: 'seq:1',
        type: 'agent.run.created',
        label: 'Run created',
        detail: 'Agent run accepted',
        toolCalls: [],
        payload: {}
      },
      {
        ...baseEvent,
        id: 'trace-event-2',
        sequence: 2,
        cursor: 'seq:2',
        type: 'agent.tool.requested',
        label: 'Tool requested',
        detail: 'Preparing to send a message',
        toolCalls: [toolName],
        payload: {
          invocationId: 'invoke-message-send',
          toolName,
          requiredPermissions: ['message:send']
        }
      },
      {
        ...baseEvent,
        id: 'trace-event-3',
        sequence: 3,
        cursor: 'seq:3',
        type: 'agent.permission.allowed',
        label: 'Permission allowed',
        detail: permissionReason,
        toolCalls: [toolName],
        payload: {
          invocationId: 'invoke-message-send',
          toolName,
          requiredPermissions: ['message:send'],
          requiresHuman: false,
          reasons: [permissionReason]
        }
      },
      {
        ...baseEvent,
        id: 'trace-event-4',
        sequence: 4,
        cursor: 'seq:4',
        type: 'agent.tool.completed',
        label: 'Tool completed',
        detail: `${toolName} completed`,
        toolCalls: [toolName],
        payload: {
          invocationId: 'invoke-message-send',
          toolName,
          status: 'completed'
        }
      },
      {
        ...baseEvent,
        id: 'trace-event-5',
        sequence: 5,
        cursor: 'seq:5',
        type: 'agent.run.completed',
        label: 'Run completed',
        detail: 'Agent run completed',
        toolCalls: [toolName],
        payload: {
          status: 'completed'
        }
      }
    ]
  };
}

function createAgentTraceWithPermissionEvents(permissionCount: number): AgentTrace {
  const baseTrace = createAgentTrace();
  const createdAt = '2026-05-04T08:03:00.000Z';
  const permissionEvents: AgentEvent[] = Array.from({ length: permissionCount }, (_, index) => {
    const sequence = index + 1;
    return {
      tenantId: 'tenant-ui',
      sessionId: 'agent-session-ui',
      runId: 'agent-run-many-permissions',
      agentId: 'agent-lin',
      roomId: 'room-team',
      visibility: 'audit',
      riskLevel: sequence % 2 === 0 ? 'medium' : 'low',
      createdAt: `2026-05-04T08:03:${String(sequence).padStart(2, '0')}.000Z`,
      id: `permission-event-${sequence}`,
      sequence,
      cursor: `seq:${sequence}`,
      type: sequence % 3 === 0 ? 'agent.permission.requested' : 'agent.permission.allowed',
      label: `Permission ${sequence}`,
      detail: `permission reason ${sequence}`,
      toolCalls: [`tool.${sequence}`],
      payload: {
        invocationId: `invoke-${sequence}`,
        toolName: `tool.${sequence}`,
        requiredPermissions: [`permission:${sequence}`],
        requiresHuman: sequence % 3 === 0,
        reasons: [`permission reason ${sequence}`]
      }
    };
  });

  return {
    ...baseTrace,
    runId: 'agent-run-many-permissions',
    eventCount: permissionEvents.length,
    startedAt: createdAt,
    finishedAt: permissionEvents.at(-1)?.createdAt,
    toolCalls: permissionEvents.flatMap((event) => event.toolCalls),
    events: permissionEvents
  };
}

function createAgentTraceWithoutPermissionEvents(): AgentTrace {
  const baseTrace = createAgentTrace();
  const events = baseTrace.events.filter((event) => !event.type.startsWith('agent.permission.'));
  return {
    ...baseTrace,
    eventCount: events.length,
    events
  };
}

function waitForMotionExit(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 500));
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
}
