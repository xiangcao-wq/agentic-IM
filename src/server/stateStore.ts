import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createDemoState } from '../domain/demoState';
import type { DemoState } from '../domain/types';
import { validateDemoStateShape } from './stateSchema';

export interface StateStore {
  init(): Promise<void>;
  read(): Promise<DemoState>;
  write(state: DemoState): Promise<void>;
  update?(updater: (state: DemoState) => DemoState | Promise<DemoState>): Promise<DemoState>;
  health?(): Promise<StateStoreHealth>;
}

export interface StateStoreHealth {
  readable: boolean;
  writable: boolean;
}

export class JsonStateStore implements StateStore {
  private updateQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true });
    try {
      await readFile(this.dbPath, 'utf8');
    } catch {
      await this.write(createDemoState());
    }
  }

  async read(): Promise<DemoState> {
    return validateDemoStateShape(JSON.parse(await readFile(this.dbPath, 'utf8')));
  }

  async write(state: DemoState): Promise<void> {
    validateDemoStateShape(state);
    await writeFile(this.dbPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  async health(): Promise<StateStoreHealth> {
    let readable = false;
    let writable = false;

    try {
      validateDemoStateShape(JSON.parse(await readFile(this.dbPath, 'utf8')));
      readable = true;
    } catch {
      readable = false;
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.dbPath, 'r+');
      writable = true;
    } catch {
      writable = false;
    } finally {
      await handle?.close();
    }

    return { readable, writable };
  }

  update(updater: (state: DemoState) => DemoState | Promise<DemoState>): Promise<DemoState> {
    const pending = this.updateQueue.then(async () => {
      const current = await this.read();
      const next = await updater(current);
      await this.write(next);
      return next;
    });
    this.updateQueue = pending.catch(() => undefined);
    return pending;
  }
}
