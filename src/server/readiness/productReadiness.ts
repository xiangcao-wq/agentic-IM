import type { AuthConfig } from '../security/auth';

export interface ReadinessCheck {
  ok: boolean;
  status: 'ready' | 'degraded' | 'blocked' | 'disabled';
  message: string;
}

export interface ProductReadiness {
  ok: boolean;
  checkedAt: string;
  checks: {
    auth: ReadinessCheck & {
      mode: AuthConfig['mode'];
      requireAuth: boolean;
      allowQueryToken: boolean;
      tokenConfigured: boolean;
      allowedOrigins: string[];
    };
    storage: ReadinessCheck & { mode: string };
    worker: ReadinessCheck & { autopilotEnabled: boolean; running: boolean };
    connector: ReadinessCheck & { matrixEnabled: boolean; bootstrapMode: string };
    provider: ReadinessCheck & { configured: boolean; provider: string; health: string };
  };
}

export interface ProductReadinessInput {
  auth: {
    mode: AuthConfig['mode'];
    requireAuth: boolean;
    allowQueryToken: boolean;
    tokenConfigured: boolean;
    allowedOrigins: string[];
  };
  storage: { mode: string; writable: boolean };
  worker: { autopilotEnabled: boolean; running: boolean; lastError?: string };
  connector: { matrixEnabled: boolean; bootstrapMode: string };
  provider: { configured: boolean; provider: string; health: string };
}

export function buildProductReadiness(input: ProductReadinessInput): ProductReadiness {
  const checks: ProductReadiness['checks'] = {
    auth: buildAuthCheck(input.auth),
    storage: buildStorageCheck(input.storage),
    worker: buildWorkerCheck(input.worker),
    connector: buildConnectorCheck(input.connector),
    provider: buildProviderCheck(input.provider)
  };

  return {
    ok: Object.values(checks).every((check) => check.ok),
    checkedAt: new Date().toISOString(),
    checks
  };
}

function buildAuthCheck(input: ProductReadinessInput['auth']): ProductReadiness['checks']['auth'] {
  if (input.mode === 'production-open') {
    return authCheck(input, {
      ok: false,
      status: 'blocked',
      message: 'production-open mode is not allowed for product readiness'
    });
  }

  if (input.mode === 'local-demo') {
    return authCheck(input, {
      ok: false,
      status: 'degraded',
      message: 'Local demo mode is not product-ready; configure token auth for product readiness.'
    });
  }

  if (input.mode === 'local-token') {
    const blockers = localTokenAuthBlockers(input);
    return authCheck(input, {
      ok: blockers.length === 0,
      status: blockers.length === 0 ? 'ready' : 'blocked',
      message:
        blockers.length === 0
          ? input.allowQueryToken
            ? 'Local token auth is enforced; local query-token compatibility is active.'
            : 'Local token auth is enforced.'
          : `Local token auth is blocked: ${blockers.join('; ')}.`
    });
  }

  const blockers = productAuthBlockers(input);
  return authCheck(input, {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'ready' : 'blocked',
    message: blockers.length === 0 ? 'Product auth is enforced.' : `Product auth is blocked: ${blockers.join('; ')}.`
  });
}

function authCheck(
  input: ProductReadinessInput['auth'],
  check: Pick<ReadinessCheck, 'ok' | 'status' | 'message'>
): ProductReadiness['checks']['auth'] {
  return {
    ...check,
    mode: input.mode,
    requireAuth: input.requireAuth,
    allowQueryToken: input.allowQueryToken,
    tokenConfigured: input.tokenConfigured,
    allowedOrigins: [...input.allowedOrigins]
  };
}

function productAuthBlockers(input: ProductReadinessInput['auth']): string[] {
  const blockers: string[] = [];

  if (!input.requireAuth) {
    blockers.push('auth is not required');
  }
  if (!input.tokenConfigured) {
    blockers.push('API token is not configured');
  }
  if (input.allowQueryToken) {
    blockers.push('query-string tokens are allowed');
  }
  if (input.allowedOrigins.length === 0) {
    blockers.push('no allowed CORS origins are configured');
  }

  return blockers;
}

function localTokenAuthBlockers(input: ProductReadinessInput['auth']): string[] {
  const blockers: string[] = [];

  if (!input.requireAuth) {
    blockers.push('auth is not required');
  }
  if (!input.tokenConfigured) {
    blockers.push('API token is not configured');
  }

  return blockers;
}

function buildStorageCheck(input: ProductReadinessInput['storage']): ProductReadiness['checks']['storage'] {
  return {
    ok: input.writable,
    status: input.writable ? 'ready' : 'blocked',
    message: input.writable ? 'Local JSON storage is writable.' : 'Local JSON storage is not writable.',
    mode: input.mode
  };
}

function buildWorkerCheck(input: ProductReadinessInput['worker']): ProductReadiness['checks']['worker'] {
  if (input.lastError) {
    return {
      ok: false,
      status: 'degraded',
      message: 'Autopilot worker reported an error; check server logs.',
      autopilotEnabled: input.autopilotEnabled,
      running: input.running
    };
  }

  return {
    ok: true,
    status: 'ready',
    message: input.autopilotEnabled
      ? 'Autopilot worker is available.'
      : 'Autopilot worker is disabled by configuration.',
    autopilotEnabled: input.autopilotEnabled,
    running: input.running
  };
}

function buildConnectorCheck(input: ProductReadinessInput['connector']): ProductReadiness['checks']['connector'] {
  const localMode = input.bootstrapMode === 'local';
  const ready = input.matrixEnabled || localMode;

  return {
    ok: ready,
    status: ready ? 'ready' : 'disabled',
    message: input.matrixEnabled
      ? 'Matrix connector is enabled.'
      : localMode
        ? 'Matrix connector is disabled; using local message storage.'
        : 'Matrix connector is not enabled.',
    matrixEnabled: input.matrixEnabled,
    bootstrapMode: input.bootstrapMode
  };
}

function buildProviderCheck(input: ProductReadinessInput['provider']): ProductReadiness['checks']['provider'] {
  if (!input.configured) {
    return {
      ok: false,
      status: 'degraded',
      message: 'AI provider is not configured; fallback responses may be used.',
      configured: input.configured,
      provider: input.provider,
      health: input.health
    };
  }

  if (input.health === 'failed' || input.health === 'missing' || input.health === 'unknown') {
    return {
      ok: false,
      status: 'degraded',
      message: `AI provider health is ${input.health}.`,
      configured: input.configured,
      provider: input.provider,
      health: input.health
    };
  }

  return {
    ok: true,
    status: 'ready',
    message: `AI provider health is ${input.health}.`,
    configured: input.configured,
    provider: input.provider,
    health: input.health
  };
}
