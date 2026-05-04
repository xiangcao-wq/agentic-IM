// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLocalEnvFile } from './env';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('local env loader', () => {
  it('loads .env.local values without overriding existing process env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-env-'));
    tempDirs.push(dir);
    const envPath = join(dir, '.env.local');
    await writeFile(
      envPath,
      [
        'DEEPSEEK_API_KEY=local-key',
        'DEEPSEEK_AGENT_MODEL=deepseek-chat',
        'DEEPSEEK_HUMAN_MODEL=\"deepseek-chat\"'
      ].join('\n'),
      'utf8'
    );
    vi.stubEnv('DEEPSEEK_API_KEY', 'existing-key');

    const loaded = await loadLocalEnvFile(envPath);

    expect(loaded).toMatchObject({
      DEEPSEEK_API_KEY: 'local-key',
      DEEPSEEK_AGENT_MODEL: 'deepseek-chat',
      DEEPSEEK_HUMAN_MODEL: 'deepseek-chat'
    });
    expect(process.env.DEEPSEEK_API_KEY).toBe('existing-key');
    expect(process.env.DEEPSEEK_AGENT_MODEL).toBe('deepseek-chat');
  });
});
