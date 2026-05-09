import { spawn } from 'node:child_process';

const requiredReadinessChecks = ['auth', 'storage', 'worker', 'connector', 'provider', 'eventLog'];
const defaultReadinessTimeoutMs = 15_000;

export const defaultChecks = [
  { name: 'unit tests', script: 'test' },
  { name: 'typecheck and build', script: 'build' },
  { name: 'local agent eval', script: 'eval:agent' },
  { name: 'real provider agent eval', script: 'eval:agent:real', skipInLocalDemo: true },
  { name: 'browser smoke', script: 'smoke:browser' },
  { name: 'readiness auth boundary', readinessAuthBoundary: true, skipInLocalDemo: true },
  { name: 'readiness endpoint', readinessEndpoint: true },
  { name: 'Matrix and API smoke', script: 'infra:smoke', skipInLocalDemo: true }
];

export async function runReadinessChecks(checks, options = {}) {
  const localDemo = options.localDemo ?? false;
  const results = [];
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;

  for (const check of checks) {
    if (localDemo && check.skipInLocalDemo) {
      const skipped = { ...check, status: 'skipped', durationMs: 0, reason: '--local-demo' };
      results.push(skipped);
      log(`[readiness] SKIP ${check.name}${formatCheckTarget(check)} because --local-demo was provided.`);
      continue;
    }

    log(`[readiness] RUN  ${check.name}${formatCheckTarget(check)}`);
    const result = await runCheck(check, options);
    results.push(result);

    if (result.status !== 'passed') {
      error(`[readiness] FAIL ${check.name}${formatCheckTarget(check)} after ${formatDuration(result.durationMs)}`);
      if (result.error) {
        error(`[readiness] ${result.error}`);
      }
      break;
    }

    log(`[readiness] PASS ${check.name}${formatCheckTarget(check)} in ${formatDuration(result.durationMs)}`);
  }

  return results;
}

export async function checkReadinessEndpoint(baseUrl, token, fetchImpl = fetch, options = {}) {
  const readinessUrl = `${baseUrl.replace(/\/+$/, '')}/api/readiness`;
  const requestInit = {
    headers: token ? { 'x-agent-im-token': token } : {}
  };
  const response = await fetchWithTimeout(fetchImpl, readinessUrl, requestInit, options, '/api/readiness');

  if (!response.ok) {
    const bodyText = sanitizeForReadinessError(await readResponseText(response), token);
    const bodyDetail = bodyText ? `; body: ${bodyText}` : '';
    throw new Error(`${readinessUrl} failed with ${response.status}${bodyDetail}`);
  }
  const body = await response.json();
  validateReadinessBody(body, { ...options, token });
  return body;
}

export async function checkReadinessAuthBoundary(baseUrl, token, fetchImpl = fetch, options = {}) {
  if (!token) {
    throw new Error('AGENT_IM_API_TOKEN or VITE_AGENT_API_TOKEN is required for readiness auth boundary check');
  }

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const probes = [
    {
      label: 'no-token readiness request',
      url: `${normalizedBaseUrl}/api/readiness`
    },
    {
      label: 'query-token readiness request',
      url: `${normalizedBaseUrl}/api/readiness?agent_im_token=${encodeURIComponent(token)}`
    }
  ];

  for (const probe of probes) {
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, probe.url, {}, options, '/api/readiness auth boundary');
    } catch (error) {
      throw new Error(
        sanitizeForReadinessError(error instanceof Error ? error.message : String(error), token)
      );
    }
    const status = Number(response.status);
    if (status === 401 || status === 403) {
      continue;
    }

    const bodyText = sanitizeForReadinessError(await readResponseText(response), token);
    const bodyDetail = bodyText ? `; body: ${bodyText}` : '';
    throw new Error(`${probe.label} expected 401 or 403, received ${response.status ?? 'unknown'}${bodyDetail}`);
  }
}

export function formatDuration(ms) {
  return `${Math.round(ms / 100) / 10}s`;
}

function runCheck(check, options) {
  if (check.readinessAuthBoundary) {
    return runReadinessAuthBoundaryCheck(check, options);
  }

  if (check.readinessEndpoint) {
    return runReadinessEndpointCheck(check, options);
  }

  if (typeof check.run === 'function') {
    return runCustomCheck(check, options);
  }

  return runNpmScript(check, options);
}

function runReadinessEndpointCheck(check, options) {
  const env = options.env ?? process.env;
  const baseUrl =
    firstEnvValue(env, ['AGENT_IM_API_BASE', 'VITE_AGENT_API_BASE', 'AGENT_IM_API_URL']) ?? 'http://127.0.0.1:8791';
  const token = firstEnvValue(env, ['AGENT_IM_API_TOKEN', 'VITE_AGENT_API_TOKEN']) ?? '';
  const fetchImpl = options.fetchImpl ?? fetch;

  return runTimedCheck(check, () =>
    checkReadinessEndpoint(baseUrl, token, fetchImpl, {
      localDemo: options.localDemo,
      readinessTimeoutMs: options.readinessTimeoutMs,
      abortControllerFactory: options.abortControllerFactory,
      setTimeoutImpl: options.setTimeoutImpl,
      clearTimeoutImpl: options.clearTimeoutImpl
    })
  );
}

function runReadinessAuthBoundaryCheck(check, options) {
  const env = options.env ?? process.env;
  const baseUrl =
    firstEnvValue(env, ['AGENT_IM_API_BASE', 'VITE_AGENT_API_BASE', 'AGENT_IM_API_URL']) ?? 'http://127.0.0.1:8791';
  const token = firstEnvValue(env, ['AGENT_IM_API_TOKEN', 'VITE_AGENT_API_TOKEN']) ?? '';
  const fetchImpl = options.fetchImpl ?? fetch;

  return runTimedCheck(check, () =>
    checkReadinessAuthBoundary(baseUrl, token, fetchImpl, {
      readinessTimeoutMs: options.readinessTimeoutMs,
      abortControllerFactory: options.abortControllerFactory,
      setTimeoutImpl: options.setTimeoutImpl,
      clearTimeoutImpl: options.clearTimeoutImpl
    })
  );
}

function runCustomCheck(check, options) {
  return runTimedCheck(check, () => check.run(options));
}

async function runTimedCheck(check, callback) {
  const startedAt = Date.now();

  try {
    await callback();
    return {
      ...check,
      durationMs: Date.now() - startedAt,
      status: 'passed'
    };
  } catch (error) {
    return {
      ...check,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function runNpmScript(check, options) {
  const npmCommand = options.npmCommand ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const spawnCommand = options.spawnCommand ?? spawn;
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;

    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        ...check,
        durationMs: Date.now() - startedAt,
        ...result
      });
    }

    let child;
    try {
      const invocation = createNpmInvocation(npmCommand, check.script);
      child = spawnCommand(invocation.command, invocation.args, {
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      finish({ status: 'failed', error: error.message });
      return;
    }

    child.stdout?.on('data', (chunk) => stdout.write(chunk));
    child.stderr?.on('data', (chunk) => stderr.write(chunk));

    child.on('error', (error) => {
      finish({ status: 'failed', error: error.message });
    });

    child.on('exit', (code, signal) => {
      finish({
        status: code === 0 ? 'passed' : 'failed',
        code,
        signal
      });
    });
  });
}

function formatCheckTarget(check) {
  if (check.script) {
    return ` (${check.script})`;
  }
  if (check.readinessEndpoint) {
    return ' (/api/readiness)';
  }
  if (check.readinessAuthBoundary) {
    return ' (/api/readiness auth boundary)';
  }
  return '';
}

function validateReadinessBody(body, options = {}) {
  const checks = body?.checks;
  if (!checks || requiredReadinessChecks.some((name) => !checks[name])) {
    throw new Error('/api/readiness response is missing required checks');
  }

  const localDemo = options.localDemo ?? false;
  const checkEntries = Object.entries(checks);
  const failingCheckEntry = checkEntries.find(([name, check]) => {
    if (check?.ok === true) {
      return false;
    }
    return !localDemo || !isAllowedLocalDemoDegradedCheck(name, check);
  });

  if (failingCheckEntry) {
    throw new Error(formatReadinessCheckFailure(failingCheckEntry[0], failingCheckEntry[1], options.token));
  }

  const hasOnlyAllowedLocalDemoFailures =
    localDemo &&
    checkEntries.some(([, check]) => check?.ok !== true) &&
    checkEntries.every(([name, check]) => check?.ok === true || isAllowedLocalDemoDegradedCheck(name, check));

  if (body.ok !== true && !hasOnlyAllowedLocalDemoFailures) {
    throw new Error('/api/readiness reported overall readiness is not ready');
  }
}

function formatReadinessCheckFailure(name, check, token) {
  const status = sanitizeForReadinessError(formatOptionalField(check?.status, 'unknown'), token);
  const message = sanitizeForReadinessError(formatOptionalField(check?.message, 'none'), token);
  return `/api/readiness reported ${name} is not ready (status: ${status}, message: ${message})`;
}

function formatOptionalField(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isAllowedLocalDemoDegradedCheck(name, check) {
  if (name === 'auth') {
    return check?.ok === false && check.status === 'degraded' && check.mode === 'local-demo';
  }

  if (name === 'provider') {
    return (
      check?.ok === false &&
      check.status === 'degraded' &&
      check.configured === false &&
      check.provider === 'fallback' &&
      check.health === 'missing'
    );
  }

  return false;
}

async function readResponseText(response) {
  if (typeof response.text !== 'function') {
    return '';
  }

  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function fetchWithTimeout(fetchImpl, url, requestInit, options, timeoutLabel) {
  const timeoutMs = options.readinessTimeoutMs ?? defaultReadinessTimeoutMs;
  const abortController =
    timeoutMs > 0 ? options.abortControllerFactory?.() ?? new AbortController() : undefined;
  const init = { ...requestInit };
  if (abortController) {
    init.signal = abortController.signal;
  }

  let timedOut = false;
  let timeoutId;
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  const timeoutPromise =
    timeoutMs > 0
      ? new Promise((_, reject) => {
          timeoutId = setTimeoutImpl(() => {
            timedOut = true;
            abortController?.abort();
            reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      : undefined;

  try {
    return await (timeoutPromise
      ? Promise.race([fetchImpl(url, init), timeoutPromise])
      : fetchImpl(url, init));
  } catch (error) {
    if (timedOut) {
      throw new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeoutImpl(timeoutId);
    }
  }
}

function sanitizeForReadinessError(value, token) {
  let sanitized = String(value ?? '').slice(0, 1000);
  if (token) {
    sanitized = sanitized.split(token).join('[redacted]');
  }
  return sanitized
    .replace(/(x-agent-im-token\s*[:=]\s*)([^\s,;]+)/gi, '$1[redacted]')
    .replace(/(Authorization\s*:\s*Bearer\s+)([^\s,;]+)/gi, '$1[redacted]')
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, '$1[redacted]');
}

function firstEnvValue(env, names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function createNpmInvocation(npmCommand, script) {
  if (process.platform === 'win32' || /\.cmd$/i.test(npmCommand) || /\.bat$/i.test(npmCommand)) {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `${npmCommand} run ${script}`]
    };
  }

  return {
    command: npmCommand,
    args: ['run', script]
  };
}
