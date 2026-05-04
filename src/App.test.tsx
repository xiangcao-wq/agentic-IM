import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { createDemoState } from './domain/demoState';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  askDeadline: vi.fn(),
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
  uploadFile: vi.fn()
}));

vi.mock('./client/apiClient', () => apiMocks);

describe('App runtime upgrade controls', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const state = createDemoState();
    apiMocks.fetchState.mockResolvedValue(state);
    apiMocks.fileDownloadUrl.mockReturnValue('/api/files/file/download');
    apiMocks.createStateEventSource.mockReturnValue({
      addEventListener: vi.fn(),
      close: vi.fn()
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it('exposes live AI actor, agent runtime, asset, sync, and memory controls', async () => {
    await act(async () => {
      root.render(<App />);
    });

    expect(host.textContent).toContain('让陈晨回复');
    expect(host.textContent).toContain('Agent 找文件');
    expect(host.textContent).toContain('生成真实文件');
    expect(host.textContent).toContain('同步 Matrix');
    expect(host.textContent).toContain('结构化记忆');
    expect(host.textContent).toContain('自动聊天');
    expect(host.textContent).toContain('陈晨 自动回复');
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
});
