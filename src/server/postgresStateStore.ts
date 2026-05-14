import { createDemoState } from '../domain/demoState';
import type { DemoState } from '../domain/types';
import type { StateStore, StateStoreHealth } from './stateStore';
import {
  getStateCollections,
  validateDemoStateShape,
  type StateCollectionKey
} from './stateSchema';
import {
  POSTGRES_STATE_TABLES,
  type PostgresStateTableSpec
} from './postgresStateSchema';

export interface PostgresQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
}

export interface PostgresStateQueryRunner {
  query<Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresStateDatabase extends PostgresStateQueryRunner {
  transaction<T>(run: (client: PostgresStateQueryRunner) => Promise<T>): Promise<T>;
}

export interface PostgresStateStoreOptions {
  tenantId?: string;
}

interface DataRow {
  data: unknown;
}

interface CountRow {
  count: number | string | bigint;
}

export class PostgresStateStore implements StateStore {
  private readonly tenantId: string;

  constructor(
    private readonly db: PostgresStateDatabase,
    options: PostgresStateStoreOptions = {}
  ) {
    this.tenantId = options.tenantId ?? 'default';
  }

  async init(): Promise<void> {
    const existingUsers = await this.countRows(POSTGRES_STATE_TABLES[0]);
    if (existingUsers === 0) {
      await this.write(createDemoState());
    }
  }

  async read(): Promise<DemoState> {
    return this.readFrom(this.db);
  }

  async write(state: DemoState): Promise<void> {
    await this.db.transaction(async (client) => {
      await this.writeTo(client, state);
    });
  }

  async update(updater: (state: DemoState) => DemoState | Promise<DemoState>): Promise<DemoState> {
    return this.db.transaction(async (client) => {
      await this.lockTenant(client);
      const current = await this.readFrom(client);
      const next = validateDemoStateShape(await updater(current));
      await this.replaceTenantSnapshot(client, next);
      return next;
    });
  }

  async health(): Promise<StateStoreHealth> {
    let readable = false;
    let writable = false;

    try {
      await this.db.query('SELECT 1 AS ok');
      readable = true;
    } catch {
      readable = false;
    }

    try {
      await this.db.transaction(async (client) => {
        await client.query('CREATE TEMP TABLE IF NOT EXISTS agentbridge_health_probe (id TEXT) ON COMMIT DROP');
        await client.query('INSERT INTO agentbridge_health_probe (id) VALUES ($1)', [
          `health-${Date.now()}`
        ]);
      });
      writable = true;
    } catch {
      writable = false;
    }

    return { readable, writable };
  }

  private async countRows(spec: PostgresStateTableSpec): Promise<number> {
    const result = await this.db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM ${spec.tableName} WHERE tenant_id = $1`,
      [this.tenantId]
    );
    const raw = result.rows[0]?.count ?? 0;
    return typeof raw === 'bigint' ? Number(raw) : Number(raw);
  }

  private async readFrom(client: PostgresStateQueryRunner): Promise<DemoState> {
    const snapshot: Partial<Record<StateCollectionKey, unknown[]>> = {};

    for (const spec of POSTGRES_STATE_TABLES) {
      const result = await client.query<DataRow>(
        `SELECT data FROM ${spec.tableName} WHERE tenant_id = $1 ORDER BY position ASC, id ASC`,
        [this.tenantId]
      );
      snapshot[spec.collection] = result.rows.map((row) => parseJsonbData(row.data));
    }

    return validateDemoStateShape(snapshot);
  }

  private async writeTo(client: PostgresStateQueryRunner, state: DemoState): Promise<void> {
    await this.lockTenant(client);
    await this.replaceTenantSnapshot(client, validateDemoStateShape(state));
  }

  private async replaceTenantSnapshot(client: PostgresStateQueryRunner, state: DemoState): Promise<void> {
    const collections = getStateCollections(state);

    for (const spec of POSTGRES_STATE_TABLES) {
      await client.query(`DELETE FROM ${spec.tableName} WHERE tenant_id = $1`, [this.tenantId]);
      const records = collections[spec.collection] as unknown as Array<Record<string, unknown>>;
      for (const [position, record] of records.entries()) {
        await this.insertRecord(client, spec, record, position);
      }
    }
  }

  private async insertRecord(
    client: PostgresStateQueryRunner,
    spec: PostgresStateTableSpec,
    record: Record<string, unknown>,
    position: number
  ): Promise<void> {
    const id = readRequiredString(record, spec.primaryJsonField, spec.collection);
    const createdAt = readOptionalString(record, spec.createdAtJsonField) ?? new Date().toISOString();
    const updatedAt = readOptionalString(record, spec.updatedAtJsonField) ?? createdAt;

    await client.query(
      `INSERT INTO ${spec.tableName} (tenant_id, id, data, position, created_at, updated_at)
VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz, $6::timestamptz)
ON CONFLICT (tenant_id, id) DO UPDATE
SET data = EXCLUDED.data, position = EXCLUDED.position, updated_at = EXCLUDED.updated_at`,
      [this.tenantId, id, record, position, createdAt, updatedAt]
    );
  }

  private async lockTenant(client: PostgresStateQueryRunner): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agentbridge:${this.tenantId}`]);
  }
}

function parseJsonbData(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error('Invalid Postgres state row: data must be a JSON object');
}

function readRequiredString(record: Record<string, unknown>, field: string, collection: StateCollectionKey): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Cannot persist ${collection}: missing string field ${field}`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, field: string | undefined): string | undefined {
  if (!field) {
    return undefined;
  }
  const value = record[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
