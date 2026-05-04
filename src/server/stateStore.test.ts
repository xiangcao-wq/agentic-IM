// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import { JsonStateStore } from './stateStore';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('JsonStateStore', () => {
  it('initializes a missing state file with demo data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-store-'));
    tempDirs.push(dir);
    const store = new JsonStateStore(join(dir, 'nested', 'db.json'));

    await store.init();
    const state = await store.read();

    expect(state.rooms.some((room) => room.id === 'room-team')).toBe(true);
    expect(state.agents.some((agent) => agent.id === 'agent-lin')).toBe(true);
  });

  it('persists state updates as readable JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-store-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const store = new JsonStateStore(dbPath);
    const state = createDemoState();

    await store.init();
    await store.write({
      ...state,
      actionLogs: [
        {
          id: 'log-store-proof',
          agentId: 'agent-lin',
          roomId: 'room-team',
          action: 'store.write proof',
          status: 'executed',
          risk: {
            level: 'low',
            score: 0.01,
            reason: 'store persistence test',
            model: 'test'
          },
          contextIds: [],
          toolCalls: ['state_store.write'],
          createdAt: '2026-05-04T00:00:00.000Z'
        },
        ...state.actionLogs
      ]
    });

    const persisted = JSON.parse(await readFile(dbPath, 'utf8'));
    const reloaded = await store.read();
    expect(persisted.actionLogs[0].id).toBe('log-store-proof');
    expect(reloaded.actionLogs[0].toolCalls).toContain('state_store.write');
  });

  it('rejects persisted files that do not match the DemoState shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-store-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const store = new JsonStateStore(dbPath);

    await writeFile(dbPath, JSON.stringify({ users: [] }), 'utf8');

    await expect(store.read()).rejects.toThrow('Invalid DemoState.agents: expected array');
  });
});
