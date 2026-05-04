import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createDemoState } from '../domain/demoState';
import type { DemoState } from '../domain/types';
import { validateDemoStateShape } from './stateSchema';

export interface StateStore {
  init(): Promise<void>;
  read(): Promise<DemoState>;
  write(state: DemoState): Promise<void>;
}

export class JsonStateStore implements StateStore {
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
}
