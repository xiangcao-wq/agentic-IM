// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { Message } from '../domain/types';
import { runAiAutoreplies } from './aiAutoreply';
import type { AiProvider } from './aiProvider';

describe('AI autoreply context', () => {
  it('builds simulated human replies from structured context including authorized text file chunks', async () => {
    const state = createDemoState();
    state.actionLogs.unshift({
      id: 'log-autoreply-debug-marker',
      agentId: 'agent-chen',
      roomId: 'room-team',
      action: 'agent_run:chat:autoreply-debug-marker',
      status: 'executed',
      risk: {
        level: 'low',
        score: 0.1,
        reason: 'debug-only',
        model: 'risk-mini-v1'
      },
      contextIds: [],
      toolCalls: ['fallback.local_context'],
      createdAt: '2026-05-04T12:30:00+08:00'
    });
    state.files.unshift({
      id: 'file-interview-notes',
      name: 'interview-notes.txt',
      uploaderId: 'user-lin',
      version: 1,
      roomId: 'room-team',
      updatedAt: '2026-05-04T12:00:00+08:00',
      visibility: 'room',
      agentCanShare: true,
      tags: ['访谈', '引用'],
      summary: '访谈材料补充记录。',
      mxcUri: 'mxc://demo/interview-notes',
      contentType: 'text/plain',
      size: 96
    });
    state.fileTextChunks.unshift({
      id: 'file-interview-notes-chunk-0',
      fileId: 'file-interview-notes',
      roomId: 'room-team',
      uploaderId: 'user-lin',
      index: 0,
      text: '引用一致性需要陈晨核对，行动计划和访谈纪要要对齐。',
      createdAt: '2026-05-04T12:00:00+08:00'
    });
    const triggerMessage: Message = {
      id: 'msg-user-asks-chen',
      roomId: 'room-team',
      senderId: 'user-lin',
      senderName: '林雯',
      body: '@陈晨 你看一下引用一致性在哪里需要核对。',
      sentAt: '2026-05-04T13:00:00+08:00',
      type: 'text'
    };
    const aiProvider = createRecordingProvider('我会核对引用一致性。');

    await runAiAutoreplies({
      state,
      triggerMessage,
      aiProvider,
      async sendMessage(_sendState, input) {
        return {
          id: 'msg-ai-chen',
          roomId: input.roomId,
          senderId: input.senderId,
          senderName: '陈晨',
          body: input.body,
          sentAt: '2026-05-04T13:01:00+08:00',
          type: 'text'
        };
      }
    });

    expect(aiProvider.calls).toHaveLength(1);
    expect(aiProvider.calls[0].input).toContain('## File text excerpts');
    expect(aiProvider.calls[0].input).toContain('interview-notes.txt');
    expect(aiProvider.calls[0].input.indexOf('# Authorized Agent Context')).toBeGreaterThanOrEqual(0);
    expect(aiProvider.calls[0].input.indexOf('## Trigger message')).toBeGreaterThan(
      aiProvider.calls[0].input.indexOf('# Authorized Agent Context')
    );
    expect(aiProvider.calls[0].input).toContain('引用一致性需要陈晨核对');
    expect(aiProvider.calls[0].input).not.toContain('## Recent agent logs');
    expect(aiProvider.calls[0].input).not.toContain('autoreply-debug-marker');
    expect(aiProvider.calls[0].messages).toEqual([
      expect.objectContaining({ role: 'system' }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('# Authorized Agent Context') }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('## Trigger message') })
    ]);
    expect(aiProvider.calls[0].messages?.[1].content).toContain('## Tasks');
    expect(aiProvider.calls[0].messages?.[1].content).not.toContain('## Recent messages');
    expect(aiProvider.calls[0].messages?.[2].content).toContain('## Recent messages');
  });

  it('cleans roleplay and internal process text before writing simulated human replies', async () => {
    const state = createDemoState();
    const triggerMessage: Message = {
      id: 'msg-user-asks-chen',
      roomId: 'room-team',
      senderId: 'user-lin',
      senderName: '林雯',
      body: '@陈晨 你现在材料补到哪了？',
      sentAt: '2026-05-04T13:00:00+08:00',
      type: 'text'
    };
    const aiProvider = createRecordingProvider([
      '我现在是陈晨，不是 AI，所以要自然回复。',
      '我先检查上下文和任务列表。',
      '访谈截图还差一张，我 21:00 前补到群里。'
    ].join('\n'));
    let sentBody = '';

    await runAiAutoreplies({
      state,
      triggerMessage,
      aiProvider,
      async sendMessage(_sendState, input) {
        sentBody = input.body;
        return {
          id: 'msg-ai-chen',
          roomId: input.roomId,
          senderId: input.senderId,
          senderName: '陈晨',
          body: input.body,
          sentAt: '2026-05-04T13:01:00+08:00',
          type: 'text'
        };
      }
    });

    expect(sentBody).toBe('访谈截图还差一张，我 21:00 前补到群里。');
    expect(sentBody).not.toContain('我现在是');
    expect(sentBody).not.toContain('检查上下文');
    expect(sentBody).not.toContain('AI');
  });
});

function createRecordingProvider(text: string): AiProvider & {
  calls: Array<Parameters<AiProvider['generateText']>[0]>;
} {
  const calls: Array<Parameters<AiProvider['generateText']>[0]> = [];
  return {
    calls,
    async generateText(prompt) {
      calls.push(prompt);
      return text;
    }
  };
}
