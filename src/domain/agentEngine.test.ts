// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  answerDeadlineQuestion,
  coordinateAgents,
  createFileShareAction,
  summarizeRoom
} from './agentEngine';
import { createDemoState } from './demoState';

describe('personal agent behavior', () => {
  it('summarizes assignment requirements, deadline, owners, and todos from room context', async () => {
    const state = createDemoState();
    const summary = await summarizeRoom(state, 'room-class', 'agent-lin');

    expect(summary.headline).toBe('信息系统作业小组需要在 5月12日 23:59 前提交调研报告和演示稿。');
    expect(summary.deadlines).toEqual(['5月12日 23:59']);
    expect(summary.todos).toContain('林雯整理已完成的演示稿 v3');
    expect(summary.todos).toContain('周二 20:30 前完成最后一次合稿检查');
    expect(summary.sources.length).toBeGreaterThanOrEqual(3);
  });

  it('answers deadline questions by searching authorized room messages and files', async () => {
    const state = createDemoState();
    const answer = await answerDeadlineQuestion(state, {
      agentId: 'agent-lin',
      roomId: 'room-class',
      question: '这次作业什么时候截止？'
    });

    expect(answer.answer).toContain('5月12日 23:59');
    expect(answer.answer).toContain('调研报告');
    expect(answer.citations).toContain('msg-02');
    expect(answer.citations).toContain('file-brief');
  });

  it('auto-shares the newest authorized file when risk is controllable', async () => {
    const baseState = createDemoState();
    const state = {
      ...baseState,
      files: baseState.files.map((file) =>
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
    const action = await createFileShareAction(state, {
      agentId: 'agent-lin',
      roomId: 'room-team',
      requesterId: 'user-chen',
      requestText: '林雯不在线的话，能把最新演示稿发一下吗？'
    });

    expect(action.status).toBe('executed');
    expect(action.requiresHuman).toBe(false);
    expect(action.risk.level).toBe('low');
    expect(action.file?.id).toBe('file-slides-v3');
    expect(action.message?.agentLabel).toBe('林雯的 Agent 代发');
    expect(action.message).toMatchObject({
      fileId: 'file-slides-v3',
      mxcUri: 'mxc://localhost/slides-v3',
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      size: 4096
    });
  });

  it('does not auto-share metadata-only files without Matrix media backing', async () => {
    const state = createDemoState();
    const action = await createFileShareAction(state, {
      agentId: 'agent-lin',
      roomId: 'room-team',
      requesterId: 'user-chen',
      requestText: '林雯不在线的话，能把最新演示稿发一下吗？'
    });

    expect(action.status).toBe('needs_confirmation');
    expect(action.requiresHuman).toBe(true);
    expect(action.message).toBeUndefined();
  });

  it('does not treat a tagged action plan PDF as a slide deck for slide requests', async () => {
    const baseState = createDemoState();
    const state = {
      ...baseState,
      files: [
        {
          id: 'file-action-plan-tagged-slides',
          name: '第4组-校园服务数字化调研-行动计划.pdf',
          uploaderId: 'user-lin',
          version: 5,
          roomId: 'room-team',
          updatedAt: '2026-05-04T09:30:00.000Z',
          visibility: 'room' as const,
          agentCanShare: true,
          tags: ['plan', 'pdf', 'slides'],
          summary: 'Openable PDF action plan for the group assignment.',
          mxcUri: 'mxc://localhost/action-plan',
          contentType: 'application/pdf',
          size: 2048
        },
        ...baseState.files
      ]
    };

    const action = await createFileShareAction(state, {
      agentId: 'agent-lin',
      roomId: 'room-team',
      requesterId: 'user-chen',
      requestText: 'please send the latest slides'
    });

    expect(action.status).toBe('needs_confirmation');
    expect(action.file?.id).not.toBe('file-action-plan-tagged-slides');
    expect(action.message).toBeUndefined();
  });

  it('shares the requested Matrix-backed file instead of the newest unrelated upload', async () => {
    const baseState = createDemoState();
    const state = {
      ...baseState,
      files: [
        {
          id: 'file-other-upload',
          name: 'download-current-proof.txt',
          uploaderId: 'user-lin',
          version: 3,
          roomId: 'room-team',
          updatedAt: '2026-05-04T09:30:00.000Z',
          visibility: 'room' as const,
          agentCanShare: true,
          tags: ['proof'],
          summary: 'Unrelated media upload proof.',
          mxcUri: 'mxc://localhost/proof',
          contentType: 'text/plain; charset=utf-8',
          size: 64
        },
        {
          id: 'file-action-plan',
          name: '第4组-校园服务数字化调研-行动计划.pdf',
          uploaderId: 'user-lin',
          version: 1,
          roomId: 'room-team',
          updatedAt: '2026-05-04T09:00:00.000Z',
          visibility: 'room' as const,
          agentCanShare: true,
          tags: ['action', 'plan'],
          summary: 'Openable PDF action plan for the group assignment.',
          mxcUri: 'mxc://localhost/action-plan',
          contentType: 'application/pdf',
          size: 2048
        },
        ...baseState.files
      ]
    };

    const action = await createFileShareAction(state, {
      agentId: 'agent-lin',
      roomId: 'room-team',
      requesterId: 'user-chen',
      requestText: 'please send the action plan'
    });

    expect(action.status).toBe('executed');
    expect(action.file?.id).toBe('file-action-plan');
  });

  it('requires human review for high-risk calendar changes while agents can still propose a plan', async () => {
    const state = createDemoState();
    const result = await coordinateAgents(state, {
      fromAgentId: 'agent-chen',
      toAgentId: 'agent-lin',
      roomId: 'room-team',
      proposal: '把周二 20:30 的合稿检查改到周三 23:00，并默认大家都同意。'
    });

    expect(result.status).toBe('needs_confirmation');
    expect(result.risk.level).toBe('high');
    expect(result.requiresHuman).toBe(true);
    expect(result.proposedPlan).toContain('建议先在群里确认所有成员是否同意改到周三 23:00');
  });
});
