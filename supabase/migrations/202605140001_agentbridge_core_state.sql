-- AgentBridge core state schema.
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
    'agentbridge_users',
    'agentbridge_agents',
    'agentbridge_rooms',
    'agentbridge_messages',
    'agentbridge_files',
    'agentbridge_file_text_chunks',
    'agentbridge_tasks',
    'agentbridge_calendar_items',
    'agentbridge_action_logs',
    'agentbridge_action_requests',
    'agentbridge_a2a_sessions',
    'agentbridge_agent_goal_plans',
    'agentbridge_agent_autopilot_policies',
    'agentbridge_memories',
    'agentbridge_matrix_observer_checkpoints',
    'agentbridge_ai_autoreply_policies',
    'agentbridge_ai_reply_jobs'
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
