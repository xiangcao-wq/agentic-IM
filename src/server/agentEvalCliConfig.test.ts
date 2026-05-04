// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveAgentEvalCliConfig } from './agentEvalCliConfig';

describe('agent eval CLI config', () => {
  it('fails fast when real eval is requested without a DeepSeek key', () => {
    expect(() => resolveAgentEvalCliConfig(['--real'], {})).toThrow(
      'DEEPSEEK_API_KEY is required for npm run eval:agent:real'
    );
  });

  it('keeps deterministic fallback eval when real mode is not requested', () => {
    expect(resolveAgentEvalCliConfig([], {})).toEqual({ useRealProvider: false });
  });

  it('enables real provider mode when a key is configured', () => {
    expect(resolveAgentEvalCliConfig(['--real'], { DEEPSEEK_API_KEY: 'sk-test' })).toEqual({
      useRealProvider: true
    });
  });
});
