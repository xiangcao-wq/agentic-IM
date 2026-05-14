import type { PostgresStateDatabase } from './postgresStateStore';

export interface PostgresMigrationFile {
  path: string;
  fileName: string;
  sql: string;
}

export interface ParsedPostgresMigration {
  version: string;
  description: string;
}

export interface PostgresMigrationRunOptions {
  db: PostgresStateDatabase;
  migrations: PostgresMigrationFile[];
  apply: boolean;
}

export interface PostgresMigrationRunItem extends ParsedPostgresMigration {
  path: string;
  status: 'applied' | 'pending' | 'applied_now' | 'failed';
  error?: string;
}

export interface PostgresMigrationRunReport {
  ok: boolean;
  apply: boolean;
  appliedCount: number;
  pendingCount: number;
  migrations: PostgresMigrationRunItem[];
}

interface RegclassRow {
  table_name: string | null;
}

interface VersionRow {
  version: string;
}

export function parsePostgresMigrationFileName(fileName: string): ParsedPostgresMigration {
  const match = /^(\d{12,})_([a-z0-9_]+)\.sql$/i.exec(fileName);
  if (!match) {
    throw new Error(`Invalid migration filename: ${fileName}`);
  }

  return {
    version: match[1],
    description: match[2].replace(/_/g, ' ')
  };
}

export async function runPostgresMigrations(options: PostgresMigrationRunOptions): Promise<PostgresMigrationRunReport> {
  const migrations = options.migrations
    .map((migration) => ({
      ...migration,
      ...parsePostgresMigrationFileName(migration.fileName)
    }))
    .sort((left, right) => left.version.localeCompare(right.version));

  const items: PostgresMigrationRunItem[] = [];

  for (const migration of migrations) {
    const alreadyApplied = await isMigrationApplied(options.db, migration.version);
    if (alreadyApplied) {
      items.push({
        version: migration.version,
        description: migration.description,
        path: migration.path,
        status: 'applied'
      });
      continue;
    }

    if (!options.apply) {
      items.push({
        version: migration.version,
        description: migration.description,
        path: migration.path,
        status: 'pending'
      });
      continue;
    }

    try {
      await options.db.query(migration.sql);
      await options.db.query(
        'INSERT INTO agentbridge_schema_migrations (version, description) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
        [migration.version, migration.description]
      );
      items.push({
        version: migration.version,
        description: migration.description,
        path: migration.path,
        status: 'applied_now'
      });
    } catch (error) {
      items.push({
        version: migration.version,
        description: migration.description,
        path: migration.path,
        status: 'failed',
        error: errorMessage(error)
      });
      break;
    }
  }

  return {
    ok: items.every((item) => item.status !== 'failed'),
    apply: options.apply,
    appliedCount: items.filter((item) => item.status === 'applied_now').length,
    pendingCount: items.filter((item) => item.status === 'pending').length,
    migrations: items
  };
}

async function isMigrationApplied(db: PostgresStateDatabase, version: string): Promise<boolean> {
  const table = await db.query<RegclassRow>("SELECT to_regclass('public.agentbridge_schema_migrations') AS table_name");
  if (!table.rows[0]?.table_name) {
    return false;
  }

  const result = await db.query<VersionRow>('SELECT version FROM agentbridge_schema_migrations WHERE version = $1', [
    version
  ]);
  return result.rows.some((row) => row.version === version);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
