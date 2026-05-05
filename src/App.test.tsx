import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { createDemoState } from './domain/demoState';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  askDeadline: vi.fn(),
  checkAiStatus: vi.fn(),
  confirmAgentAction: vi.fn(),
  coordinate: vi.fn(),
  createStateEventSource: vi.fn(),
  fetchState: vi.fn(),
  fileDownloadUrl: vi.fn(),
  generateDemoAssets: vi.fn(),
  humanReply: vi.fn(),
  runAgent: vi.fn(),
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
  let eventListeners: Record<string, (event: MessageEvent) => void>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    eventListeners = {};
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.fileDownloadUrl.mockReturnValue('/api/files/file/download');
    apiMocks.createStateEventSource.mockReturnValue({
      addEventListener: vi.fn((eventName: string, listener: (event: MessageEvent) => void) => {
        eventListeners[eventName] = listener;
      }),
      close: vi.fn()
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
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

  it('runs the pending autopilot sweep from the workbench', async () => {
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
    apiMocks.runPendingAutopilot.mockResolvedValue({
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

    expect(apiMocks.runPendingAutopilot).toHaveBeenCalledWith('', {
      roomId: 'room-team',
      limit: 20
    });
    expect(host.textContent).toContain('Backlog handoff');
  });

  it('marks the system event stream as disconnected when SSE fails', async () => {
    await act(async () => {
      root.render(<App />);
    });

    const eventSource = apiMocks.createStateEventSource.mock.results[0]?.value as { onerror?: () => void };
    await act(async () => {
      eventSource.onerror?.();
    });

    expect(host.textContent).toContain('实时连接已断开');
    expect(host.querySelector('.system-section')).toBeNull();
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
    expect(host.textContent).toContain('思考过程');
    expect(host.textContent).toContain('最终回答');
    expect(host.textContent).toContain('This room is coordinating the assignment handoff.');
    expect(host.textContent).toContain('Answer from room context.');
  });
});

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
}
