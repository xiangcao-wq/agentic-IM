import { spawn } from 'node:child_process';

export const defaultChecks = [
  { name: 'unit tests', script: 'test' },
  { name: 'typecheck and build', script: 'build' },
  { name: 'local agent eval', script: 'eval:agent' },
  { name: 'real provider agent eval', script: 'eval:agent:real', skipInLocalDemo: true },
  { name: 'browser smoke', script: 'smoke:browser' },
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
      log(`[readiness] SKIP ${check.name} (${check.script}) because --local-demo was provided.`);
      continue;
    }

    log(`[readiness] RUN  ${check.name} (${check.script})`);
    const result = await runNpmScript(check, options);
    results.push(result);

    if (result.status !== 'passed') {
      error(`[readiness] FAIL ${check.name} (${check.script}) after ${formatDuration(result.durationMs)}`);
      if (result.error) {
        error(`[readiness] ${result.error}`);
      }
      break;
    }

    log(`[readiness] PASS ${check.name} (${check.script}) in ${formatDuration(result.durationMs)}`);
  }

  return results;
}

export function formatDuration(ms) {
  return `${Math.round(ms / 100) / 10}s`;
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
