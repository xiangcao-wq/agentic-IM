// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { Message } from '../domain/types';
import type { AiProvider } from './aiProvider';
import { runAiDemoScenario, type DemoMatrixGateway } from './aiDemoScenario';

describe('AI demo scenario', () => {
  it('runs AI actors through Matrix messages, files, Agent tools, and audit records', async () => {
    const aiProvider: AiProvider = {
      async generateText(prompt) {
        expect(prompt.actorRole).toMatch(/human_user|personal_agent/);
        if (prompt.instructions.includes('陈晨的个人助手')) {
          return '我是陈晨的个人助手：陈晨需要补访谈材料，我建议把截图补充时间定在今晚 21:30。';
        }
        if (prompt.instructions.includes('林雯的个人助手')) {
          return '我是林雯的个人助手：我已读取授权文件和小组任务，文件可代发，时间变更需要人工确认。';
        }
        if (prompt.instructions.includes('赵一鸣')) {
          return '今晚先把报告结构锁定，林雯负责演示稿，陈晨补访谈附件。';
        }
        return '我刚补了访谈纪要，但还需要林雯把最新材料发一下。';
      }
    };
    const sentMessages: Message[] = [];
    const matrixGateway: DemoMatrixGateway = {
      async uploadMedia(input) {
        return {
          mxcUri: `mxc://demo/${encodeURIComponent(input.filename)}`,
          size: input.bytes.byteLength
        };
      },
      async sendMessage(_state, input, options = {}) {
        const message: Message = {
          id: `mx-${sentMessages.length + 1}`,
          roomId: input.roomId,
          senderId: input.senderId,
          senderName: input.senderId,
          body: options.fileName ?? input.body,
          sentAt: '2026-05-04T08:30:00.000Z',
          type: options.agentLabel ? 'agent' : options.fileId ? 'file' : 'text',
          agentLabel: options.agentLabel,
          sourceAgentId: options.sourceAgentId,
          fileId: options.fileId,
          mxcUri: options.mxcUri,
          contentType: options.mimeType,
          size: options.size
        };
        sentMessages.push(message);
        return message;
      }
    };

    const result = await runAiDemoScenario({
      state: createDemoState(),
      aiProvider,
      matrixGateway,
      now: '2026-05-04T08:30:00.000Z'
    });

    expect(result.state.files.filter((file) => file.tags.includes('ai-seed'))).toHaveLength(6);
    expect(sentMessages.some((message) => message.agentLabel === '个人助手代发')).toBe(true);
    expect(sentMessages.some((message) => message.agentLabel === '个人助手协商')).toBe(true);
    expect(result.state.actionRequests.some((request) => request.kind === 'share_file')).toBe(true);
    expect(result.state.actionLogs.some((log) => log.toolCalls.includes('ai_provider.generate_text'))).toBe(true);
    expect(result.state.actionLogs.some((log) => log.toolCalls.includes('deepseek.flash.chat.completions'))).toBe(true);
    expect(result.state.actionLogs.some((log) => log.toolCalls.includes('deepseek.pro.chat.completions'))).toBe(true);
    expect(result.transcript.length).toBeGreaterThanOrEqual(6);
  });
});
