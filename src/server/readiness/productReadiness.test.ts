import { describe, expect, it } from 'vitest';
import { buildProductReadiness, type ProductReadinessInput } from './productReadiness';

describe('buildProductReadiness', () => {
  it('reports ok when required product checks pass', () => {
    const readiness = buildProductReadiness({
      ...readyInput(),
      auth: {
        mode: 'public',
        requireAuth: true,
        allowQueryToken: false,
        tokenConfigured: true,
        allowedOrigins: ['https://agentbridge.example.com']
      }
    });

    expect(readiness.ok).toBe(true);
    expect(readiness.checkedAt).toEqual(expect.any(String));
    expect(readiness.checks.auth).toMatchObject({
      ok: true,
      status: 'ready',
      mode: 'public',
      requireAuth: true,
      allowQueryToken: false,
      tokenConfigured: true,
      allowedOrigins: ['https://agentbridge.example.com']
    });
    expect(readiness.checks.storage).toMatchObject({ ok: true, status: 'ready', mode: 'json-local' });
    expect(readiness.checks.worker).toMatchObject({
      ok: true,
      status: 'ready',
      autopilotEnabled: true,
      running: true
    });
    expect(readiness.checks.connector).toMatchObject({
      ok: true,
      status: 'ready',
      matrixEnabled: false,
      bootstrapMode: 'local'
    });
    expect(readiness.checks.provider).toMatchObject({
      ok: true,
      status: 'ready',
      configured: true,
      provider: 'deepseek',
      health: 'connected'
    });
  });

  it('reports production auth ready when product controls are enforced', () => {
    const readiness = buildProductReadiness({
      ...readyInput(),
      auth: {
        mode: 'production',
        requireAuth: true,
        allowQueryToken: false,
        tokenConfigured: true,
        allowedOrigins: ['https://agentbridge.example.com']
      }
    });

    expect(readiness.ok).toBe(true);
    expect(readiness.checks.auth).toMatchObject({
      ok: true,
      status: 'ready',
      mode: 'production',
      message: 'Product auth is enforced.'
    });
  });

  it('marks readiness as blocked when auth is open in public mode', () => {
    const readiness = buildProductReadiness({
      ...readyInput(),
      auth: {
        mode: 'public',
        requireAuth: false,
        allowQueryToken: true,
        tokenConfigured: false,
        allowedOrigins: []
      }
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks.auth.status).toBe('blocked');
    expect(readiness.checks.auth.ok).toBe(false);
  });

  it('blocks production-open auth for product readiness', () => {
    const readiness = buildProductReadiness({
      ...readyInput(),
      auth: {
        mode: 'production-open',
        requireAuth: false,
        allowQueryToken: false,
        tokenConfigured: false,
        allowedOrigins: ['https://agentbridge.example.com']
      }
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks.auth).toMatchObject({
      ok: false,
      status: 'blocked',
      message: 'production-open mode is not allowed for product readiness'
    });
  });

  it('allows local-token query-token compatibility while reporting it explicitly', () => {
    const readiness = buildProductReadiness({
      ...readyInput(),
      auth: {
        mode: 'local-token',
        requireAuth: true,
        allowQueryToken: true,
        tokenConfigured: true,
        allowedOrigins: ['http://127.0.0.1:5175']
      }
    });

    expect(readiness.ok).toBe(true);
    expect(readiness.checks.auth).toMatchObject({
      ok: true,
      status: 'ready',
      mode: 'local-token',
      message: 'Local token auth is enforced; local query-token compatibility is active.'
    });
  });

  it('degrades local-demo auth because it is not product-ready', () => {
    const readiness = buildProductReadiness({
      ...readyInput(),
      auth: {
        mode: 'local-demo',
        requireAuth: false,
        allowQueryToken: true,
        tokenConfigured: false,
        allowedOrigins: ['http://127.0.0.1:5175']
      }
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks.auth).toMatchObject({
      ok: false,
      status: 'degraded',
      mode: 'local-demo'
    });
    expect(readiness.checks.auth.message).toContain('not product-ready');
    expect(readiness.checks.auth.message).not.toBe('Product auth is enforced.');
  });

  it('degrades provider readiness when configured provider health is failed or missing', () => {
    expect(
      buildProductReadiness({
        ...readyInput(),
        provider: { configured: true, provider: 'deepseek', health: 'failed' }
      }).checks.provider
    ).toMatchObject({ ok: false, status: 'degraded' });

    expect(
      buildProductReadiness({
        ...readyInput(),
        provider: { configured: true, provider: 'deepseek', health: 'missing' }
      }).checks.provider
    ).toMatchObject({ ok: false, status: 'degraded' });
  });

  it('degrades provider readiness when configured provider health is unknown', () => {
    const readiness = buildProductReadiness({
      ...readyInput(),
      provider: { configured: true, provider: 'deepseek', health: 'unknown' }
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks.provider).toMatchObject({ ok: false, status: 'degraded', health: 'unknown' });
  });

  it('degrades worker readiness when the worker has a last error', () => {
    const readiness = buildProductReadiness({
      ...readyInput(),
      worker: { autopilotEnabled: true, running: false, lastError: 'queue failed' }
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks.worker).toMatchObject({ ok: false, status: 'degraded' });
  });

  it('does not echo worker last errors that may contain secrets', () => {
    const readiness = buildProductReadiness({
      ...readyInput(),
      worker: {
        autopilotEnabled: true,
        running: false,
        lastError: 'upstream failed with x-agent-im-token local-secret and Authorization: Bearer abc'
      }
    });
    const serialized = JSON.stringify(readiness);

    expect(readiness.ok).toBe(false);
    expect(readiness.checks.worker).toMatchObject({
      ok: false,
      status: 'degraded',
      message: 'Autopilot worker reported an error; check server logs.'
    });
    expect(serialized).not.toContain('local-secret');
    expect(serialized).not.toContain('Bearer abc');
  });

  it('blocks storage readiness when local storage is not writable', () => {
    const readiness = buildProductReadiness({
      ...readyInput(),
      storage: { mode: 'json-local', writable: false }
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks.storage).toMatchObject({ ok: false, status: 'blocked' });
  });
});

function readyInput(): ProductReadinessInput {
  return {
    auth: {
      mode: 'public',
      requireAuth: true,
      allowQueryToken: false,
      tokenConfigured: true,
      allowedOrigins: ['https://agentbridge.example.com']
    },
    storage: { mode: 'json-local', writable: true },
    worker: { autopilotEnabled: true, running: true },
    connector: { matrixEnabled: false, bootstrapMode: 'local' },
    provider: { configured: true, provider: 'deepseek', health: 'connected' }
  };
}
