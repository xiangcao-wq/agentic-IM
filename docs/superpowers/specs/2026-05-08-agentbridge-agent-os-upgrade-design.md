# AgentBridge Agent OS 产品化升级设计

Status: Draft for review
Date: 2026-05-08
Owner: AgentBridge

## 0. 保密与边界

本设计吸收了成熟 Agent 框架的工程思想，但不复制内部源码、不暴露内部路径、不复述私有实现细节。本文只沉淀适合 AgentBridge 的产品架构、模块边界、数据模型和实施路线。

## 1. 一句话定位

AgentBridge 不应该继续只是一个“会调用 Agent 的 IM demo”。下一阶段应升级为一个面向个人和团队的 Agent OS: 以 IM/协作为入口，以可追踪任务、权限审计、工具执行、跨 Agent 协作为核心，让用户可以安全地把真实工作托付给 Agent。

## 2. 当前问题判断

从现有设计与实现路线看，项目已经完成了安全加固和首轮产品化准备，但仍偏 demo:

- 状态层偏轻: 仍有 JSON/内存状态思路，缺少把 Postgres/EventLog 作为权威事实源的统一设计。
- Agent 运行偏流程脚本: 现有 Agent 能工作，但缺少一套稳定的 Session Kernel / Harness 边界。
- 工具调用偏功能列表: 部分能力已经纳入 ToolRegistry/PolicyEngine/ToolExecutor，但还没有完整工具生命周期、权限请求、审计与 UI 表达。
- 协作偏聊天: A2A 和房间消息还没有升级为任务、角色、授权、交付物和证据链。
- UI 偏演示: 当前 Workbench 能看 Agent 工作，但还不是运营人员每天可用的任务台、审计台、权限台和发布台。
- 发布偏人工判断: 缺少 readiness、eval、trace replay、回滚、灰度、迁移状态等上线必需信号。

结论: 不建议继续堆聊天功能。应该先打造产品内核，再把聊天、文件、日程、Matrix 等能力接到内核上。

## 3. 产品原则

### 3.1 Event-first

所有 Agent 运行、工具调用、权限决策、任务状态变化都必须进入事件流。页面、审计、回放、评测、远程同步都从事件流读取。

### 3.2 Harness-first

Agent 的核心运行不应该绑定 UI、HTTP 或单一模型。需要三个 Harness:

- Product Harness: 产品运行时，负责创建会话、接入用户上下文、执行任务、产出事件。
- API Harness: 对外暴露 REST/SSE/WebSocket，处理取消、权限审批、游标恢复和错误映射。
- Eval Harness: 注入 fake model/fake tools/fixtures，稳定复现 Agent 行为，用于回归测试。

### 3.3 Transcript 和 Projection 分离

真实历史记录不能直接等同于喂给模型的上下文。系统要保留完整 transcript，同时根据预算、权限、任务阶段生成 model projection。

### 3.4 Permission before execution

所有有副作用的工具都必须经过可审计权限决策。工具在展示给模型之前也应按用户、房间、任务、策略进行过滤，而不是让模型看到所有工具再自行判断。

### 3.5 Task as first-class object

AgentBridge 的核心不是“消息”，而是“可追踪任务”。消息是入口，任务是承诺，事件是过程，交付物是结果，审计是信任。

### 3.6 Agent identity and lineage

每个 Agent、子 Agent、后台 Worker、远程 Agent 都需要身份、来源、授权范围、父子关系和运行边界。

### 3.7 Connector is not core

Matrix、文件、日程、邮件、浏览器、外部 Agent 平台都应作为 Connector/Plugin 接入，不应污染核心运行时。

### 3.8 Release by evidence

上线判断不能靠“看起来可用”。每个版本都要有 readiness checks、eval suite、trace replay、迁移检查、回滚路径和运行指标。

## 4. 目标架构

```text
Users / Rooms / Tasks / Files / Connectors
                |
          Product UI
  Workbench / Timeline / Permission Center / Task Board
                |
          API Harness
 REST / SSE / WebSocket / Cancel / Approval / Cursor Replay
                |
        Product Harness
 Session lifecycle / identity / policy context / event emission
                |
         Agent Kernel
 SessionState / ProjectionEngine / TurnRunner / ToolRuntime
                |
 Tool Platform / Permission Broker / Context Engine / Memory Engine
                |
 EventLog / Postgres / Outbox / Worker Leases / Object Storage
                |
 Background Workers / Connectors / Eval Harness / Ops
```

## 5. 核心模块设计

### 5.1 Product Harness

Product Harness 是产品内核的入口，负责把一个用户意图变成可追踪 Agent Run。

职责:

- 创建 agent_session 和 agent_run。
- 注入 tenant、user、room、task、file、memory、connector 上下文。
- 绑定权限策略和工具可见性。
- 输出标准 AgentEvent 流。
- 支持 cancel、resume、retry、replay。
- 记录 usage、cost、latency、error、permission denial。

最小接口:

```ts
type StartAgentRunInput = {
  tenantId: string
  userId: string
  roomId?: string
  taskId?: string
  entrypoint: 'chat' | 'task' | 'file' | 'schedule' | 'connector' | 'eval'
  userMessage: string
  attachments?: AttachmentRef[]
  mode: 'live' | 'shadow' | 'eval'
}

type StartAgentRunResult = {
  sessionId: string
  runId: string
  eventCursor: string
}
```

### 5.2 API Harness

API Harness 负责把产品内核稳定地暴露给前端和外部系统。

建议接口:

- `POST /api/agent-runs`: 创建运行。
- `GET /api/agent-runs/:runId/events`: SSE 事件流，支持 cursor。
- `POST /api/agent-runs/:runId/cancel`: 取消运行。
- `POST /api/agent-runs/:runId/retry`: 基于失败点重试。
- `GET /api/traces/:traceId`: 获取可视化 trace。
- `GET /api/tasks/:taskId/timeline`: 获取任务时间线。
- `POST /api/permission-requests/:id/approve`: 批准工具执行。
- `POST /api/permission-requests/:id/deny`: 拒绝工具执行。

约束:

- 不使用 query token 承载敏感凭证。
- SSE 必须支持断线恢复。
- cancel 必须传递到正在运行的模型调用、工具执行和 Worker。
- 所有错误映射成产品错误码，避免前端依赖内部异常字符串。

### 5.3 Agent Kernel

Agent Kernel 是“Agent 会话操作系统”。它不关心 UI，只关心如何安全、可恢复、可解释地推进一次运行。

组成:

- `SessionState`: 保存会话、运行、预算、取消信号、权限拒绝、工具结果、阶段状态。
- `ProjectionEngine`: 根据完整 transcript、任务状态、记忆、文件摘要、权限策略生成模型上下文。
- `TurnRunner`: 驱动 model -> tool_use -> observation -> next_turn 的有限状态机。
- `ToolRuntime`: 执行工具调用，做 schema 校验、权限检查、超时、重试、结果序列化。
- `ResponseComposer`: 把内部事件、证据和工具结果整理成用户可读输出。

状态机:

```text
created
  -> projecting_context
  -> model_turn
  -> awaiting_permission
  -> executing_tool
  -> observing_result
  -> composing_response
  -> completed

任何阶段可进入:
  -> cancelled
  -> failed
  -> suspended
```

关键要求:

- 每次状态转移写入事件。
- 模型消息、工具观察、用户可见消息分层存储。
- 工具结果必须同时有 machine-readable result 和 user-visible summary。
- 长任务可 suspend/resume。

### 5.4 EventLog

EventLog 是 AgentBridge 从 demo 变成产品的底座。

事件必须包含:

- 全局递增或可排序序号。
- tenant/session/run/task 维度。
- idempotency key。
- cursor。
- visibility: user-visible / internal / audit-only。
- causation/correlation id。
- created_at 和 actor。

基础事件类型:

- `agent.run.created`
- `agent.run.started`
- `agent.context.projected`
- `agent.model.requested`
- `agent.model.completed`
- `agent.tool.requested`
- `agent.permission.requested`
- `agent.permission.approved`
- `agent.permission.denied`
- `agent.tool.started`
- `agent.tool.completed`
- `agent.tool.failed`
- `agent.message.emitted`
- `agent.task.created`
- `agent.task.updated`
- `agent.a2a.message.sent`
- `agent.run.completed`
- `agent.run.failed`
- `agent.run.cancelled`

EventLog 能力:

- cursor replay。
- snapshot。
- outbox dispatch。
- trace reconstruction。
- eval fixture export。
- audit export。

### 5.5 Tool Platform

工具不是函数列表，而是产品能力。

每个工具需要:

- name/version/description。
- input schema/output schema。
- side effect level: read-only / write / external / destructive。
- permission policy。
- visibility policy。
- timeout/retry/cancel support。
- user-visible rendering。
- model-visible observation。
- audit payload redaction。

工具调用流程:

```text
model requests tool
  -> schema validation
  -> visibility re-check
  -> permission decision
  -> approval queue if needed
  -> execution lease
  -> result serialization
  -> audit event
  -> observation to model
```

优先产品化的工具:

- `message.send`
- `file.search`
- `file.read`
- `file.share`
- `task.create`
- `task.update`
- `calendar.read`
- `calendar.schedule`
- `a2a.delegate`
- `a2a.reply`
- `memory.read`
- `memory.write`

### 5.6 Permission Broker

权限系统需要从“工具执行前拦一下”升级为“可理解、可配置、可审计的授权账本”。

决策类型:

- allow
- deny
- ask
- allow with constraints

策略维度:

- user role。
- room membership。
- file ownership。
- task scope。
- connector account。
- tool side effect level。
- cost/budget。
- time window。
- destination domain。

产品功能:

- 权限审批队列。
- 最近决策记录。
- 自然语言策略编辑器。
- capability lease: 一次性、限时、限范围授权。
- shadow mode: 只模拟将要执行的操作，不真正执行。

### 5.7 Context Engine and Memory

上下文系统要从“把资料塞进 prompt”升级为“上下文胶囊”。

Context Capsule:

- scope: user / room / task / file / connector / org。
- source references。
- freshness。
- permission boundary。
- summary。
- raw retrieval cursor。
- confidence。

Memory 类型:

- user preference。
- project fact。
- task decision。
- agent skill。
- connector mapping。
- negative memory: 明确不要重复的失败路径。

原则:

- 模型只能看到经过权限过滤和预算压缩的 projection。
- 记忆写入必须有来源和撤销路径。
- 重要事实要能回溯到 message/file/task/event。

### 5.8 A2A Collaboration

A2A 不应只是 Agent 之间发消息。它应成为任务协作协议。

核心对象:

- `a2a_session`: 一次跨 Agent 协作。
- `a2a_participant`: 参与 Agent、角色、能力、授权。
- `a2a_turn`: 协作轮次。
- `a2a_artifact`: 交付物。
- `a2a_claim`: 声明、证据、置信度。
- `a2a_decision`: 决策和责任归属。

协作模式:

- delegate: 主 Agent 派发子任务。
- consult: 咨询另一个 Agent。
- review: 评审另一个 Agent 的输出。
- negotiate: 多 Agent 对计划和权限达成一致。
- handoff: 把任务移交给更合适的 Agent。

v0.2 只做最小 A2A session 和 task delegation。动态协商放到 v0.3。

### 5.9 Worker and Remote Runtime

后台 Worker 需要具备产品级运行能力:

- lease/heartbeat。
- worker epoch，避免重复执行。
- job idempotency。
- cancel propagation。
- retry with backoff。
- dead letter queue。
- outbox delivery。
- readiness metrics。

Worker 类型:

- agent-runner。
- connector-sync。
- file-indexer。
- eval-runner。
- notification-dispatcher。
- trace-compactor。

### 5.10 Product UI

UI 的目标不是炫技，而是让用户愿意把真实工作交给 Agent。

核心视图:

- Agent Workbench: 当前运行、模型思考摘要、工具调用、输出。
- Task Board: 待办、进行中、等待权限、已完成、失败。
- Timeline: 按时间显示消息、工具、权限、文件、任务、A2A 事件。
- Permission Center: 待审批、已授权、已拒绝、策略规则。
- Evidence Board: Agent 输出引用了哪些文件、消息、工具结果。
- Trace Viewer: 开发和运营用的可回放事件树。
- Readiness Console: DB、worker、queue、auth、storage、provider、error rate。
- Connector Settings: Matrix、文件、日程、未来邮件/浏览器等。

UI 设计方向:

- 操作台式布局，信息密度高但不拥挤。
- 以任务和事件为主线，而不是大聊天框为唯一主界面。
- 高风险操作必须可见、可撤销或可拒绝。
- Trace 和审计默认给运营/开发看，普通用户只看简化解释。

## 6. 数据模型建议

### 6.1 Identity and Collaboration

- `tenants`
- `users`
- `user_profiles`
- `agents`
- `agent_identities`
- `agent_capabilities`
- `rooms`
- `room_members`
- `messages`
- `message_attachments`

### 6.2 Tasks and Artifacts

- `tasks`
- `task_events`
- `task_assignments`
- `task_artifacts`
- `task_dependencies`
- `calendar_events`
- `files`
- `file_versions`
- `file_text_chunks`
- `file_permissions`

### 6.3 Agent Runtime

- `agent_sessions`
- `agent_runs`
- `agent_events`
- `agent_internal_events`
- `agent_trace_snapshots`
- `agent_tasks`
- `model_invocations`
- `tool_invocations`
- `tool_results`
- `usage_events`

### 6.4 Permission and Audit

- `permission_rules`
- `permission_requests`
- `permission_decisions`
- `capability_leases`
- `action_audits`
- `security_events`

### 6.5 A2A

- `a2a_sessions`
- `a2a_participants`
- `a2a_turns`
- `a2a_artifacts`
- `a2a_claims`
- `a2a_decisions`

### 6.6 Connectors and Workers

- `connector_accounts`
- `connector_events`
- `connector_sync_state`
- `worker_leases`
- `outbox_events`
- `dead_letter_events`
- `readiness_checks`
- `device_cursors`

## 7. 版本路线

### v0.2 Product Kernel

目标: 让 demo 拥有产品底座，可以做受控试运行。

必须交付:

- Postgres 权威状态源和迁移脚本。
- AgentEvent/EventLog。
- Product Harness + API Harness。
- SSE 事件流和 cursor replay。
- Tool Platform v2。
- Permission Center 初版。
- Agent Trace 初版。
- Worker lease/heartbeat。
- A2A session 初版。
- Eval Harness 初版。
- Readiness Console 初版。
- 旧 JSON 状态只允许作为导入源或开发兼容，不再作为生产事实源。

不做:

- 完整 marketplace。
- 多组织企业治理。
- 动态多 Agent 竞价/任务市场。
- 大规模插件生态。

### v0.3 Agent Workbench

目标: 让用户每天使用，而不是只看演示。

交付:

- 后台 Agent 和定时任务。
- 任务模板和 Skill 模板。
- shadow mode。
- 自然语言策略编辑器。
- A2A delegation/review/consult。
- 远程或移动端权限审批。
- 记忆中心和上下文胶囊。
- Connector 扩展: Matrix 稳定、文件索引稳定、日程稳定。
- 运行成本、耗时、失败原因可视化。

### v1.0 Collaborative Agent OS

目标: 成为可商业化、可部署、可运营的 Agent 协作系统。

交付:

- 多端 Bridge。
- 组织级策略和审计。
- signed authorization ledger。
- 插件/技能市场。
- 跨 Agent 协商协议。
- 回滚、版本化、灰度发布。
- 企业观测: SLO、成本、队列、错误、工具风险。
- 私有化部署文档。

## 8. 实施顺序

### Phase 0: 状态刷新

先把旧文档和代码现状对齐，明确 PR #1/#2 之后哪些已经完成，哪些仍是计划。

输出:

- `docs/superpowers/status/` 下的当前能力清单。
- 风险清单。
- v0.2 release gate 清单。

### Phase 1: EventLog and Postgres Foundation

先做事件和数据底座，避免继续在 demo 状态上叠功能。

输出:

- 核心迁移脚本。
- Event append/read/replay API。
- Outbox 表。
- Worker lease 表。
- JSON seed/import 工具。
- 数据健康检查。

### Phase 2: Product Harness

把现有 Agent runtime 包在 Product Harness 后面，不急着一次性重写全部。

输出:

- `startAgentRun`
- `streamAgentEvents`
- `cancelAgentRun`
- `resumeAgentRun`
- run/session/trace 统一 ID。

### Phase 3: Tool Platform v2

把所有写操作和外部副作用纳入统一工具平台。

输出:

- ToolDefinition。
- ToolInvocation。
- PermissionBroker。
- 审批队列。
- 工具审计。
- 工具结果标准化。

### Phase 4: Agent Kernel Refactor

将 runtime 拆成 SessionState、ProjectionEngine、TurnRunner、ToolRuntime。

输出:

- 有限状态机。
- transcript/projection 分离。
- 上下文预算和压缩。
- 模型/工具/观察的事件化。

### Phase 5: A2A Product Model

让 Agent 协作从“互相发话”升级为任务协作。

输出:

- a2a_session。
- a2a_participant。
- a2a_turn。
- delegate/review/consult 三类初始动作。
- Evidence Board 可展示 A2A 证据。

### Phase 6: Workbench UI

前端从聊天 demo 升级为真实操作台。

输出:

- Agent Workbench。
- Task Board。
- Timeline。
- Permission Center。
- Trace Viewer。
- Readiness Console。

### Phase 7: Worker and Connectors

后台能力产品化。

输出:

- agent-runner worker。
- connector-sync worker。
- file-indexer worker。
- readiness metrics。
- Matrix 作为 Connector 接入。

### Phase 8: Eval and Release Gates

建立上线纪律。

输出:

- Eval fixtures。
- trace replay。
- smoke/load/security checks。
- release checklist。
- rollback runbook。

## 9. v0.2 完成定义

v0.2 不是“功能很多”，而是“产品底座可信”。

必须满足:

- 每次 Agent run 都有完整事件流。
- 每次 Agent run 都可以从 trace 还原关键过程。
- 每个写操作都经过 Tool Platform。
- 每个高风险工具都有权限决策。
- 每个权限决策都有审计记录。
- SSE 断线后可用 cursor 恢复。
- Worker 有 lease/heartbeat/idempotency。
- Readiness Console 显示 DB migration、event lag、worker heartbeat、queue depth、provider/auth/storage、recent error rate。
- Eval Harness 至少覆盖安全拒绝、文件检索、任务创建、消息发送、A2A delegation。
- 旧版本仍可迁移或回滚，不因升级直接中断用户。

## 10. 产品创新点

### 10.1 Agent Work Timeline

把 Agent 工作过程做成时间线。用户不需要理解 prompt，但能看到 Agent 做了什么、用了什么证据、请求了什么权限、为什么失败。

### 10.2 Evidence Board

Agent 的回答必须能链接到文件、消息、任务、工具结果或明确标记为推断。这个能力会显著提升信任感。

### 10.3 Capability Lease

用户不只是“同意/拒绝”。可以给 Agent 一个限时、限任务、限文件、限工具、限金额的授权。

### 10.4 Shadow Mode

高风险操作先模拟执行，展示 Agent 将要做什么，用户确认后再真正执行。适合部署、删除、对外发送、批量修改。

### 10.5 Natural-language Policy Editor

用户用自然语言写规则，例如“这个项目里 Agent 可以读取文件，但对外发送消息前必须问我”。系统把它转为可审计策略。

### 10.6 A2A Review Loop

一个 Agent 产出方案，另一个 Agent 按不同角色评审，最后主 Agent 汇总决策。这比单 Agent 长上下文更适合复杂工作。

### 10.7 Context Capsules

上下文不是临时 prompt，而是可复用、可撤销、可追溯的资料包。适合长期项目运营。

### 10.8 Readiness as Product Surface

把系统健康、迁移状态、队列积压、模型错误、工具失败变成运营界面，而不是隐藏在日志里。

## 11. 风险与控制

### 11.1 范围过大

控制方式: v0.2 只做 Product Kernel。市场、企业治理、复杂多 Agent 协商放到后续。

### 11.2 重构影响现有可用功能

控制方式: 先用 Harness 包住现有 runtime，再逐步替换内部模块。保留兼容层和迁移脚本。

### 11.3 数据迁移风险

控制方式: 迁移前备份，提供 dry-run/import report，旧 JSON 只读保留一段时间。

### 11.4 权限系统过度复杂

控制方式: 先实现 allow/deny/ask + capability lease，策略编辑器放到 v0.3。

### 11.5 Agent 不可解释

控制方式: EventLog、Trace、Evidence Board 是 v0.2 必需项，不是锦上添花。

### 11.6 内部参考资料合规

控制方式: 只借鉴架构思想，不复制代码、命名空间、私有路径或实现细节。所有实现按 AgentBridge 需求重新设计。

## 12. 立即下一步

建议下一步不要直接大面积改代码，而是进入 v0.2 Product Kernel 实施计划:

1. 建立当前代码能力清单，标记哪些模块保留、包裹、替换。
2. 写 `2026-05-08-agentbridge-product-kernel-implementation-plan.md`。
3. 第一个开发切片只做 EventLog + Product Harness 最小闭环。
4. 第二个切片接 Tool Platform v2 和 PermissionBroker。
5. 第三个切片做 Workbench Timeline/Trace Viewer。

优先开发顺序:

```text
EventLog -> Product Harness -> Tool Platform -> PermissionBroker
         -> Trace Viewer -> Worker Lease -> A2A Session -> Eval Harness
```

这条路线的好处是: 每一步都能提高真实产品能力，并且不会把系统推向一次性推倒重来的高风险状态。
