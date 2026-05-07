import { spawn } from 'node:child_process';

const requiredReadinessChecks = ['auth', 'storage', 'worker', 'connector', 'provider'];

export const defaultChecks = [
  { name: 'unit tests', script: 'test' },
  { name: 'typecheck and build', script: 'build' },
  { name: 'local agent eval', script: 'eval:agent' },
  { name: 'real provider agent eval', script: 'eval:agent:real', skipInLocalDemo: true },
  { name: 'browser smoke', script: 'smoke:browser' },
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
  const response = await fetchImpl(readinessUrl, {
    headers: token ? { 'x-agent-im-token': token } : {}
  });
  if (!response.ok) {
    throw new Error(`/api/readiness failed with ${response.status}`);
  }
  const body = await response.json();
  validateReadinessBody(body, options);
  return body;
}

export function formatDuration(ms) {
  return `${Math.round(ms / 100) / 10}s`;
}

function runCheck(check, options) {
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

  return runTimedCheck(check, () => checkReadinessEndpoint(baseUrl, token, fetchImpl, { localDemo: options.localDemo }));
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
  return '';
}

function validateReadinessBody(body, options = {}) {
  const checks = body?.checks;
  if (!checks || requiredReadinessChecks.some((name) => !checks[name])) {
    throw new Error('/api/readiness response is missing required checks');
  }

  const localDemo = options.localDemo ?? false;
  const unhealthyCheckName = requiredReadinessChecks.find((name) => {
    const check = checks[name];
    if (check.ok === true) {
      return false;
    }
    return !localDemo || !isAllowedLocalDemoDegradedCheck(name, check);
  });

  if (unhealthyCheckName) {
    throw new Error(`/api/readiness reported ${unhealthyCheckName} is not ready`);
  }

  if (body.ok !== true && (!localDemo || requiredReadinessChecks.every((name) => checks[name].ok === true))) {
    throw new Error('/api/readiness reported overall readiness is not ready');
  }
}

function isAllowedLocalDemoDegradedCheck(name, check) {
  if (name === 'auth') {
    return check.ok === false && check.status === 'degraded' && check.mode === 'local-demo';
  }

  if (name === 'provider') {
    return (
      check.ok === false &&
      check.status === 'degraded' &&
      check.configured === false &&
      check.provider === 'fallback' &&
      check.health === 'missing'
    );
  }

  return false;
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
