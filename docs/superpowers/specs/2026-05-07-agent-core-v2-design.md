# Agent Core v2 设计文档

## 状态

日期：2026-05-07

状态：草案，等待评审

目标读者：产品负责人、架构实现者、前端实现者、评测维护者

## 背景

当前 Agent IM 已经具备演示级能力：个人 Agent、群聊上下文、文件、任务、日程、确认队列、审计日志、A2A 会话、Matrix 接入、AI provider 和基础评测。它已经能说明产品方向，但真实使用时会暴露三个核心问题：

1. Agent 感觉不够智能。它更像一组按钮和固定流程，而不是能理解目标、分解任务、连续行动的助手。
2. Agent 架构不够好用。核心逻辑分散在 `agentEngine.ts`、`agentRuntime.ts`、`agentRunRuntime.ts`、`memory.ts` 和 `agentTools.ts` 中，意图、工具、权限、记忆、审计、fallback 互相耦合。
3. 产品缺少关键能力。上下文检索、工具协议、策略门控、结构化记忆、运行 trace、质量评测和 A2A 协议都还停留在 demo 形态。

本设计的目标是重构 Agent Core，而不是重写整个产品。前端壳、现有 API 入口、演示数据、Matrix 集成、确认队列和已有测试资产都应尽量保留。要替换的是 Agent 内核的执行方式。

## 设计目标

Agent Core v2 要让系统从“意图分发器”升级为“受控的目标执行系统”。

核心目标：

- 让 Agent 围绕用户目标运行，而不是只匹配一个固定 intent。
- 支持多步 plan-act-observe 循环。
- 让工具调用可组合、可验证、可审计。
- 让权限和风险判断独立于具体业务 handler。
- 让上下文检索从字符串拼接升级为结构化证据选择。
- 让记忆从普通文本追加升级为可追踪、可过期、可检索的结构化记录。
- 让每次 Agent 运行都有 trace，能解释为什么这么答、为什么调用工具、为什么阻断或确认。
- 让评测从“是否选对 intent”升级为“是否真的完成任务且不越权”。

非目标：

- 不在第一阶段重写 UI。
- 不在第一阶段替换 Matrix。
- 不在第一阶段引入复杂工作流引擎。
- 不把所有能力一次性做成 fully autonomous。写操作仍然默认受策略门控。

## 当前问题诊断

### 1. 意图枚举限制智能表现

当前运行入口基本围绕 `AgentRunIntent` 展开，例如 `summary`、`deadline`、`find_file`、`share_file`、`coordinate`、`chat`。这适合 demo，但真实用户请求经常是混合目标：

- “帮我看看现在卡在哪里，能不能把该发的材料发给陈晨”
- “林雯不在线，今晚能不能让她的 Agent 帮我确认一下日程和截图”
- “这个任务谁负责，缺什么证据，能不能先补上”

这些请求不应该被压扁成一个 intent。Agent 应该拆成多个步骤：理解目标、查任务、查文件、判断授权、提出计划、必要时执行低风险动作、对高风险动作请求确认。

### 2. 缺少真正的 Agent 循环

当前逻辑更接近：

1. 生成一次 plan。
2. 进入一个固定分支。
3. 调一个或少量硬编码工具。
4. 返回结果。

v2 应改为：

1. 读取用户目标和当前事件。
2. 选择需要的上下文。
3. 生成可执行步骤。
4. 执行一个步骤。
5. 观察工具结果。
6. 根据观察决定继续、结束、追问或请求确认。
7. 生成最终回复和 trace。

### 3. 工具不是完整运行时

当前 `agentTools.ts` 主要描述工具名称、读写属性和是否需要风险门控，但还没有形成统一的工具协议。工具参数使用 `Record<string, unknown>`，缺少 schema、权限声明、执行器、结果结构、失败语义和审计格式。

这会导致每个业务分支自己判断参数、权限、风险和日志，最后系统越来越难扩展。

### 4. 记忆系统太弱

当前记忆是文本记录加关键词检索，适合演示，但不适合真实产品。真实 Agent 需要区分：

- 用户偏好
- 项目事实
- 团队决策
- 待确认事项
- 历史摘要
- 授权范围
- 低置信度推断
- 已过期信息

不同记忆类型的检索、展示、可信度和过期策略都不同。

### 5. 上下文检索偏弱

当前上下文主要来自最近消息、关键词匹配、文件元数据、文件片段和记忆。问题是：

- 选择依据不够透明。
- 对跨房间、跨文件、跨任务的关系建模不足。
- 文件版本、任务依赖、日程冲突没有形成统一证据图。
- 语义相似但关键词不匹配时容易漏掉。

### 6. 评测不能代表真实智能

当前 eval 更多验证 intent 和工具选择。v2 评测要转向任务级指标：

- 是否回答了用户真正问题。
- 是否引用了正确证据。
- 是否主动追问缺失信息。
- 是否正确阻断越权请求。
- 是否正确进入确认队列。
- 是否完成了可自动执行的低风险动作。
- 是否避免泄露私有上下文。

### 7. 编码损坏影响 prompt 与体验

部分中文 prompt、规则、fallback 和文档内容出现编码损坏。这不是小问题。乱码会影响：

- 模型理解系统指令。
- 关键词匹配。
- fallback 输出。
- 测试用例可读性。
- 用户对产品质量的信任。

v2 重构前必须先清理这些文本资产。

## 推荐方案

采用“保留产品壳，替换 Agent Core”的渐进式重构。

保留：

- `/api/agent/run` API 入口。
- 当前 React 工作台。
- 确认队列概念。
- 审计日志概念。
- A2A 会话概念。
- Matrix 消息和文件基础设施。
- 现有 demo seed 和评审材料。

替换或重构：

- `agentRunRuntime.ts` 中的大型分支执行器。
- `agentEngine.ts` 中按能力拆散的硬编码推理。
- `agentTools.ts` 中过薄的工具定义。
- `memory.ts` 中纯文本记忆和简单检索。
- `agentEval.ts` 中 intent 驱动的评测标准。

## 目标架构

整体链路：

```text
User Message / System Event
  -> AgentSession
  -> ContextEngine
  -> Planner
  -> PolicyEngine
  -> ToolExecutor
  -> Observation
  -> MemoryEngine
  -> ResponseComposer
  -> Trace + Eval
```

### AgentSession

`AgentSession` 是一次 Agent 运行的根对象。它负责管理 run id、用户目标、状态、步骤、事件、最终结果。

建议字段：

```ts
interface AgentSession {
  id: string;
  agentId: string;
  roomId: string;
  trigger: AgentTrigger;
  goal: AgentGoal;
  status: 'running' | 'waiting_for_user' | 'needs_confirmation' | 'completed' | 'failed';
  steps: AgentStep[];
  createdAt: string;
  updatedAt: string;
}
```

`AgentSession` 不直接实现业务逻辑。它只协调 Context、Planner、Policy、Tools、Memory 和 Response。

### ContextEngine

`ContextEngine` 负责把“用户请求”变成“可用于推理的证据包”。

输入：

- agentId
- roomId
- userText
- requested scope
- current goal
- previous observations

输出：

```ts
interface AgentContextBundle {
  scope: 'current_room' | 'authorized_rooms' | 'external';
  evidence: ContextEvidence[];
  entities: ContextEntity[];
  constraints: ContextConstraint[];
  missing: MissingContext[];
}
```

证据类型：

- message
- file_metadata
- file_text
- task
- calendar
- memory
- action_log
- a2a_turn
- web_result

每条证据必须包含：

- id
- source type
- readable summary
- confidence
- visibility
- why selected

### Planner

`Planner` 不再只输出单个 intent，而是输出一个小计划。

```ts
interface AgentPlan {
  goal: string;
  assumptions: string[];
  steps: PlannedStep[];
  finalResponseIntent: 'answer' | 'ask_clarification' | 'propose_action' | 'execute_action';
}

interface PlannedStep {
  id: string;
  purpose: string;
  toolName?: string;
  input?: unknown;
  expectedObservation: string;
  riskHint: RiskLevel;
}
```

Planner 的原则：

- 先读后写。
- 先证据后结论。
- 不确定就追问。
- 写操作必须经过 PolicyEngine。
- 多目标请求可以拆成多个步骤。

### ToolRegistry

每个工具必须是完整定义，不只是名字。

```ts
interface AgentToolDefinition<Input, Output> {
  name: string;
  description: string;
  sideEffect: 'read' | 'write';
  inputSchema: Schema<Input>;
  outputSchema: Schema<Output>;
  requiredPermissions: PermissionRequirement[];
  riskPolicy: ToolRiskPolicy;
  execute(input: Input, ctx: ToolExecutionContext): Promise<ToolResult<Output>>;
  formatAudit(result: ToolResult<Output>): AgentAuditEntry;
}
```

第一批工具：

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

工具返回值统一为：

```ts
interface ToolResult<T> {
  status: 'ok' | 'not_found' | 'denied' | 'needs_confirmation' | 'failed';
  data?: T;
  observations: string[];
  evidenceIds: string[];
  error?: string;
}
```

### PolicyEngine

`PolicyEngine` 是权限和风险判断的唯一入口。任何工具执行前都必须经过它。

输入：

- agent identity
- owner identity
- room/file/task/calendar target
- requested action
- tool risk policy
- current context

输出：

```ts
interface PolicyDecision {
  outcome: 'allow' | 'deny' | 'require_confirmation';
  risk: RiskAssessment;
  reasons: string[];
  requiredReviewerIds?: string[];
}
```

策略原则：

- 读权限和写权限分离。
- Agent 只能代表 owner，不能代表整个群。
- 低风险读操作可直接执行。
- 低风险、已授权、可回滚的写操作可以自动执行。
- 跨房间、跨用户、多方日程、任务状态变更、私有文件、外部发送默认需要确认或阻断。
- 被拒绝的动作也要写入 trace，但不一定写入用户可见消息。

### ToolExecutor

`ToolExecutor` 负责：

- 校验工具输入。
- 请求 PolicyEngine。
- 执行工具。
- 捕获错误。
- 记录 observation。
- 生成审计事件。

它不负责最终用户回复。回复交给 `ResponseComposer`。

### Observation Loop

v2 Agent 运行时支持有限步数循环，建议第一版最大 4 步。

循环终止条件：

- 已得到足够答案。
- 需要用户补充信息。
- 需要人工确认。
- 动作被阻断。
- 达到最大步数。
- 工具失败且无可替代路径。

这能避免 Agent 无限循环，同时显著提升复杂请求处理能力。

### MemoryEngine

记忆应结构化存储。

```ts
interface MemoryRecord {
  id: string;
  ownerAgentId: string;
  scope: MemoryScope;
  kind: 'fact' | 'preference' | 'summary' | 'decision' | 'instruction' | 'open_question' | 'tool_result';
  content: string;
  sourceIds: string[];
  confidence: number;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

写记忆规则：

- 不把每次闲聊都写成长记忆。
- 没有来源的具体事实不能写成高置信度 fact。
- 用户明确表达的偏好可以写 preference。
- 已完成工具结果可以写 tool_result。
- 被用户纠正的信息要覆盖或降权旧记忆。

### ResponseComposer

`ResponseComposer` 负责把 plan、observation、policy decision 和 tool result 组织成自然回复。

回复原则：

- 先回答用户要什么。
- 明确自己代表谁。
- 明确引用了哪些授权上下文。
- 对不确定内容说不确定。
- 对写操作说明状态：已执行、待确认、已阻断。
- 不展示内部 chain-of-thought，只展示可审计依据。

### Trace

每次运行都生成 AgentTrace。

```ts
interface AgentTrace {
  runId: string;
  agentId: string;
  roomId: string;
  goal: string;
  selectedEvidenceIds: string[];
  steps: AgentTraceStep[];
  finalStatus: string;
  userVisibleSummary: string;
  createdAt: string;
}
```

Trace 用途：

- 用户侧解释。
- 开发调试。
- 评测回放。
- 审计合规。
- 失败案例复盘。

## 关键用户流程

### 普通问答

用户问：“现在谁负责访谈材料？”

流程：

1. AgentSession 创建目标。
2. ContextEngine 查当前群消息、任务、文件和相关记忆。
3. Planner 决定只读回答。
4. PolicyEngine 允许只读上下文查询。
5. ToolExecutor 执行消息、任务、文件查询。
6. ResponseComposer 回答负责人、证据和不确定项。
7. MemoryEngine 只在有价值时写入摘要，不写无意义闲聊。

### 文件代发

用户说：“把最新截图发给陈晨。”

流程：

1. ContextEngine 找文件候选和目标用户。
2. Planner 拆成搜索文件、判断授权、发送文件。
3. PolicyEngine 判断文件是否 room 可见、是否 owner 授权 Agent 分享、是否有真实媒体 backing。
4. 低风险则执行 `file.share`。
5. 中高风险则进入确认队列。
6. ResponseComposer 明确说明已发送或等待确认。

### 日程协调

用户说：“和陈晨确认今晚 21:20 能不能合稿。”

流程：

1. ContextEngine 查参与者、日程、任务。
2. Planner 生成 A2A 协商计划。
3. A2A 工具向目标 Agent 发起提案。
4. 目标 Agent 返回可用性和约束。
5. PolicyEngine 判断是否只是建议，还是要修改多人日程。
6. 修改日程默认需要确认。
7. ResponseComposer 说明协商结果和待确认 patch。

### 私有文件请求

用户说：“把林雯个人答辩备注也发我。”

流程：

1. ContextEngine 找到文件元数据。
2. PolicyEngine 判断 owner-only 且 `agentCanShare=false`。
3. ToolExecutor 不发送。
4. Trace 记录阻断原因。
5. ResponseComposer 明确拒绝，并说明需要本人确认。

## A2A 设计

A2A 不应只是日志展示，而应成为一种受控协议。

第一版 A2A 消息类型：

- `proposal`：提出目标和约束。
- `capability_check`：询问对方 Agent 是否有权限或上下文。
- `availability_response`：返回可用性。
- `resource_response`：返回文件或信息是否可分享。
- `counter_proposal`：提出替代方案。
- `final_summary`：总结协商结果。

A2A 规则：

- Agent 只代表自己的 owner。
- Agent 不能声明 owner 已同意高风险事项，除非有明确授权。
- A2A 可以形成建议，但多人任务或日程变更仍要进入确认。
- A2A 每轮都要写 trace。

## 评测体系

v2 评测分四类。

### 1. 任务完成评测

检查 Agent 是否完成用户目标，而不是只检查 intent。

例：

- 用户问负责人，回答必须包含正确负责人和证据。
- 用户找文件，必须返回正确文件版本。
- 用户要求发送低风险文件，必须真的生成消息。

### 2. 安全评测

检查越权、泄露、误代发。

例：

- owner-only 文件不能发送。
- 未授权房间不能读取。
- 多人日程不能自动改。
- 私聊内容不能被当前 Agent 泄露。

### 3. 交互质量评测

检查是否自然、简洁、有帮助。

例：

- 信息不足时是否追问。
- 不确定时是否说明。
- 是否避免空泛回答。
- 是否给出下一步。

### 4. 回归评测

每次修改 Agent Core 后运行固定场景：

- 文件查找。
- 文件代发。
- 日程协商。
- 任务更新建议。
- 私有信息阻断。
- A2A 协商。
- Web search。
- 普通闲聊。

## 迁移计划

### 阶段 0：文本和评测修复

目标：先把地基修干净。

任务：

- 修复中文 prompt、fallback、测试用例和文档中的编码损坏。
- 给核心 Agent 文本建立 UTF-8 检查。
- 增加质量型 eval case。
- 保留旧 eval，但标记为 legacy intent eval。

验收：

- 用户可见中文不再乱码。
- Agent prompt 文件可读。
- 新增至少 20 个任务级质量评测。

### 阶段 1：ToolRegistry 和 PolicyEngine

目标：先把工具和权限从业务分支中抽出来。

任务：

- 新建 ToolRegistry。
- 为现有工具补 schema 和 executor。
- 新建 PolicyEngine。
- 将 `file.share` 和 `message.send` 迁入新工具协议。
- 确认队列继续复用现有数据结构。

验收：

- 文件代发和消息代发不再在 handler 中直接判断权限。
- 工具执行都有统一 ToolResult。
- 审计日志来自工具结果和 policy decision。

### 阶段 2：AgentSession 和有限循环

目标：替换单次 intent 分支执行。

任务：

- 新建 AgentSession。
- 新建 Planner 输出多步计划。
- 新建 ToolExecutor。
- 支持最多 4 步 plan-act-observe。
- `/api/agent/run` 内部切到 v2 runtime，保留 response 兼容层。

验收：

- 复杂请求能拆成多个步骤。
- 低风险自动执行。
- 高风险进入确认。
- 每次运行都有 trace。

### 阶段 3：ContextEngine 和 MemoryEngine

目标：提升回答准确性和长期可用性。

任务：

- 把上下文选择从 prompt 拼接中抽出来。
- 引入 evidence ids 和 why selected。
- 新建结构化 MemoryRecord。
- 将旧 MemoryItem 做兼容读取。
- 增加文件正文、任务、日程、A2A 的统一检索接口。

验收：

- 每个回答都能追踪证据。
- 记忆有类型、置信度和来源。
- Agent 不再把低质量闲聊全部写入长期记忆。

### 阶段 4：A2A 协议化

目标：让多 Agent 协商成为真实能力。

任务：

- 定义 A2A message schema。
- 将 A2A 会话接入 AgentSession。
- 支持 capability check、availability response、counter proposal。
- 对 A2A 结果生成待确认 action patch。

验收：

- 两个 Agent 可以基于各自权限交换约束。
- A2A 不会绕过 PolicyEngine。
- A2A 面板能展示协商轮次、证据和最终建议。

## 文件落点建议

新增：

- `src/server/agentCore/session.ts`
- `src/server/agentCore/contextEngine.ts`
- `src/server/agentCore/planner.ts`
- `src/server/agentCore/toolRegistry.ts`
- `src/server/agentCore/toolExecutor.ts`
- `src/server/agentCore/policyEngine.ts`
- `src/server/agentCore/memoryEngine.ts`
- `src/server/agentCore/responseComposer.ts`
- `src/server/agentCore/trace.ts`
- `src/server/agentCore/eval.ts`

逐步降级或迁移：

- `src/server/agentRunRuntime.ts`
- `src/domain/agentEngine.ts`
- `src/domain/memory.ts`
- `src/server/agentTools.ts`
- `src/server/agentEval.ts`

保留兼容：

- `src/server/appServer.ts` 的 `/api/agent/run` 路由。
- `src/client/apiClient.ts` 的调用接口。
- 现有确认队列 API。
- 现有 Matrix client。

## 验收标准

产品体验验收：

- 用户可以用自然语言提出混合目标。
- Agent 能把混合目标拆成多个可解释步骤。
- Agent 会主动追问缺失条件。
- Agent 不再频繁给出空泛 fallback。
- Agent 的回答能说明依据。

安全验收：

- 未授权房间不可读。
- owner-only 文件不可发。
- 多人日程和任务状态变更默认需要确认。
- A2A 不能绕过权限。
- 每次写操作都有 audit 和 trace。

工程验收：

- 新工具必须注册 schema、policy 和 executor。
- 新 Agent 能力不需要在一个大函数里新增大分支。
- `agentRunRuntime.ts` 逐步变成兼容层，而不是核心逻辑层。
- 每个核心模块有独立单元测试。

评测验收：

- 至少 60 个任务级 eval case。
- 安全类 eval 通过率必须 100%。
- 关键用户流程 eval 通过率不低于 90%。
- 每个失败 case 能输出 trace 供复盘。

## 风险与取舍

最大风险是重构范围过大。解决方式是保留 API 和 UI，只替换内部 runtime，并按工具能力逐步迁移。

第二个风险是 Planner 不稳定。解决方式是限制最大步数、使用 schema 输出、对写操作强制 PolicyEngine、对低置信度计划要求追问。

第三个风险是过度工程化。解决方式是第一版只做 4 步循环、第一批只迁移核心工具，不引入外部工作流引擎。

第四个风险是旧测试与新架构冲突。解决方式是保留 legacy intent eval，同时新增任务级 eval；旧测试用于防回归，新测试用于衡量智能体验。

## 推荐下一步

下一步不是直接大规模改代码，而是写 `Agent Core v2` 实施计划。实施计划应从“文本修复与 eval 重建”开始，再迁移 ToolRegistry 和 PolicyEngine，最后替换 runtime。

推荐第一批实现顺序：

1. 修复乱码和 prompt 文本资产。
2. 新增任务级 eval。
3. 抽出 ToolRegistry。
4. 抽出 PolicyEngine。
5. 迁移 `file.share`。
6. 迁移 `message.send`。
7. 引入 AgentSession v2 兼容层。
8. 迁移 `chat`、`find_file`、`coordinate`。

这个顺序能最快改善真实体验，同时把风险控制在可回滚范围内。
