import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { defaultChecks, runReadinessChecks } from './product-readiness-runner.mjs';

describe('product readiness runner', () => {
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
                auth: { ok: false, status: 'blocked', mode: 'public' },
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
        error: '/api/readiness reported auth is not ready'
      }
    ]);
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
        error: '/api/readiness reported auth is not ready'
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
