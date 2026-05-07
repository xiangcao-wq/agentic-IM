import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { runReadinessChecks } from './product-readiness-runner.mjs';

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
});
