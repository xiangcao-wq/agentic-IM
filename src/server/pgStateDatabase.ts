import type {
  PostgresQueryResult,
  PostgresStateDatabase,
  PostgresStateQueryRunner
} from './postgresStateStore';

export interface PgPoolConfig {
  connectionString: string;
  ssl?: {
    rejectUnauthorized: boolean;
  };
}

export interface PgPoolClientLike extends PostgresStateQueryRunner {
  release(): void;
}

export interface PgPoolLike extends PostgresStateQueryRunner {
  connect(): Promise<PgPoolClientLike>;
  end?(): Promise<void>;
}

export class PgStateDatabase implements PostgresStateDatabase {
  constructor(private readonly pool: PgPoolLike) {}

  query<Row = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    return this.pool.query<Row>(text, params);
  }

  async transaction<T>(run: (client: PostgresStateQueryRunner) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }
}

export function resolvePostgresPoolConfig(env: NodeJS.ProcessEnv): PgPoolConfig {
  const connectionString = env.AGENTBRIDGE_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('Postgres state store requires AGENTBRIDGE_DATABASE_URL or DATABASE_URL.');
  }

  const sslEnabled = parseBooleanEnv(env.AGENTBRIDGE_DATABASE_SSL, false);
  return {
    connectionString,
    ...(sslEnabled
      ? {
          ssl: {
            rejectUnauthorized: parseBooleanEnv(env.AGENTBRIDGE_DATABASE_SSL_REJECT_UNAUTHORIZED, true)
          }
        }
      : {})
  };
}

export async function createPgStateDatabaseFromEnv(env: NodeJS.ProcessEnv): Promise<PgStateDatabase> {
  const config = resolvePostgresPoolConfig(env);
  const pg = (await import('pg')) as {
    Pool: new (config: PgPoolConfig) => PgPoolLike;
  };
  return new PgStateDatabase(new pg.Pool(config));
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
