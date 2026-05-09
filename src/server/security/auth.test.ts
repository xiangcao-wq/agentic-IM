// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  authorizeRequest,
  extractRequestToken,
  resolveAuthConfig,
  resolveCorsConfig,
  type AuthEnvironment
} from './auth';

function env(overrides: AuthEnvironment = {}): AuthEnvironment {
  return overrides;
}

function request(headers: Record<string, string> = {}, method = 'GET') {
  return { headers, method };
}

function url(path: string): URL {
  return new URL(path, 'http://127.0.0.1:5175');
}

describe('central auth policy', () => {
  it('leaves local demo mode open when no token is configured', () => {
    expect(resolveAuthConfig(env())).toEqual({
      apiToken: undefined,
      requireAuth: false,
      allowQueryToken: true,
      mode: 'local-demo'
    });
  });

  it('requires an API token in public mode', () => {
    expect(() => resolveAuthConfig(env({ AGENT_IM_PUBLIC_MODE: 'true' }))).toThrow(
      'AGENT_IM_API_TOKEN is required when auth is required'
    );
  });

  it('requires an API token in production mode', () => {
    expect(() => resolveAuthConfig(env({ NODE_ENV: 'production' }))).toThrow(
      'AGENT_IM_API_TOKEN is required when auth is required'
    );
  });

  it('allows explicit no-auth production mode', () => {
    expect(resolveAuthConfig(env({ NODE_ENV: 'production', AGENT_IM_ALLOW_NO_AUTH: 'true' }))).toEqual({
      apiToken: undefined,
      requireAuth: false,
      allowQueryToken: false,
      mode: 'production-open'
    });
  });

  it('rejects query-string tokens in product mode', () => {
    const config = resolveAuthConfig(
      env({ AGENT_IM_PUBLIC_MODE: 'true', AGENT_IM_API_TOKEN: 'local-secret' })
    );

    expect(config).toEqual({
      apiToken: 'local-secret',
      requireAuth: true,
      allowQueryToken: false,
      mode: 'public'
    });
    expect(extractRequestToken(request(), url('/api/state?agent_im_token=local-secret'), config)).toBeUndefined();
    expect(authorizeRequest(request(), url('/api/state?agent_im_token=local-secret'), config)).toBe(false);
  });

  it('accepts header and Bearer tokens when auth is required', () => {
    const config = resolveAuthConfig(
      env({ AGENT_IM_PUBLIC_MODE: 'true', AGENT_IM_API_TOKEN: 'local-secret' })
    );

    expect(authorizeRequest(request({ 'x-agent-im-token': 'local-secret' }), url('/api/state'), config)).toBe(true);
    expect(
      authorizeRequest(request({ authorization: 'Bearer local-secret' }), url('/api/state'), config)
    ).toBe(true);
  });

  it('allows query-string tokens in local compatibility mode when an API token exists', () => {
    const config = resolveAuthConfig(env({ AGENT_IM_API_TOKEN: 'local-secret' }));

    expect(config).toEqual({
      apiToken: 'local-secret',
      requireAuth: true,
      allowQueryToken: true,
      mode: 'local-token'
    });
    expect(extractRequestToken(request(), url('/api/events?agent_im_token=local-secret'), config)).toBe(
      'local-secret'
    );
    expect(authorizeRequest(request(), url('/api/events?agent_im_token=local-secret'), config)).toBe(true);
  });

  it('requires explicit CORS origins in product mode', () => {
    expect(() => resolveCorsConfig(env({ AGENT_IM_PUBLIC_MODE: 'true' }))).toThrow(
      'AGENT_IM_ALLOWED_ORIGINS is required in product mode'
    );
  });

  it('parses comma-separated CORS origins', () => {
    expect(
      resolveCorsConfig(
        env({
          AGENT_IM_PUBLIC_MODE: 'true',
          AGENT_IM_ALLOWED_ORIGINS: 'https://agentbridge.example.com, https://console.agentbridge.example.com'
        })
      )
    ).toEqual({
      allowedOrigins: ['https://agentbridge.example.com', 'https://console.agentbridge.example.com'],
      allowOriginlessRequests: true
    });
  });
});
