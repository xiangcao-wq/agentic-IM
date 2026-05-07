# Agent IM Demo

一个真实本地可跑通的个人 Agent 融合即时通信 demo。前端不再直接使用内存假状态，聊天、Agent 操作和审计记录都通过本地 API 写入 `data/agent-im-db.json`。

## Run

```bash
npm install
npm run demo:prepare
npm run dev:full
```

默认地址：

- Frontend: `http://127.0.0.1:5175`
- API: `http://127.0.0.1:8791`
- Persistent DB: `data/agent-im-db.json`

也可以分开启动：

```bash
npm run api
npm run dev
```

`npm run demo:prepare` creates a clean deployable demo database plus local media files from committed assets. It writes:

- `data/agent-im-db.json`
- `data/media/*`

These runtime files are intentionally ignored for normal commits. The repository contains the source assets and seed scripts, so a server can recreate the complete demo state without committing local chat history or machine-specific Matrix media ids.

## Deployment Modes

Local Demo:

```bash
AGENT_IM_PUBLIC_MODE=false
AGENT_IM_API_TOKEN=
VITE_AGENT_API_TOKEN=
npm run demo:prepare
npm run dev:full
```

Local demo allows no-token requests and keeps `agent_im_token` query-token compatibility for older local tooling.

Controlled Server Pilot:

```bash
AGENT_IM_PUBLIC_MODE=true
AGENT_IM_API_TOKEN=<server-token>
AGENT_IM_ALLOWED_ORIGINS=https://your-agentbridge-host.example.com
VITE_AGENT_API_TOKEN=<server-token>
npm run build
npm run api
```

Controlled server pilot requirements:

- `AGENT_IM_API_TOKEN` is required.
- Browser requests send the token in the `x-agent-im-token` header.
- `agent_im_token` query parameters are rejected.
- CORS allows only origins listed in `AGENT_IM_ALLOWED_ORIGINS`.
- File downloads are served as attachments with `nosniff` and no-store cache headers.
- SVG uploads are rejected.
- Readiness is available without exposing secrets:

```bash
curl -H "x-agent-im-token: <server-token>" https://your-agentbridge-host.example.com/api/readiness
```

## Verified Flow

1. 发送一条真实用户消息，后端写入 `messages`。
2. 点击“问截止”，Agent 从服务端状态读取班级群和文件上下文，生成回答和审计记录。
3. 点击“离线代发”，Agent 评估低风险后创建一条带有“林雯的 Agent 代发”标识的文件消息。
4. 点击“Agent 协调”，Agent 识别多人日程变更为高风险，生成需要人工确认的协调建议。

## Quality Gates

```bash
npm run test
npm run build
npm run infra:smoke
```

当前测试覆盖：

- 核心个人 Agent 行为
- 本地 API 持久化集成流程
- 前端 API 客户端请求路径
- Agent 待确认动作前端审核
- Matrix 显式同步和媒体下载

## Operations

Reset local product state back to the clean demo seed:

```bash
npm run infra:reset
```

Prepare the richer deployable demo with real downloadable Image-2 PNG, PDF, Markdown, and text assets:

```bash
npm run demo:prepare
```

Run a smoke check against running API and web servers:

```bash
npm run dev:full
npm run infra:smoke
```

`/api/state` no longer pulls Matrix room history on every read. Matrix events enter the product state only when `POST /api/matrix/sync-once` is called from the UI or smoke script, which keeps old 联调消息 from polluting a clean demo after `npm run infra:reset`.

## Current Boundary

Matrix mode:

```bash
npm run matrix:up
npm run dev:full
```

When `data/matrix-bootstrap.json` exists, the API writes chat messages through the local Synapse homeserver, persists the returned Matrix event ids in the local DB, and keeps files, tasks, calendar, Agent actions, and audit logs in the local persistent DB. Historical Matrix events are imported only by explicit sync.

The Synapse container listens on `http://127.0.0.1:8008`. Demo Matrix users are `lin`, `chen`, `zhao`, and `teacher` with the local development password `demo-pass`.

Real AI demo seed:

```bash
$env:DEEPSEEK_API_KEY = "sk-..."
npm run matrix:up
npm run ai:seed
npm run dev:full
```

`npm run ai:seed` routes real model calls by actor type through `src/server/aiProvider.ts`; it has no mock fallback. Human-like AI users default to DeepSeek V4 Flash, while personal Agents default to DeepSeek V4 Pro with Thinking enabled and `reasoning_effort=high`. If the DeepSeek key is missing or either route fails the preflight request, the command exits before reading the state file or touching Matrix. The running app also exposes an LLM health check through `/api/ai/status/check`.

DeepSeek prompt-cache telemetry is read from `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` and exposed in `/api/state.aiStatus.cache`. Agent prompts keep stable authorized context before the current user request so DeepSeek's automatic prefix cache can reuse more input tokens.

Model routing:

- Human AI actors: `DEEPSEEK_HUMAN_MODEL`, defaults to `deepseek-v4-flash`.
- Personal Agents: `DEEPSEEK_AGENT_MODEL`, defaults to `deepseek-v4-pro`.
- DeepSeek API base: `DEEPSEEK_BASE_URL`, defaults to `https://api.deepseek.com`.
- Both routes use `DEEPSEEK_API_KEY`.
- Optional thinking controls: `DEEPSEEK_HUMAN_THINKING` and `DEEPSEEK_AGENT_THINKING` accept `enabled` or `disabled`; Agents default to `enabled`.
- Optional reasoning controls: `DEEPSEEK_HUMAN_REASONING_EFFORT` and `DEEPSEEK_AGENT_REASONING_EFFORT` accept `low`, `medium`, or `high`; Agents default to `high` when Thinking is enabled.
- Web search: DeepSeek plans the request and can call the app-provided `web.search` tool for public web results. This keeps API behavior explicit while still allowing DeepSeek to use external search instead of being limited to internal room context.

Optional variables:

- `AGENT_IM_DB_PATH`: override for the JSON state file.
- `MATRIX_BOOTSTRAP_PATH`: override for Matrix bootstrap credentials.
- `AGENT_IM_PUBLIC_MODE`: set to `true` for controlled server or public mode.
- `AGENT_IM_API_TOKEN`: server token required in controlled server or public mode.
- `AGENT_IM_ALLOWED_ORIGINS`: comma-separated browser origins allowed by CORS.
- `AGENT_IM_ALLOW_NO_AUTH`: emergency local override only; do not enable for controlled server deployments.
- `AGENT_IM_ALLOW_QUERY_TOKEN`: local compatibility only; product/public/production mode rejects query tokens.
- `VITE_AGENT_API_TOKEN`: browser client token value for local demos or controlled single-user deployments.
- `AGENT_IM_MAX_UPLOAD_BYTES`: upload size limit; defaults to 10 MB.
- `AGENT_IM_MEDIA_DIR`: local media fallback directory; defaults to `data/media` when Matrix media is not configured.

## Infra Plan

The active infrastructure plan is stored at:

`docs/superpowers/plans/2026-05-04-agent-im-infra.md`

Current infra status:

- Matrix Synapse handles real rooms, events, and media upload/download.
- The API owns product state, Agent actions, file metadata, tasks, calendar, and audit logs.
- Persistence now goes through `StateStore` in `src/server/stateStore.ts`; the current implementation is `JsonStateStore`.
- Database-ready collection names and state shape validation live in `src/server/stateSchema.ts`.
- Agent action queue types and pure state transitions live in `src/domain/actionQueue.ts`.
- `/api/agent/share-file` now runs through `src/server/agentRuntime.ts`, creating an action request plus audit log before tool execution.
- Confirmation queue endpoints are available at `GET /api/agent/actions`, `POST /api/agent/actions/:id/confirm`, and `POST /api/agent/actions/:id/reject`; the frontend workbench shows pending actions and confirm/reject controls.
- Confirmed file-share actions now execute the actual share tool and persist the resulting message.
- Uploads are constrained by size, MIME type, and extension.
- `appServer.ts` no longer owns the JSON persistence implementation directly, which makes the next SQLite/Postgres step isolated.

Next infra priorities:

1. Migrate summary, deadline, and coordination endpoints into the shared runtime pipeline.
2. Add a background Matrix observer loop using `/sync` tokens instead of manual sync.
3. Move JSON persistence to SQLite/Postgres transactions for concurrent Agent writes.
4. Add role-based identities instead of the current fixed demo user.
