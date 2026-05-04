import { describe, expect, it } from 'vitest';
import { createDemoState } from './demoState';
import { buildAgentContextBundle } from './memory';

describe('agent context bundle', () => {
  it('returns structured context with chronological messages and explicit file availability', () => {
    const state = createDemoState();

    const bundle = buildAgentContextBundle(state, {
      roomId: 'room-team',
      agentId: 'agent-lin',
      userText: '把最新演示稿发给陈晨',
      focus: 'file_share'
    });

    expect(bundle.room.id).toBe('room-team');
    expect(bundle.recentMessages.map((message) => message.id)).toContain('msg-04');
    expect(bundle.recentMessages.at(-1)?.id).toBe('msg-14');
    expect(bundle.files.find((file) => file.id === 'file-slides-v3')).toMatchObject({
      id: 'file-slides-v3',
      agentCanShare: true,
      downloadable: false,
      visibility: 'room'
    });
    expect(bundle.text).toContain('downloadable=false');
    expect(bundle.text).toContain('Do not assume hidden room, private chat, or missing file contents are visible.');
  });

  it('recalls relevant older messages separately from the recent window', () => {
    const base = createDemoState();
    const state = {
      ...base,
      messages: [
        ...base.messages,
        ...Array.from({ length: 34 }, (_, index) => ({
          id: `noise-${index}`,
          roomId: 'room-team',
          senderId: 'user-lin',
          senderName: '林雯',
          body: `普通闲聊 ${index}`,
          sentAt: new Date(Date.parse('2026-05-04T09:00:00.000Z') + index * 60_000).toISOString(),
          type: 'text' as const
        })),
        {
          id: 'old-interview-source',
          roomId: 'room-team',
          senderId: 'user-chen',
          senderName: '陈晨',
          body: '访谈材料由陈晨负责补充。',
          sentAt: '2026-05-04T07:00:00.000Z',
          type: 'text' as const
        }
      ]
    };

    const bundle = buildAgentContextBundle(state, {
      roomId: 'room-team',
      agentId: 'agent-lin',
      userText: '谁负责访谈材料？',
      focus: 'chat'
    });

    expect(bundle.recentMessages).toHaveLength(30);
    expect(bundle.relevantMessages.map((message) => message.id)).toContain('old-interview-source');
  });

  it('includes only authorized relevant file text chunks in the model context', () => {
    const base = createDemoState();
    const state = {
      ...base,
      files: [
        {
          id: 'file-indexed-visible',
          name: 'indexed-visible.txt',
          uploaderId: 'user-lin',
          version: 1,
          roomId: 'room-team',
          updatedAt: '2026-05-04T08:00:00.000Z',
          visibility: 'room' as const,
          agentCanShare: true,
          tags: ['notes'],
          summary: 'Visible indexed notes',
          contentType: 'text/plain',
          size: 64
        },
        {
          id: 'file-indexed-hidden',
          name: 'indexed-hidden.txt',
          uploaderId: 'user-chen',
          version: 1,
          roomId: 'room-private',
          updatedAt: '2026-05-04T08:00:00.000Z',
          visibility: 'room' as const,
          agentCanShare: true,
          tags: ['notes'],
          summary: 'Hidden indexed notes',
          contentType: 'text/plain',
          size: 64
        },
        ...base.files
      ],
      fileTextChunks: [
        {
          id: 'chunk-visible',
          fileId: 'file-indexed-visible',
          roomId: 'room-team',
          uploaderId: 'user-lin',
          index: 0,
          text: '引用一致性需要陈晨核对，行动计划和访谈纪要要对齐。',
          createdAt: '2026-05-04T08:00:00.000Z'
        },
        {
          id: 'chunk-hidden',
          fileId: 'file-indexed-hidden',
          roomId: 'room-private',
          uploaderId: 'user-chen',
          index: 0,
          text: 'private 引用一致性 content',
          createdAt: '2026-05-04T08:00:00.000Z'
        }
      ]
    };

    const bundle = buildAgentContextBundle(state, {
      roomId: 'room-team',
      agentId: 'agent-lin',
      userText: '引用一致性在哪里提到？',
      focus: 'file_share'
    });

    expect(bundle.fileTextChunks.map((chunk) => chunk.id)).toEqual(['chunk-visible']);
    expect(bundle.text).toContain('chunk-visible');
    expect(bundle.text).not.toContain('chunk-hidden');
  });

  it('filters obviously corrupted memories from model context', () => {
    const base = createDemoState();
    const state = {
      ...base,
      memories: [
        {
          id: 'mem-corrupt',
          ownerAgentId: 'agent-lin',
          scopeRoomIds: ['room-team'],
          kind: 'note' as const,
          content: '自由对话：???????????????? -> 用户输入被错误编码。',
          sourceIds: [],
          createdAt: '2026-05-04T08:00:00.000Z',
          updatedAt: '2026-05-04T08:00:00.000Z'
        },
        {
          id: 'mem-unsourced-note',
          ownerAgentId: 'agent-lin',
          scopeRoomIds: ['room-team'],
          kind: 'note' as const,
          content: '自由对话：访谈材料 -> 这是一条没有来源的模型笔记。',
          sourceIds: [],
          createdAt: '2026-05-04T08:00:30.000Z',
          updatedAt: '2026-05-04T08:00:30.000Z'
        },
        {
          id: 'mem-good',
          ownerAgentId: 'agent-lin',
          scopeRoomIds: ['room-team'],
          kind: 'note' as const,
          content: '自由对话：访谈材料 -> 陈晨负责补充访谈材料。',
          sourceIds: ['msg-03'],
          createdAt: '2026-05-04T08:01:00.000Z',
          updatedAt: '2026-05-04T08:01:00.000Z'
        }
      ]
    };

    const bundle = buildAgentContextBundle(state, {
      roomId: 'room-team',
      agentId: 'agent-lin',
      userText: '谁负责访谈材料？',
      focus: 'chat'
    });

    expect(bundle.memories.map((memory) => memory.id)).toEqual(['mem-good']);
    expect(bundle.text).toContain('lower-confidence');
    expect(bundle.text).not.toContain('????????');
    expect(bundle.text).not.toContain('没有来源的模型笔记');
  });
});
