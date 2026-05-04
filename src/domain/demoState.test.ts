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
});
