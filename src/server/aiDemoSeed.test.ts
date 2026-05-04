// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { DemoState, Message } from '../domain/types';
import type { AiProvider } from './aiProvider';
import type { DemoMatrixGateway } from './aiDemoScenario';
import { createAiDemoSeedProvider, runAiDemoSeed } from './aiDemoSeed';
import type { StateStore } from './stateStore';

describe('AI demo seed runner', () => {
  it('fails before touching state or Matrix when the DeepSeek key is missing', async () => {
    const calls: string[] = [];
    const stateStore = createStateStore(calls);
    const matrixGateway = createMatrixGateway(calls);
    const aiProvider: AiProvider = {
      async generateText() {
        calls.push('generateText');
        return 'should not generate';
      }
    };

    await expect(
      runAiDemoSeed({
        env: {},
        stateStore,
        matrixGateway,
        aiProvider
      })
    ).rejects.toThrow(/DEEPSEEK_API_KEY/);

    expect(calls).toEqual([]);
  });

  it('preflights DeepSeek flash and pro routes before touching state or Matrix', async () => {
    const calls: string[] = [];
    const stateStore = createStateStore(calls);
    const matrixGateway = createMatrixGateway(calls);
    const aiProvider: AiProvider = {
      async generateText(prompt) {
        calls.push(`preflight:${prompt.actorRole}`);
        if (prompt.actorRole === 'personal_agent') {
          throw new Error('DeepSeek pro route rejected');
        }
        return 'ok';
      }
    };

    await expect(
      runAiDemoSeed({
        env: { DEEPSEEK_API_KEY: 'deepseek-test' },
        stateStore,
        matrixGateway,
        aiProvider
      })
    ).rejects.toThrow('DeepSeek pro route rejected');

    expect(calls).toEqual(['preflight:human_user', 'preflight:personal_agent']);
  });

  it('runs the AI scenario and persists generated assets, tool logs, and action requests', async () => {
    const calls: string[] = [];
    let writtenState: DemoState | undefined;
    const stateStore: StateStore = {
      async init() {
        calls.push('init');
      },
      async read() {
        calls.push('read');
        return createDemoState();
      },
      async write(state) {
        calls.push('write');
        writtenState = state;
      }
    };
    const sentMessages: Message[] = [];
    const matrixGateway = createMatrixGateway(calls, sentMessages);
    const aiProvider: AiProvider = {
      async generateText(prompt) {
        calls.push('generateText');
        if (prompt.actorRole === 'personal_agent') {
          return 'Agent 已基于授权上下文推进任务，并把风险边界写入协商记录。';
        }
        return '我需要小组最新文件，并确认今晚合稿安排。';
      }
    };

    const summary = await runAiDemoSeed({
      env: { DEEPSEEK_API_KEY: 'deepseek-test' },
      stateStore,
      matrixGateway,
      aiProvider,
      now: '2026-05-04T08:30:00.000Z'
    });

    expect(calls.slice(0, 2)).toEqual(['generateText', 'generateText']);
    expect(calls).toContain('init');
    expect(calls).toContain('write');
    expect(summary.matrixEvents).toBeGreaterThanOrEqual(6);
    expect(summary.generatedFiles).toBe(3);
    expect(summary.agentActionRequests).toBeGreaterThanOrEqual(1);
    expect(writtenState?.files.filter((file) => file.tags.includes('ai-seed'))).toHaveLength(3);
    expect(writtenState?.actionLogs.some((log) => log.toolCalls.includes('ai_provider.generate_text'))).toBe(true);
    expect(sentMessages.some((message) => message.agentLabel === '陈晨的 Agent 协调')).toBe(true);
  });

  it('routes human users to DeepSeek Flash and personal Agents to DeepSeek Pro', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      return Response.json({
        choices: [
          {
            message: {
              content: body.model === 'deepseek-v4-flash' ? 'Flash human turn' : 'Pro agent turn'
            }
          }
        ]
      });
    };
    const provider = createAiDemoSeedProvider(
      {
        DEEPSEEK_API_KEY: 'deepseek-key',
        DEEPSEEK_BASE_URL: 'https://api.deepseek.test'
      },
      fetcher as typeof fetch
    );

    await expect(
      provider.generateText({
        actorRole: 'human_user',
        instructions: 'human',
        input: 'message'
      })
    ).resolves.toBe('Flash human turn');
    await expect(
      provider.generateText({
        actorRole: 'personal_agent',
        instructions: 'agent',
        input: 'message'
      })
    ).resolves.toBe('Pro agent turn');

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.deepseek.test/chat/completions',
      'https://api.deepseek.test/chat/completions'
    ]);
    expect(calls.map((call) => call.body.model)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(calls.map((call) => call.body.thinking)).toEqual([
      { type: 'disabled' },
      { type: 'disabled' }
    ]);
  });

  it('allows overriding DeepSeek flash and pro model names independently', async () => {
    const models: unknown[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      models.push(body.model);
      return Response.json({
        choices: [
          {
            message: {
              content: 'ok'
            }
          }
        ]
      });
    };
    const provider = createAiDemoSeedProvider(
      {
        DEEPSEEK_API_KEY: 'deepseek-key',
        DEEPSEEK_HUMAN_MODEL: 'deepseek-flash-custom',
        DEEPSEEK_AGENT_MODEL: 'deepseek-pro-custom'
      },
      fetcher as typeof fetch
    );

    await provider.generateText({ actorRole: 'human_user', instructions: 'human', input: 'message' });
    await provider.generateText({ actorRole: 'personal_agent', instructions: 'agent', input: 'message' });

    expect(models).toEqual(['deepseek-flash-custom', 'deepseek-pro-custom']);
  });
});

function createStateStore(calls: string[]): StateStore {
  return {
    async init() {
      calls.push('init');
    },
    async read() {
      calls.push('read');
      return createDemoState();
    },
    async write() {
      calls.push('write');
    }
  };
}

function createMatrixGateway(calls: string[], sentMessages: Message[] = []): DemoMatrixGateway {
  return {
    async uploadMedia(input) {
      calls.push(`upload:${input.filename}`);
      return {
        mxcUri: `mxc://demo/${encodeURIComponent(input.filename)}`,
        size: input.bytes.byteLength
      };
    },
    async sendMessage(_state, input, options = {}) {
      calls.push(`send:${input.roomId}`);
      const message: Message = {
        id: `mx-seed-${sentMessages.length + 1}`,
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
}
