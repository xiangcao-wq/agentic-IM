import type { StateStore } from './stateStore';
import { PostgresStateStore, type PostgresStateDatabase } from './postgresStateStore';
import { createPgStateDatabaseFromEnv, resolvePostgresPoolConfig } from './pgStateDatabase';

export type ConfiguredStateStoreMode = 'json' | 'postgres';

export interface ConfiguredStateStore {
  mode: ConfiguredStateStoreMode;
  description: string;
  stateStore?: StateStore;
  agentEventLogMode?: string;
}

export interface ConfiguredStateStoreOptions {
  dbPath: string;
  env?: NodeJS.ProcessEnv;
  createPostgresDatabase?: (env: NodeJS.ProcessEnv) => PostgresStateDatabase | Promise<PostgresStateDatabase>;
}

export async function createConfiguredStateStoreAsync(
  options: ConfiguredStateStoreOptions
): Promise<ConfiguredStateStore> {
  const env = options.env ?? process.env;
  const mode = resolveStateStoreMode(env);
  if (mode === 'json') {
    return {
      mode,
      description: options.dbPath
    };
  }

  resolvePostgresPoolConfig(env);
  const db = options.createPostgresDatabase
    ? await options.createPostgresDatabase(env)
    : await createPgStateDatabaseFromEnv(env);
  const tenantId = resolveTenantId(env);

  return {
    mode,
    description: `postgres tenant ${tenantId}`,
    stateStore: new PostgresStateStore(db, { tenantId }),
    agentEventLogMode: 'jsonl-local'
  };
}

export function createConfiguredStateStore(options: ConfiguredStateStoreOptions): ConfiguredStateStore {
  const env = options.env ?? process.env;
  const mode = resolveStateStoreMode(env);
  if (mode === 'json') {
    return {
      mode,
      description: options.dbPath
    };
  }

  resolvePostgresPoolConfig(env);
  if (!options.createPostgresDatabase) {
    throw new Error('createConfiguredStateStore requires createPostgresDatabase for synchronous Postgres setup.');
  }
  const db = options.createPostgresDatabase(env);
  if (isPromiseLike(db)) {
    throw new Error('Use createConfiguredStateStoreAsync for asynchronous Postgres database setup.');
  }
  const tenantId = resolveTenantId(env);

  return {
    mode,
    description: `postgres tenant ${tenantId}`,
    stateStore: new PostgresStateStore(db, { tenantId }),
    agentEventLogMode: 'jsonl-local'
  };
}

function resolveStateStoreMode(env: NodeJS.ProcessEnv): ConfiguredStateStoreMode {
  const raw = env.AGENT_IM_STATE_STORE?.trim().toLowerCase() || 'json';
  if (raw === 'json' || raw === 'postgres') {
    return raw;
  }
  throw new Error(`Unsupported AGENT_IM_STATE_STORE: ${raw}. Use "json" or "postgres".`);
}

function resolveTenantId(env: NodeJS.ProcessEnv): string {
  return env.AGENTBRIDGE_TENANT_ID?.trim() || 'default';
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value && typeof (value as Promise<T>).then === 'function');
}
