import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFindings,
  collectServerInventory,
  deriveDeploymentPaths,
  parseEnvFile,
  summarizeEnv
} from './server-inventory.mjs';

describe('server inventory', () => {
  it('parses env files without treating comments as values', () => {
    expect(
      parseEnvFile(`
# comment
export NODE_ENV=production
AGENT_IM_API_TOKEN="server-token"
AGENT_IM_ALLOWED_ORIGINS=https://agentbridge.example.com # public host
`)
    ).toEqual({
      NODE_ENV: 'production',
      AGENT_IM_API_TOKEN: 'server-token',
      AGENT_IM_ALLOWED_ORIGINS: 'https://agentbridge.example.com'
    });
  });

  it('redacts secrets while keeping non-secret deployment values visible', () => {
    const summary = summarizeEnv({
      AGENT_IM_API_TOKEN: 'server-token',
      DEEPSEEK_API_KEY: 'deepseek-secret',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      AGENT_IM_ALLOWED_ORIGINS: 'https://agentbridge.example.com'
    });

    expect(summary.AGENT_IM_API_TOKEN).toEqual({ configured: true, redacted: true, length: 12 });
    expect(summary.DEEPSEEK_API_KEY).toEqual({ configured: true, redacted: true, length: 15 });
    expect(summary.DEEPSEEK_BASE_URL).toEqual({
      configured: true,
      value: 'https://api.deepseek.com'
    });
    expect(summary.AGENT_IM_ALLOWED_ORIGINS).toEqual({
      configured: true,
      value: 'https://agentbridge.example.com'
    });
  });

  it('derives event log and media paths from the configured state file', () => {
    expect(
      deriveDeploymentPaths({
        AGENT_IM_DB_PATH: '/var/lib/agentbridge/data/agent-im-db.json',
        AGENT_IM_MEDIA_DIR: '/var/lib/agentbridge/media'
      })
    ).toMatchObject({
      stateFile: '/var/lib/agentbridge/data/agent-im-db.json',
      eventLog: '/var/lib/agentbridge/data/agent-events.jsonl',
      mediaDir: '/var/lib/agentbridge/media'
    });
  });

  it('builds findings for unsafe product deployment settings', () => {
    const findings = buildFindings({
      env: summarizeEnv({
        NODE_ENV: 'development',
        AGENT_IM_PUBLIC_MODE: 'false',
        AGENT_IM_ALLOW_NO_AUTH: 'true',
        AGENT_IM_ALLOW_QUERY_TOKEN: 'true'
      }),
      service: { activeState: 'inactive' },
      paths: {
        stateFile: { exists: false },
        eventLog: { exists: false }
      },
      readiness: {
        host: 'https://agentbridge.example.com',
        noToken: { status: 200 },
        queryToken: { status: 200 },
        authenticated: { status: 503, body: { ok: false } }
      }
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        'NODE_ENV is not production.',
        'AGENT_IM_PUBLIC_MODE is not true.',
        'AGENT_IM_API_TOKEN is not configured.',
        'AGENT_IM_ALLOW_NO_AUTH must not be true for product readiness.',
        'AGENT_IM_ALLOW_QUERY_TOKEN must not be true for product readiness.',
        'State file does not exist at the configured path.',
        'Agent EventLog file does not exist at the derived path.',
        'systemd service is not active: inactive.',
        'No-token readiness returned 200 instead of 401/403.',
        'Query-token readiness returned 200 instead of 401/403.',
        'Authenticated readiness returned 503 instead of 200.',
        '/api/readiness reported ok=false.'
      ])
    );
  });

  it('collects readiness probes without leaking tokens into the report', async () => {
    const commandRunner = vi.fn(async (command, args) => ({
      command: [command, ...args].join(' '),
      ok: true,
      stdout: command === 'systemctl' && args[0] === 'show'
        ? 'ActiveState=active\nUnitFileState=enabled\nWorkingDirectory=/opt/agentbridge/current\n'
        : 'ok',
      stderr: ''
    }));
    const fetchImpl = vi.fn(async (url, init) => ({
      status: url.includes('agent_im_token=') ? 403 : init.headers?.['x-agent-im-token'] ? 200 : 401,
      ok: Boolean(init.headers?.['x-agent-im-token']),
      async text() {
        return JSON.stringify({
          ok: Boolean(init.headers?.['x-agent-im-token']),
          checks: {
            auth: { ok: true, status: 'ready', mode: 'public' },
            eventLog: { ok: true, status: 'ready', readable: true, writable: true, valid: true }
          }
        });
      }
    }));

    const dir = await mkdtemp(join(tmpdir(), 'agentbridge-inventory-'));
    const envFile = join(dir, 'agentbridge.env');
    await writeFile(envFile, 'AGENT_IM_API_TOKEN=server-token\nNODE_ENV=production\n', 'utf8');
    try {
      const report = await collectServerInventory({
        cwd: process.cwd(),
        envFile,
        commandRunner,
        fetchImpl,
        host: 'https://agentbridge.example.com/',
        readinessTimeoutMs: 0
      });
      const serialized = JSON.stringify(report);

      expect(report.readiness.noToken.status).toBe(401);
      expect(report.readiness.queryToken.status).toBe(403);
      expect(report.readiness.authenticated.status).toBe(200);
      expect(serialized).not.toContain('server-token');
      expect(report.env.AGENT_IM_API_TOKEN).toEqual({ configured: true, redacted: true, length: 12 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
