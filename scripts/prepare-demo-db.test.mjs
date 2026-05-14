// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('prepare-demo-db script', () => {
  it('prepares downloadable runtime files without flooding the chat transcript', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentbridge-demo-'));
    const dbPath = join(dir, 'agent-im-db.json');
    const mediaDir = join(dir, 'media');

    try {
      await execFileAsync(process.execPath, [resolve('scripts/prepare-demo-db.mjs')], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          AGENT_IM_DB_PATH: dbPath,
          AGENT_IM_MEDIA_DIR: mediaDir
        }
      });

      const state = JSON.parse(await readFile(dbPath, 'utf8'));
      const runtimeFiles = state.files.filter((file) => String(file.id).startsWith('file-demo-runtime-'));
      const runtimeMessages = state.messages.filter((message) => String(message.id).startsWith('msg-demo-runtime-'));

      expect(runtimeFiles.length).toBeGreaterThanOrEqual(10);
      expect(runtimeFiles.every((file) => file.localPath && file.agentCanShare)).toBe(true);
      expect(runtimeMessages).toHaveLength(0);
      expect(state.messages.map((message) => message.body).join('\n')).not.toMatch(/agent-im|Lin Agent|Chen Agent/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
