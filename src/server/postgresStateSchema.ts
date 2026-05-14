import {
  STATE_COLLECTION_KEYS,
  type StateCollectionKey
} from './stateSchema';

export interface PostgresStateTableSpec {
  collection: StateCollectionKey;
  tableName: string;
  primaryJsonField: string;
  createdAtJsonField?: string;
  updatedAtJsonField?: string;
}

export const POSTGRES_STATE_TABLES: readonly PostgresStateTableSpec[] = [
  { collection: 'users', tableName: 'agentbridge_users', primaryJsonField: 'id' },
  { collection: 'agents', tableName: 'agentbridge_agents', primaryJsonField: 'id' },
  { collection: 'rooms', tableName: 'agentbridge_rooms', primaryJsonField: 'id' },
  {
    collection: 'messages',
    tableName: 'agentbridge_messages',
    primaryJsonField: 'id',
    createdAtJsonField: 'sentAt',
    updatedAtJsonField: 'sentAt'
  },
  {
    collection: 'files',
    tableName: 'agentbridge_files',
    primaryJsonField: 'id',
    createdAtJsonField: 'updatedAt',
    updatedAtJsonField: 'updatedAt'
  },
  {
    collection: 'fileTextChunks',
    tableName: 'agentbridge_file_text_chunks',
    primaryJsonField: 'id',
    createdAtJsonField: 'createdAt',
    updatedAtJsonField: 'createdAt'
  },
  { collection: 'tasks', tableName: 'agentbridge_tasks', primaryJsonField: 'id' },
  {
    collection: 'calendar',
    tableName: 'agentbridge_calendar_items',
    primaryJsonField: 'id',
    createdAtJsonField: 'startsAt',
    updatedAtJsonField: 'startsAt'
  },
  {
    collection: 'actionLogs',
    tableName: 'agentbridge_action_logs',
    primaryJsonField: 'id',
    createdAtJsonField: 'createdAt',
    updatedAtJsonField: 'createdAt'
  },
  {
    collection: 'actionRequests',
    tableName: 'agentbridge_action_requests',
    primaryJsonField: 'id',
    createdAtJsonField: 'createdAt',
    updatedAtJsonField: 'updatedAt'
  },
  {
    collection: 'a2aSessions',
    tableName: 'agentbridge_a2a_sessions',
    primaryJsonField: 'id',
    createdAtJsonField: 'createdAt',
    updatedAtJsonField: 'updatedAt'
  },
  {
    collection: 'agentGoalPlans',
    tableName: 'agentbridge_agent_goal_plans',
    primaryJsonField: 'id',
    createdAtJsonField: 'createdAt',
    updatedAtJsonField: 'updatedAt'
  },
  {
    collection: 'agentAutopilotPolicies',
    tableName: 'agentbridge_agent_autopilot_policies',
    primaryJsonField: 'agentId',
    createdAtJsonField: 'updatedAt',
    updatedAtJsonField: 'updatedAt'
  },
  {
    collection: 'memories',
    tableName: 'agentbridge_memories',
    primaryJsonField: 'id',
    createdAtJsonField: 'createdAt',
    updatedAtJsonField: 'updatedAt'
  },
  {
    collection: 'matrixObserverCheckpoints',
    tableName: 'agentbridge_matrix_observer_checkpoints',
    primaryJsonField: 'roomId'
  },
  {
    collection: 'aiAutoreplyPolicies',
    tableName: 'agentbridge_ai_autoreply_policies',
    primaryJsonField: 'userId'
  },
  {
    collection: 'aiReplyJobs',
    tableName: 'agentbridge_ai_reply_jobs',
    primaryJsonField: 'id',
    createdAtJsonField: 'createdAt',
    updatedAtJsonField: 'updatedAt'
  }
] as const;

export function getPostgresTableSpec(collection: StateCollectionKey): PostgresStateTableSpec {
  const spec = POSTGRES_STATE_TABLES.find((table) => table.collection === collection);
  if (!spec) {
    throw new Error(`No Postgres table spec for state collection: ${collection}`);
  }
  return spec;
}

export function generatePostgresStateMigration(): string {
  assertPostgresTableCoverage();
  const tableList = POSTGRES_STATE_TABLES.map((table) => `    '${table.tableName}'`).join(',\n');

  return `-- AgentBridge core state schema.
-- Forward-only migration for Supabase/Postgres. Rollbacks should be shipped as a new migration.

CREATE TABLE IF NOT EXISTS agentbridge_schema_migrations (
  version TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
${tableList}
  ]
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        data JSONB NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id),
        CONSTRAINT %I CHECK (jsonb_typeof(data) = ''object'')
      )',
      table_name,
      table_name || '_data_object'
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I USING GIN (data jsonb_path_ops)',
      table_name || '_data_gin_idx',
      table_name
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS agentbridge_messages_room_sent_at_idx
  ON agentbridge_messages (tenant_id, (data->>'roomId'), (data->>'sentAt'));

CREATE INDEX IF NOT EXISTS agentbridge_messages_sender_idx
  ON agentbridge_messages (tenant_id, (data->>'senderId'));

CREATE INDEX IF NOT EXISTS agentbridge_files_room_updated_idx
  ON agentbridge_files (tenant_id, (data->>'roomId'), (data->>'updatedAt'));

CREATE INDEX IF NOT EXISTS agentbridge_tasks_status_idx
  ON agentbridge_tasks (tenant_id, (data->>'status'));

CREATE INDEX IF NOT EXISTS agentbridge_calendar_room_starts_idx
  ON agentbridge_calendar_items (tenant_id, (data->>'roomId'), (data->>'startsAt'));

CREATE INDEX IF NOT EXISTS agentbridge_action_logs_agent_created_idx
  ON agentbridge_action_logs (tenant_id, (data->>'agentId'), (data->>'createdAt'));

CREATE INDEX IF NOT EXISTS agentbridge_action_requests_status_idx
  ON agentbridge_action_requests (tenant_id, (data->>'status'), (data->>'roomId'));

CREATE INDEX IF NOT EXISTS agentbridge_a2a_sessions_room_status_idx
  ON agentbridge_a2a_sessions (tenant_id, (data->>'roomId'), (data->>'status'));

CREATE INDEX IF NOT EXISTS agentbridge_memories_owner_idx
  ON agentbridge_memories (tenant_id, (data->>'ownerAgentId'));

CREATE INDEX IF NOT EXISTS agentbridge_ai_reply_jobs_status_idx
  ON agentbridge_ai_reply_jobs (tenant_id, (data->>'status'), (data->>'roomId'));

INSERT INTO agentbridge_schema_migrations (version, description)
VALUES ('202605140001', 'agentbridge core jsonb state tables')
ON CONFLICT (version) DO NOTHING;
`;
}

function assertPostgresTableCoverage(): void {
  const covered = POSTGRES_STATE_TABLES.map((table) => table.collection);
  if (covered.join('\n') !== STATE_COLLECTION_KEYS.join('\n')) {
    throw new Error('Postgres state table specs must match STATE_COLLECTION_KEYS order and coverage.');
  }
}
