// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
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
    const fetcher = vi.fn(async () =>
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
    const fetcher = vi.fn(async () =>
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
});
