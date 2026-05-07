import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultChecks, runReadinessChecks } from './product-readiness-runner.mjs';

describe('product readiness runner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs npm checks without inheriting stdio handles', async () => {
    const calls = [];
    const spawnCommand = (_command, _args, options) => {
      calls.push(options);
      if (options.stdio === 'inherit') {
        throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
      }
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };

    const results = await runReadinessChecks(
      [{ name: 'unit tests', script: 'test' }],
      {
        localDemo: false,
        npmCommand: 'npm.cmd',
        spawnCommand,
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        log: vi.fn(),
        error: vi.fn(),
        env: {}
      }
    );

    expect(results).toMatchObject([{ name: 'unit tests', script: 'test', status: 'passed' }]);
    expect(calls[0].stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('runs npm.cmd checks through cmd.exe on Windows', async () => {
    const calls = [];
    const spawnCommand = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };

    await runReadinessChecks(
      [{ name: 'unit tests', script: 'test' }],
      {
        localDemo: false,
        npmCommand: 'npm.cmd',
        spawnCommand,
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        log: vi.fn(),
        error: vi.fn(),
        env: {}
      }
    );

    expect(calls[0].command).toBe('cmd.exe');
    expect(calls[0].args).toEqual(['/d', '/s', '/c', 'npm.cmd run test']);
    expect(calls[0].options.shell).toBe(false);
  });

  it('runs the readiness endpoint check after browser smoke in local demo', async () => {
    const calls = [];
    const spawnCommand = (_command, args) => {
      const commandText = args.at(-1) ?? '';
      const script = commandText.match(/run ([^ ]+)/)?.[1] ?? args[1];
      calls.push(`npm:${script}`);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push(`fetch:${url}`);
      expect(init.headers).toEqual({ 'x-agent-im-token': 'local-token' });
      return {
        ok: true,
        async json() {
          return {
            ok: false,
            checks: {
              auth: { ok: false, status: 'degraded', mode: 'local-demo' },
              storage: { ok: true, status: 'ready' },
              worker: { ok: true, status: 'ready' },
              connector: { ok: true, status: 'ready' },
              provider: {
                ok: false,
                status: 'degraded',
                configured: false,
                provider: 'fallback',
                health: 'missing'
              }
            }
          };
        }
      };
    });

    const results = await runReadinessChecks(defaultChecks, {
      localDemo: true,
      npmCommand: 'npm.cmd',
      spawnCommand,
      fetchImpl,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      log: vi.fn(),
      error: vi.fn(),
      env: {
        AGENT_IM_API_BASE: 'http://127.0.0.1:8791',
        AGENT_IM_API_TOKEN: 'local-token'
      }
    });

    expect(calls).toEqual([
      'npm:test',
      'npm:build',
      'npm:eval:agent',
      'npm:smoke:browser',
      'fetch:http://127.0.0.1:8791/api/readiness'
    ]);
    expect(results).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'readiness endpoint', status: 'passed' })])
    );
  });

  it('fails product readiness when the endpoint reports unhealthy checks', async () => {
    const results = await runReadinessChecks(
      [{ name: 'readiness endpoint', readinessEndpoint: true }],
      {
        localDemo: false,
        fetchImpl: vi.fn(async () => ({
          ok: true,
          async json() {
            return {
              ok: false,
              checks: {
                auth: {
                  ok: false,
                  status: 'blocked',
                  message: 'Product auth is blocked: API token is not configured.',
                  mode: 'public'
                },
                storage: { ok: true, status: 'ready' },
                worker: { ok: true, status: 'ready' },
                connector: { ok: true, status: 'ready' },
                provider: { ok: true, status: 'ready' }
              }
            };
          }
        })),
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        log: vi.fn(),
        error: vi.fn(),
        env: {}
      }
    );

    expect(results).toMatchObject([
      {
        name: 'readiness endpoint',
        status: 'failed',
        error:
          '/api/readiness reported auth is not ready (status: blocked, message: Product auth is blocked: API token is not configured.)'
      }
    ]);
  });

  it('passes product readiness when overall and required checks are healthy', async () => {
    const results = await runReadinessChecks(
      [{ name: 'readiness endpoint', readinessEndpoint: true }],
      {
        localDemo: false,
        fetchImpl: vi.fn(async () => ({
          ok: true,
          async json() {
            return {
              ok: true,
              checks: {
                auth: { ok: true, status: 'ready', message: 'Product auth is enforced.', mode: 'public' },
                storage: { ok: true, status: 'ready', message: 'Local JSON storage is writable.' },
                worker: { ok: true, status: 'ready', message: 'Autopilot worker is available.' },
                connector: { ok: true, status: 'ready', message: 'Matrix connector is enabled.' },
                provider: { ok: true, status: 'ready', message: 'AI provider health is connected.' }
              }
            };
          }
        })),
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        log: vi.fn(),
        error: vi.fn(),
        env: {}
      }
    );

    expect(results).toMatchObject([{ name: 'readiness endpoint', status: 'passed' }]);
  });

  it('fails product readiness when overall readiness is false', async () => {
    const results = await runReadinessChecks(
      [{ name: 'readiness endpoint', readinessEndpoint: true }],
      {
        localDemo: false,
        fetchImpl: vi.fn(async () => ({
          ok: true,
          async json() {
            return {
              ok: false,
              checks: {
                auth: { ok: true, status: 'ready', mode: 'public' },
                storage: { ok: true, status: 'ready' },
                worker: { ok: true, status: 'ready' },
                connector: { ok: true, status: 'ready' },
                provider: { ok: true, status: 'ready' }
              }
            };
          }
        })),
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        log: vi.fn(),
        error: vi.fn(),
        env: {}
      }
    );

    expect(results).toMatchObject([
      {
        name: 'readiness endpoint',
        status: 'failed',
        error: '/api/readiness reported overall readiness is not ready'
      }
    ]);
  });

  it('fails local demo readiness when degraded checks do not match allowed local-demo states', async () => {
    const results = await runReadinessChecks(
      [{ name: 'readiness endpoint', readinessEndpoint: true }],
      {
        localDemo: true,
        fetchImpl: vi.fn(async () => ({
          ok: true,
          async json() {
            return {
              ok: false,
              checks: {
                auth: { ok: false },
                storage: { ok: true, status: 'ready' },
                worker: { ok: true, status: 'ready' },
                connector: { ok: true, status: 'ready' },
                provider: { ok: true, status: 'ready' }
              }
            };
          }
        })),
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        log: vi.fn(),
        error: vi.fn(),
        env: {}
      }
    );

    expect(results).toMatchObject([
      {
        name: 'readiness endpoint',
        status: 'failed',
        error: '/api/readiness reported auth is not ready (status: unknown, message: none)'
      }
    ]);
  });

  it('fails local demo readiness when an extra returned check is unhealthy', async () => {
    const results = await runReadinessChecks(
      [{ name: 'readiness endpoint', readinessEndpoint: true }],
      {
        localDemo: true,
        fetchImpl: vi.fn(async () => ({
          ok: true,
          async json() {
            return {
              ok: false,
              checks: {
                auth: { ok: false, status: 'degraded', message: 'Local demo mode.', mode: 'local-demo' },
                storage: { ok: true, status: 'ready', message: 'Local JSON storage is writable.' },
                worker: { ok: true, status: 'ready', message: 'Autopilot worker is available.' },
                connector: { ok: true, status: 'ready', message: 'Matrix connector is disabled; using local message storage.' },
                provider: {
                  ok: false,
                  status: 'degraded',
                  message: 'AI provider is not configured; fallback responses may be used.',
                  configured: false,
                  provider: 'fallback',
                  health: 'missing'
                },
                downloads: {
                  ok: false,
                  status: 'blocked',
                  message: 'Download hardening is not configured.'
                }
              }
            };
          }
        })),
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        log: vi.fn(),
        error: vi.fn(),
        env: {}
      }
    );

    expect(results).toMatchObject([
      {
        name: 'readiness endpoint',
        status: 'failed',
        error:
          '/api/readiness reported downloads is not ready (status: blocked, message: Download hardening is not configured.)'
      }
    ]);
  });

  it('includes sanitized response body when readiness HTTP status is not ok', async () => {
    const results = await runReadinessChecks(
      [{ name: 'readiness endpoint', readinessEndpoint: true }],
      {
        fetchImpl: vi.fn(async () => ({
          ok: false,
          status: 503,
          async text() {
            return 'upstream failed for x-agent-im-token: server-token and Authorization: Bearer server-token';
          }
        })),
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        log: vi.fn(),
        error: vi.fn(),
        env: {
          AGENT_IM_API_BASE: 'https://agentbridge.example.com',
          AGENT_IM_API_TOKEN: 'server-token'
        }
      }
    );

    expect(results[0].error).toContain('https://agentbridge.example.com/api/readiness failed with 503');
    expect(results[0].error).toContain('body: upstream failed for x-agent-im-token: [redacted]');
    expect(results[0].error).toContain('Authorization: Bearer [redacted]');
    expect(results[0].error).not.toContain('server-token');
  });

  it('fails readiness endpoint checks that exceed the configured timeout', async () => {
    vi.useFakeTimers();
    const resultsPromise = runReadinessChecks(
      [{ name: 'readiness endpoint', readinessEndpoint: true }],
      {
        readinessTimeoutMs: 25,
        fetchImpl: vi.fn(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener('abort', () => {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              });
            })
        ),
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        log: vi.fn(),
        error: vi.fn(),
        env: {}
      }
    );

    await vi.advanceTimersByTimeAsync(25);
    await expect(resultsPromise).resolves.toMatchObject([
      {
        name: 'readiness endpoint',
        status: 'failed',
        error: '/api/readiness timed out after 25ms'
      }
    ]);
  });

  it('fails the readiness endpoint check when required checks are missing', async () => {
    const results = await runReadinessChecks(
      [{ name: 'readiness endpoint', readinessEndpoint: true }],
      {
        fetchImpl: vi.fn(async () => ({
          ok: true,
          async json() {
            return { checks: { auth: { ok: true } } };
          }
        })),
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        log: vi.fn(),
        error: vi.fn(),
        env: {}
      }
    );

    expect(results).toMatchObject([
      {
        name: 'readiness endpoint',
        status: 'failed',
        error: '/api/readiness response is missing required checks'
      }
    ]);
  });
});
