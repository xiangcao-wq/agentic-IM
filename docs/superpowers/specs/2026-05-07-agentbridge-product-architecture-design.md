# AgentBridge 产品化架构设计

## 状态

日期：2026-05-07

状态：待评审

目标读者：产品负责人、架构实现者、前端实现者、运维负责人

## 产品判断

当前项目不应继续定位为“AI 聊天软件 demo”。更有价值的方向是：

> AgentBridge 是一个可信 Agent 协作平台。它让个人 Agent 能代表用户在群聊、文件、任务、日程和外部工具之间协作，同时每一步都有证据、权限、确认和审计。

这个定位保留了现有项目最有竞争力的部分：Agent 代办、A2A 协商、权限门控、确认队列、审计日志和可解释证据。聊天界面只是入口，不是产品终点。

## 当前问题

### 1. Demo 能力和产品边界混在一起

仓库已经有可运行 demo、测试、构建、eval、Matrix 接入和产品化计划，但版本边界没有固化。源码、截图、日志、PDF 输出、运行数据和演示产物混在工作区里，后续维护者很难判断哪些是产品资产，哪些是临时产物。

### 2. 核心模块承担过多职责

`src/server/appServer.ts`、`src/server/agentRunRuntime.ts` 和 `src/App.tsx` 都已经接近或超过两千行。它们同时承担路由、鉴权、运行时编排、状态写入、UI 状态和产品展示，后续继续加能力会显著增加回归风险。

### 3. Agent 仍然偏 intent 驱动

当前 Agent 能处理总结、截止时间、找文件、发文件、协调等场景，但核心执行方式仍然接近 intent 分支。真实产品需要处理混合目标，例如“看看缺什么证据，如果可发就帮我发给陈晨，不确定就先问我”。这需要 session loop，而不是单次 intent handler。

### 4. 生产安全边界不足

本地 demo 允许无 token 模式，也仍有 URL query token 传递逻辑。公网或受控服务器部署前，必须改为 fail-closed：生产模式强制鉴权、禁止 URL token、明确 CORS、下载加固、写操作统一审计。

### 5. Matrix 被放得太靠近业务核心

Matrix 对 demo 很有用，但产品核心不应依赖 Matrix 数据结构。产品事实来源应该是自己的数据库。Matrix、Slack、Teams、飞书、邮件等都应是 connector，而不是核心状态模型。

### 6. 持久化不适合长期运营

JSON state 适合 demo，不适合多人并发、审计追踪、恢复、迁移、后台任务和长期运营。产品版本需要事务数据库、对象存储、后台队列和明确 migration。

## 设计目标

### 产品目标

- 用户能把自然语言目标交给自己的 Agent。
- Agent 可以查授权上下文、调用工具、和其他 Agent 协商。
- 所有内部事实回答都有证据来源。
- 所有写操作都有权限判断、风险级别和审计记录。
- 高风险动作进入确认队列，而不是自动执行。
- 运维人员能知道系统是否可用、哪些检查通过、最近失败在哪里。

### 工程目标

- 把 demo 项目整理成可发布、可回滚、可升级的产品代码库。
- 将 Agent Core、API、前端、connector、持久化和 eval 解耦。
- 让单个模块可以独立测试、独立替换、独立理解。
- 保留现有测试和演示资产，避免从零重写导致产品能力倒退。

### 非目标

- 第一阶段不做微服务拆分。
- 第一阶段不追求完全 autonomous Agent。
- 第一阶段不支持所有聊天平台。
- 第一阶段不做复杂企业 SSO。
- 第一阶段不把 UI 做成营销站或泛聊天工具。

## 推荐架构

采用“模块化单体 + 后台 worker”的产品架构。

```text
apps/web
apps/api
apps/worker

packages/domain
packages/agent-core
packages/db
packages/connectors
packages/eval
packages/ui
```

这个结构比当前单目录更清楚，但仍然比微服务简单。一个仓库、一套类型、一套测试，部署时可以先作为一个 Node 服务加一个 worker 运行。

## 运行链路

核心运行模型：

```text
User Event / Connector Event
  -> Event Store
  -> AgentSession
  -> ContextEngine
  -> Planner
  -> PolicyEngine
  -> ToolExecutor
  -> Observation
  -> Trace + Audit
  -> Response / Confirmation
```

### Event Store

所有用户消息、connector 事件、文件上传、任务变更和 Agent 动作都先进入产品自己的事件模型。外部平台事件只作为输入来源。

Event Store 的作用：

- 形成可回放事实流。
- 支持后台 worker 异步处理。
- 支持 Agent run trace 和 eval 复现。
- 避免 Matrix 或其他 connector 成为事实来源。

### AgentSession

一次 Agent 运行必须有 session。Session 保存目标、状态、步骤、最终输出和 trace。

第一版状态：

```text
running
waiting_for_user
needs_confirmation
completed
blocked
failed
```

第一版限制最多 4 个执行步骤。超过步数必须总结当前进展并请求用户确认或补充信息。

### ContextEngine

ContextEngine 负责收集授权证据，而不是让各个 runtime 分支自己拼字符串。

证据类型：

- message
- file_metadata
- file_text
- task
- calendar_event
- memory
- action_log
- a2a_turn
- web_result

每条证据必须有：

- id
- source type
- summary
- visibility
- confidence
- why selected

内部事实回答必须引用 evidence id。没有证据时，Agent 应明确说“当前授权上下文没有找到”，不能编造。

### Planner

Planner 输出小计划，不再只输出 intent。

计划原则：

- 先读后写。
- 先证据后结论。
- 不确定就追问。
- 写操作必须进入 PolicyEngine。
- 多目标请求拆成多个步骤。

Planner 可以先使用现有 fallback/local rules，后续再接真实 LLM structured output。产品质量来自约束和验证，不依赖模型一次性完美。

### PolicyEngine

PolicyEngine 是所有权限和风险判断的唯一入口。

它负责判断：

- Agent 是否代表正确 owner。
- 当前房间、文件、任务、日程是否在授权范围内。
- 操作是读还是写。
- 是否跨用户、跨房间、跨组织、跨 connector。
- 是否需要确认或直接阻断。

写操作不能绕过 PolicyEngine。被拒绝的操作也必须进入 trace。

### ToolRegistry 和 ToolExecutor

每个工具必须有完整定义：

- name
- description
- sideEffect
- input validation
- output shape
- required permissions
- risk policy
- executor
- audit formatter

第一批产品工具：

- `context.search_messages`
- `context.search_files`
- `file.read_text`
- `file.share`
- `message.send`
- `task.inspect`
- `task.propose_update`
- `calendar.inspect`
- `calendar.propose_update`
- `memory.search`
- `memory.write`
- `a2a.propose`
- `a2a.respond`
- `web.search`

ToolExecutor 负责校验、策略判断、执行、错误捕获、observation 和 audit，不负责最终自然语言回复。

### Trace 和 Audit

Trace 用于解释一次 Agent run 为什么这么做。Audit 用于记录真实或尝试过的敏感动作。

Trace 面向用户和调试：

- goal
- selected evidence
- planned steps
- tool calls
- policy decisions
- observations
- final status
- user-visible summary

Audit 面向运营和合规：

- actor
- represented user
- action
- target resource
- risk
- outcome
- reviewer
- timestamp

不展示隐藏 prompt 或 chain-of-thought。

## 数据架构

### 第一产品版本数据库

推荐使用：

- Postgres：主业务状态
- pgvector：记忆和文件语义检索
- Drizzle：schema 和 migration
- S3/R2/MinIO：文件对象存储
- Redis + BullMQ：后台任务和 Agent runs

### 核心表

```text
users
agents
rooms
room_members
messages
files
file_text_chunks
tasks
calendar_events
memories
agent_runs
agent_run_steps
agent_traces
action_requests
action_audits
a2a_sessions
a2a_turns
connector_accounts
connector_events
system_readiness_checks
```

JSON state 保留为 demo seed 和本地开发导入格式，但不再作为产品主存储。

### 文件存储

文件元数据进 Postgres，文件内容进对象存储，文本抽取结果进 `file_text_chunks`。

上传文件需要：

- MIME 和扩展名校验。
- 最大体积限制。
- SVG 产品模式加固或阻断。
- 下载默认 attachment。
- 每次下载可审计。

## API 架构

服务端建议从当前裸 Node HTTP 迁移到 Fastify 或 Hono。推荐 Fastify，因为插件生态、schema、hook 和生产运维能力更稳。

路由分组：

```text
/api/auth
/api/readiness
/api/rooms
/api/messages
/api/files
/api/tasks
/api/calendar
/api/agents
/api/agent-runs
/api/action-requests
/api/traces
/api/connectors
```

认证策略：

- 本地 demo 可以无 token。
- `NODE_ENV=production` 或 `AGENTBRIDGE_PUBLIC_MODE=true` 时强制 token。
- 生产模式禁止 query token。
- SSE 或 streaming 使用 header auth。
- CORS 默认拒绝，必须显式配置 origin。

## Worker 架构

同步 HTTP 请求不应直接承载所有 Agent 工作。

后台 worker 处理：

- Agent run execution
- 文件文本抽取
- embedding 生成
- connector sync
- Matrix observer
- eval runs
- scheduled cleanup
- trace compaction

API 可以先同步等待短任务，但底层仍通过 run record 和 worker-friendly 状态设计，方便后续扩展。

## Connector 架构

Matrix 改为 connector。

Connector 接口：

```text
connect
sync
sendMessage
uploadFile
downloadFile
mapExternalUser
mapExternalRoom
```

产品核心只认识内部 `Room`、`Message`、`File`、`User`、`Agent`。Matrix event id、mxc uri、access token 等只存在 connector 层。

第一阶段保留 Matrix connector，后续可增加 Slack、Teams、飞书、邮件或 Webhook。

## 前端产品设计

前端不应只是聊天窗口。它应是 Agent 操作台。

主要视图：

- Chat Timeline：人和 Agent 的可见交流。
- Agent Dock：当前 Agent 能做什么、正在做什么。
- Evidence Panel：本次回答引用了哪些证据。
- Action Queue：哪些动作待确认、风险原因是什么。
- Trace Inspector：Agent run 的可解释步骤。
- A2A Panel：Agent 之间协商轮次、状态和证据。
- Readiness Strip：auth、provider、db、worker、connector、eval 状态。

`src/App.tsx` 应拆成页面 shell 和多个特性组件。服务端数据统一用 TanStack Query 管理，避免手写大量请求状态。

## A2A 产品化

A2A 不是展示日志，而是协议。

第一版消息类型：

- proposal
- capability_check
- availability_response
- resource_response
- counter_proposal
- final_summary
- blocked

规则：

- 每个 Agent 只代表自己的 owner。
- 目标 Agent 必须通过自己的 ContextEngine 和 PolicyEngine 响应。
- A2A 不能绕过确认队列。
- A2A 可以生成建议，但多人日程、任务状态和文件外发默认需要确认。
- 每个 A2A turn 都有 trace。

## Eval 和质量门禁

产品 eval 不应只判断 intent。需要四类 eval：

### 任务完成

检查是否完成用户真实目标，例如找到正确文件、回答负责人、生成待确认日程方案。

### 证据约束

检查内部事实是否引用授权证据，无证据时是否拒绝编造。

### 安全边界

检查 owner-only 文件、私聊信息、跨房间读取、多人日程变更是否被正确阻断或确认。

### A2A 协议

检查目标 Agent 是否独立响应、是否携带证据、是否正确处理冲突和拒绝。

发布门禁：

```text
npm run test
npm run build
npm run eval:agent
npm run smoke:browser
```

受控产品 pilot 还需要：

```text
npm run readiness:product
```

真实 LLM eval 失败不能被忽略，只能标记为阻塞或明确降级为本地 demo 发布。

## 迁移策略

不建议从空目录重写。建议做“新内核旁路迁移”。

### 阶段 0：Release Freeze

目标：冻结当前 demo 为可回滚版本。

任务：

- 清理 `.gitignore`，忽略 `output/`、`data/backups/` 和运行产物。
- 建立 `docs/superpowers/status/2026-05-07-product-readiness.md`。
- 记录测试、构建、eval、browser smoke、Matrix smoke 状态。
- 提交当前已完成代码。
- 打 `v0.1.0-demo` tag。

验收：

- 干净 checkout 可运行 demo。
- 当前版本可回滚。

### 阶段 1：产品安全边界

目标：允许部署到受控服务器。

任务：

- 新增集中 auth 模块。
- 生产模式强制 token。
- 禁止生产 query token。
- 明确 CORS allowlist。
- 下载 header 加固。
- 新增 `/api/readiness`。

验收：

- 未授权写请求被拒绝。
- token 不出现在 URL。
- readiness 能显示 auth、db、worker、connector、provider 状态。

### 阶段 2：数据库和数据模型

目标：从 JSON state 迁移到 Postgres。

任务：

- 引入 Drizzle schema。
- 建核心表。
- 写 JSON seed 导入脚本。
- 文件迁移到对象存储。
- 保留 local demo seed。

验收：

- demo 数据可重复导入。
- 所有写操作在事务中完成。
- audit 和 trace 可查询。

### 阶段 3：Agent Core v2 Session

目标：替换 intent runtime 的核心执行方式。

任务：

- 新增 AgentSession。
- 新增 ContextEngine。
- 新增 Trace builder。
- 扩展 ToolRegistry 和 ToolExecutor。
- `/api/agent/run` 改为兼容层。

验收：

- 混合目标可以拆成多步。
- 写操作全部过 PolicyEngine。
- 每次 run 都有 trace。

### 阶段 4：Worker 和 Connector

目标：把耗时任务和外部平台同步移出请求主线程。

任务：

- 引入 Redis + BullMQ。
- Agent run 支持 worker 执行。
- Matrix observer 迁到 connector worker。
- connector event 进入 Event Store。

验收：

- Matrix 同步可重启恢复。
- Agent run 可重试、可查询状态。
- API 不被长任务阻塞。

### 阶段 5：产品 UI

目标：把前端从 demo workbench 升级为操作台。

任务：

- 拆分 App。
- 引入 TanStack Query。
- 增加 Evidence Panel。
- 增加 Trace Inspector。
- 增加 Readiness Strip。
- 优化 Action Queue 和 A2A Panel。

验收：

- 用户能理解 Agent 为什么这么做。
- 用户能确认、拒绝、回看动作。
- 运维能判断当前系统是否健康。

## 推荐版本路线

### v0.1.0-demo

用途：内部演示和评审。

要求：

- 当前 demo 能稳定运行。
- 测试、构建、本地 eval 通过。
- browser smoke 通过。
- 仓库清理完成。
- 打 tag。

### v0.2.0-pilot

用途：受控服务器部署。

要求：

- 生产鉴权和 CORS 完成。
- Postgres 主存储完成。
- readiness endpoint 完成。
- Agent trace 初版完成。
- 文件存储和下载加固完成。

### v0.3.0-product

用途：真实小团队试用。

要求：

- AgentSession v2 成为主路径。
- A2A 协议化。
- Worker 执行 Agent run。
- 产品 eval 扩展到任务级、安全级和 A2A 级。
- 操作台支持 evidence、trace、action queue。

## 技术取舍

### 为什么不直接微服务

当前团队和项目阶段更需要速度、可理解性和类型一致性。微服务会带来部署、认证、链路追踪、schema 同步和本地开发复杂度，不值得第一阶段引入。

### 为什么不完全重写

现有项目已经有 200+ 测试、eval、demo seed、Matrix 接入和多个已验证 Agent 流程。完全重写会丢失这些反馈资产。正确做法是保留外壳和测试，用新内核逐步替换旧 runtime。

### 为什么要换数据库

JSON state 无法支撑并发写入、审计查询、trace 回放、后台任务和长期运营。Postgres 是产品化最低成本的稳定选择。

### 为什么要保留 Matrix 但降级为 connector

Matrix 是好的演示和协议基础，但产品不能被一个外部通讯协议绑住。降级为 connector 后，未来接 Slack、Teams 或飞书不会重写 Agent Core。

## 主要风险

### 重构范围过大

缓解：按 release freeze、安全边界、数据库、AgentSession、worker、UI 分阶段做。每阶段都保留可运行版本。

### Planner 不稳定

缓解：限制最多 4 步；写操作强制 PolicyEngine；无证据不回答内部事实；eval 失败不得发布。

### 数据迁移破坏 demo

缓解：JSON seed 只作为导入源保留；Postgres schema 和 seed importer 一起测试。

### UI 变成调试工具

缓解：Trace Inspector 和 Evidence Panel 默认展示用户可理解摘要，不暴露内部 prompt 和隐藏推理。

## 开放问题

1. 第一批受控 pilot 的目标用户是谁：学生团队、创业团队、企业项目组，还是评审 demo？
2. 部署环境优先选什么：单 VPS、Docker Compose、Railway/Fly.io、还是云服务器加对象存储？
3. 第一批 connector 是否只保留 Matrix，还是同时设计 Slack/飞书的抽象占位？
4. 用户账号体系第一版是否只做 token + 固定用户，还是直接做登录会话？

这些问题不阻塞架构方向，但会影响 v0.2.0-pilot 的实施细节。

## 验收标准

设计被认为通过时，后续 implementation plan 必须满足：

- 每个阶段都有可运行检查。
- 每个阶段都能回滚。
- 安全边界先于高级 Agent 能力。
- 数据迁移先保留 demo seed。
- 旧 runtime 只作为兼容层存在，不再继续膨胀。
- 产品发布必须有 release status 文档。

## 推荐下一步

先执行阶段 0：Release Freeze。

原因：

- 当前工作区已有大量未提交改动和产物。
- 测试、构建、本地 eval 已经通过。
- 不先冻结版本，后续大重构会失去可回滚基线。

阶段 0 完成后，再进入阶段 1 的产品安全边界实现。
