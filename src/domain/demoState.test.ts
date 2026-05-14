// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from './demoState';
import { compareTimestamps } from './messages';

describe('demo scenario seed', () => {
  it('creates a coherent classroom, team, and agent scenario with searchable text file content', () => {
    const state = createDemoState();
    const allText = JSON.stringify(state);

    expect(allText).not.toMatch(/AUTO-CHECK|E2E|browser smoke|\?{4,}/i);

    expect(state.messages.filter((message) => message.roomId === 'room-class')).toHaveLength(5);
    expect(state.messages.filter((message) => message.roomId === 'room-team').length).toBeGreaterThanOrEqual(10);
    expect(state.messages.filter((message) => message.roomId === 'room-agent').length).toBeGreaterThanOrEqual(3);

    for (const room of state.rooms) {
      const messages = state.messages.filter((message) => message.roomId === room.id);
      const sorted = [...messages].sort((left, right) => compareTimestamps(left.sentAt, right.sentAt) || left.id.localeCompare(right.id));
      expect(messages.map((message) => message.id)).toEqual(sorted.map((message) => message.id));
    }

    const sourceMessageIds = new Set(state.messages.map((message) => message.id));
    for (const task of state.tasks) {
      expect(sourceMessageIds.has(task.sourceMessageId), task.id).toBe(true);
    }

    expect(state.tasks.find((task) => task.id === 'task-interview-materials')).toMatchObject({
      title: '补齐访谈材料和引用来源',
      owners: ['陈晨'],
      deadline: '5月10日 21:00',
      status: 'in_progress',
      sourceMessageId: 'msg-11'
    });

    expect(state.users.find((user) => user.id === 'user-lin')?.collaborationProfile).toMatchObject({
      responsibility: '演示稿结构、课堂展示和最终视觉表达',
      currentFocus: '等陈晨补齐访谈截图后更新演示稿第 5 页和结论页',
      availability: '今天 18:30 后离线，19:30-21:30 是演示稿专注时间',
      assistantScope: ['查找授权文件', '代发演示稿', '发起日程协商']
    });
    expect(state.users.find((user) => user.id === 'user-chen')?.collaborationProfile).toMatchObject({
      responsibility: '访谈材料、引用来源和流程截图',
      currentFocus: '补齐访谈纪要、截图和引用一致性',
      availability: '当前在线，但 21:00 前需要集中补材料'
    });
    expect(state.users.every((user) => user.collaborationProfile?.assistantScope.length)).toBe(true);

    expect(state.files.find((file) => file.id === 'file-interview-notes-txt')).toMatchObject({
      name: '第4组-访谈纪要-v1.txt',
      contentType: 'text/plain; charset=utf-8',
      visibility: 'room',
      agentCanShare: true
    });
    expect(state.files.find((file) => file.id === 'file-action-plan-md')).toMatchObject({
      name: '第4组-行动计划-工作清单.md',
      contentType: 'text/markdown; charset=utf-8',
      visibility: 'room',
      agentCanShare: true
    });

    const chunksByFile = new Map<string, string[]>();
    for (const chunk of state.fileTextChunks) {
      chunksByFile.set(chunk.fileId, [...(chunksByFile.get(chunk.fileId) ?? []), chunk.text]);
    }

    expect(chunksByFile.get('file-interview-notes-txt')?.join('\n')).toContain('引用一致性需要陈晨核对');
    expect(chunksByFile.get('file-action-plan-md')?.join('\n')).toContain('今天优先处理访谈材料');
    expect(state.fileTextChunks.every((chunk) => state.files.some((file) => file.id === chunk.fileId))).toBe(true);
  });

  it('stages the default demo around a natural assistant handoff and visible A2A negotiation loop', () => {
    const state = createDemoState();
    const visibleText = state.messages.map((message) => message.body).join('\n');
    const serialized = JSON.stringify({
      messages: state.messages,
      a2aSessions: state.a2aSessions,
      files: state.files.map((file) => ({ name: file.name, summary: file.summary }))
    });

    expect(serialized).not.toMatch(/Lin Agent|Chen Agent|Lin is offline|Agent IM|agent-im|not my Agent/i);
    expect(visibleText).not.toMatch(/我是.+不是.*Agent|不是我的\s*Agent/);

    expect(state.messages).toContainEqual(
      expect.objectContaining({
        id: 'msg-assistant-file-handoff',
        roomId: 'room-team',
        senderId: 'user-lin',
        senderName: '林雯',
        type: 'agent',
        agentLabel: '托管代发',
        body: expect.stringContaining('我不在电脑前')
      })
    );

    expect(state.a2aSessions).toContainEqual(
      expect.objectContaining({
        id: 'a2a-seed-review-reschedule',
        roomId: 'room-team',
        initiatorAgentId: 'agent-zhao',
        targetAgentIds: ['agent-lin', 'agent-chen'],
        status: 'needs_confirmation',
        goal: '赵一鸣希望把最后一次合稿检查从周二 20:30 调整到周三 23:00。',
        proposedActionRequestIds: ['action-seed-calendar-review']
      })
    );

    const reviewSession = state.a2aSessions.find((session) => session.id === 'a2a-seed-review-reschedule');
    expect(reviewSession?.turns.map((turn) => turn.message)).toEqual([
      '赵一鸣请求调整合稿检查时间，并要求保留每个人的材料边界。',
      '林雯的分身确认：林雯 19:30-21:30 专注演示稿，23:00 可以参加最终确认。',
      '陈晨的分身确认：陈晨 21:00 前补齐访谈材料，23:00 可以参加合稿检查。',
      '形成提案：周三 23:00 合稿检查；陈晨 21:00 前补材料；林雯会在确认后更新演示稿第 5 页和结论页。'
    ]);
  });
});
