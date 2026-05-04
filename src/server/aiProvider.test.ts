// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  getAiUsageSnapshot,
  OpenAiChatCompletionsProvider,
  OpenAiResponsesProvider,
  RoleRoutedAiProvider
} from './aiProvider';

describe('OpenAiResponsesProvider', () => {
  it('requires an API key for real AI generation', async () => {
    const provider = new OpenAiResponsesProvider({ apiKey: '', model: 'gpt-test' });

    await expect(
      provider.generateText({
        instructions: 'You are a user.',
        input: 'Say hello.'
      })
    ).rejects.toThrow('OPENAI_API_KEY is required');
  });

  it('calls the Responses API and returns output text', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        output_text: '真实 AI 角色消息'
      })
    );
    const provider = new OpenAiResponsesProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.test',
      model: 'gpt-test',
      fetcher
    });

    const text = await provider.generateText({
      instructions: 'Act as a classmate.',
      input: 'Write one short message.',
      maxOutputTokens: 80
    });

    expect(text).toBe('真实 AI 角色消息');
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.test/v1/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer test-key',
          'content-type': 'application/json'
        }),
        body: JSON.stringify({
          model: 'gpt-test',
          instructions: 'Act as a classmate.',
          input: 'Write one short message.',
          max_output_tokens: 80
        })
      })
    );
  });
});

describe('OpenAiChatCompletionsProvider', () => {
  it('requires a provider-specific API key', async () => {
    const provider = new OpenAiChatCompletionsProvider({
      providerName: 'DeepSeek',
      apiKey: '',
      baseUrl: 'https://api.deepseek.test',
      model: 'deepseek-v4-pro'
    });

    await expect(
      provider.generateText({
        actorRole: 'human_user',
        instructions: 'Act as a classmate.',
        input: 'Write one message.'
      })
    ).rejects.toThrow('DeepSeek API key is required');
  });

  it('calls an OpenAI-compatible chat completions endpoint and returns message content', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        choices: [
          {
            message: {
              content: 'DeepSeek 生成的人类消息'
            }
          }
        ]
      })
    );
    const provider = new OpenAiChatCompletionsProvider({
      providerName: 'DeepSeek',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.test',
      model: 'deepseek-v4-pro',
      fetcher
    });

    const text = await provider.generateText({
      actorRole: 'human_user',
      instructions: 'Act as a classmate.',
      input: 'Write one short message.',
      maxOutputTokens: 80
    });

    expect(text).toBe('DeepSeek 生成的人类消息');
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.deepseek.test/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer deepseek-key',
          'content-type': 'application/json'
        }),
        body: JSON.stringify({
          model: 'deepseek-v4-pro',
          messages: [
            { role: 'system', content: 'Act as a classmate.' },
            { role: 'user', content: 'Write one short message.' }
          ],
          max_tokens: 80,
          stream: false
        })
      })
    );
  });

  it('passes DeepSeek JSON mode and thinking options only when requested', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        choices: [
          {
            message: {
              content: '{"ok":true}'
            }
          }
        ]
      })
    );
    const provider = new OpenAiChatCompletionsProvider({
      providerName: 'DeepSeek',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.test',
      model: 'deepseek-chat',
      fetcher
    });

    await provider.generateText({
      actorRole: 'personal_agent',
      instructions: 'Return strict json.',
      input: 'Return {"ok":true}',
      responseFormat: 'json_object',
      thinking: { type: 'enabled' }
    });

    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.thinking).toEqual({ type: 'enabled' });
  });

  it('falls back to DeepSeek reasoning_content when message content is empty', async () => {
    const provider = new OpenAiChatCompletionsProvider({
      providerName: 'DeepSeek',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.test',
      model: 'deepseek-v4-pro',
      fetcher: (async () =>
        Response.json({
          choices: [
            {
              message: {
                content: '',
                reasoning_content: 'ok'
              }
            }
          ]
        })) as typeof fetch
    });

    await expect(provider.generateText({
      actorRole: 'personal_agent',
      instructions: 'reply ok',
      input: 'ok'
    })).resolves.toBe('ok');
  });

  it('can send cache-friendly multi-message prompts while preserving legacy input', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        choices: [
          {
            message: {
              content: 'ok'
            }
          }
        ]
      })
    );
    const provider = new OpenAiChatCompletionsProvider({
      providerName: 'DeepSeek',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.test',
      model: 'deepseek-chat',
      fetcher
    });

    await provider.generateText({
      actorRole: 'personal_agent',
      instructions: 'legacy system',
      input: 'legacy combined input',
      messages: [
        { role: 'system', content: 'stable system' },
        { role: 'user', content: 'stable authorized context' },
        { role: 'user', content: 'volatile memory and current request' }
      ]
    });

    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body)) as { messages: Array<Record<string, string>> };
    expect(body.messages).toEqual([
      { role: 'system', content: 'stable system' },
      { role: 'user', content: 'stable authorized context' },
      { role: 'user', content: 'volatile memory and current request' }
    ]);
  });

  it('tracks DeepSeek prompt cache usage from chat completions responses', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: 'ok'
            }
          }
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_cache_hit_tokens: 72,
          prompt_cache_miss_tokens: 28
        }
      })
    );
    const provider = new OpenAiChatCompletionsProvider({
      providerName: 'DeepSeek',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.test',
      model: 'deepseek-chat',
      fetcher
    });

    await provider.generateText({
      actorRole: 'personal_agent',
      instructions: 'Reply ok.',
      input: 'ok'
    });

    expect(getAiUsageSnapshot(provider)).toMatchObject({
      requestCount: 1,
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      promptCacheHitTokens: 72,
      promptCacheMissTokens: 28,
      promptCacheHitRate: 0.72
    });
  });
});

describe('RoleRoutedAiProvider', () => {
  it('routes human actors and personal agents to separate model providers', async () => {
    const calls: string[] = [];
    const provider = new RoleRoutedAiProvider({
      humanProvider: {
        async generateText(prompt) {
          calls.push(`human:${prompt.actorRole}`);
          return 'human text';
        }
      },
      agentProvider: {
        async generateText(prompt) {
          calls.push(`agent:${prompt.actorRole}`);
          return 'agent text';
        }
      }
    });

    await expect(
      provider.generateText({
        actorRole: 'human_user',
        instructions: 'human',
        input: 'message'
      })
    ).resolves.toBe('human text');
    await expect(
      provider.generateText({
        actorRole: 'personal_agent',
        instructions: 'agent',
        input: 'message'
      })
    ).resolves.toBe('agent text');

    expect(calls).toEqual(['human:human_user', 'agent:personal_agent']);
  });

  it('aggregates cache usage snapshots from routed providers', () => {
    const provider = new RoleRoutedAiProvider({
      humanProvider: createUsageProvider({
        requestCount: 1,
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
        promptCacheHitTokens: 60,
        promptCacheMissTokens: 40,
        promptCacheHitRate: 0.6,
        lastUpdatedAt: '2026-05-04T00:00:00.000Z'
      }),
      agentProvider: createUsageProvider({
        requestCount: 1,
        promptTokens: 200,
        completionTokens: 20,
        totalTokens: 220,
        promptCacheHitTokens: 140,
        promptCacheMissTokens: 60,
        promptCacheHitRate: 0.7,
        lastUpdatedAt: '2026-05-04T00:00:01.000Z'
      })
    });

    expect(getAiUsageSnapshot(provider)).toMatchObject({
      requestCount: 2,
      promptTokens: 300,
      completionTokens: 30,
      totalTokens: 330,
      promptCacheHitTokens: 200,
      promptCacheMissTokens: 100,
      promptCacheHitRate: 2 / 3
    });
    expect(getAiUsageSnapshot(provider)?.routes?.map((route) => route.role)).toEqual(['human_user', 'personal_agent']);
  });
});

function createUsageProvider(snapshot: NonNullable<ReturnType<typeof getAiUsageSnapshot>>) {
  return {
    async generateText() {
      return 'ok';
    },
    getUsageSnapshot() {
      return snapshot;
    }
  };
}
