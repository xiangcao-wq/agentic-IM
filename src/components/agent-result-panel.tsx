import { useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  FileText,
  ListChecks,
  LockKeyhole,
  MessageSquare,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Users
} from 'lucide-react';
import type { AutopilotWorkerRunResponse } from '../client/apiClient';
import {
  isChatResult,
  isCoordinationResult,
  isDeadlineAnswer,
  isFileShareAction,
  isRoomSummary,
  isSendMessageAction,
  isWebSearchAnswer
} from '../domain/agentResultGuards';
import type {
  AgentActionRequest,
  AgentGoalPlan,
  AgentGoalPlanStep,
  AgentRunResult,
  CoordinationResult,
  DeadlineAnswer,
  FileItem,
  FileShareAction,
  Message,
  RoomSummary
} from '../domain/types';

export type AgentResult =
  | { kind: 'summary'; value: RoomSummary }
  | { kind: 'deadline'; value: DeadlineAnswer }
  | { kind: 'file-share'; value: FileShareAction }
  | { kind: 'coordination'; value: CoordinationResult }
  | { kind: 'agent-run'; value: AgentRunResult }
  | { kind: 'autopilot-run'; value: AutopilotWorkerRunResponse }
  | { kind: 'human-reply'; value: Message };

export function ResultPanel({
  result,
  sourceMessages,
  sourceFiles,
  onContinueGoalPlan
}: {
  result: AgentResult;
  sourceMessages: Message[];
  sourceFiles: FileItem[];
  onContinueGoalPlan?: (goalPlanId: string) => void;
}) {
  if (result.kind === 'agent-run') {
    return (
      <AgentRunResultPanel
        result={result.value}
        sourceMessages={sourceMessages}
        sourceFiles={sourceFiles}
        onContinueGoalPlan={onContinueGoalPlan}
      />
    );
  }

  if (result.kind === 'autopilot-run') {
    return <AutopilotRunResultPanel result={result.value} />;
  }

  if (result.kind === 'human-reply') {
    return (
      <section className="result-panel">
        <div className="result-heading">
          <Sparkles size={18} />
          <h3>AI 角色已发言</h3>
        </div>
        <p>{result.value.senderName}：{result.value.body}</p>
      </section>
    );
  }

  if (result.kind === 'summary') {
    return (
      <section className="result-panel">
        <div className="result-heading">
          <CheckCircle2 size={18} />
          <h3>群聊总结</h3>
        </div>
        <p>{result.value.headline}</p>
        <ul>
          {result.value.todos.map((todo) => (
            <li key={todo}>{todo}</li>
          ))}
        </ul>
      </section>
    );
  }

  if (result.kind === 'deadline') {
    return (
      <section className="result-panel">
        <div className="result-heading">
          <Search size={18} />
          <h3>检索回答</h3>
        </div>
        <FormattedAnswer text={result.value.answer} />
        <EvidenceDisclosure citations={result.value.citations} sourceMessages={sourceMessages} sourceFiles={sourceFiles} />
      </section>
    );
  }

  if (result.kind === 'file-share') {
    return (
      <section className="result-panel">
        <div className="result-heading">
          <FileText size={18} />
          <h3>文件代发</h3>
        </div>
        <p>{result.value.file?.name}</p>
        <RiskLine riskLevel={result.value.risk.level} reason={result.value.risk.reason} />
      </section>
    );
  }

  return (
    <section className="result-panel">
      <div className="result-heading">
        <Users size={18} />
        <h3>Agent 协调</h3>
      </div>
      <p>{result.value.proposedPlan}</p>
      <RiskLine riskLevel={result.value.risk.level} reason={result.value.risk.reason} />
    </section>
  );
}

export function getAgentResultKey(result: AgentResult): string {
  if (result.kind === 'agent-run') {
    return `${result.kind}:${result.value.log.id}`;
  }
  if (result.kind === 'autopilot-run') {
    return `${result.kind}:${result.value.worker.runCount}:${result.value.worker.lastFinishedAt ?? ''}`;
  }
  if (result.kind === 'human-reply') {
    return `${result.kind}:${result.value.id}`;
  }
  return `${result.kind}:${JSON.stringify(result.value).slice(0, 80)}`;
}

function AutopilotRunResultPanel({ result }: { result: AutopilotWorkerRunResponse }) {
  const processedMessages = result.processedMessageIds.length;
  const processedTasks = result.processedTaskIds?.length ?? 0;
  const actionRequests = result.actionRequests ?? [];
  const didWork = processedMessages + processedTasks + result.sessions.length + result.messages.length + actionRequests.length > 0;
  return (
    <section className="result-panel">
      <div className="result-heading">
        <ShieldCheck size={18} />
        <h3>托管巡检结果</h3>
      </div>
      <FinalAnswer>
        {didWork ? (
          <ul>
            <li>处理消息 {processedMessages} 条，处理任务 {processedTasks} 条。</li>
            <li>生成 Agent 协作 {result.sessions.length} 条，代发消息 {result.messages.length} 条。</li>
            <li>新增待确认动作 {actionRequests.length} 条。</li>
          </ul>
        ) : (
          <p>{result.skippedReason === 'disabled' ? '托管 worker 未启用。' : '本次没有新的待处理消息或临期任务。'}</p>
        )}
      </FinalAnswer>
      {actionRequests.length > 0 ? (
        <div className="agent-thought">
          <strong>等待确认</strong>
          <p>
            {actionRequests
              .slice(0, 3)
              .map((action) => `${agentActionKindLabel(action.kind)}：${String(action.input.requestText ?? action.input.messageBody ?? action.id)}`)
              .join('；')}
          </p>
        </div>
      ) : null}
      <RiskLine riskLevel="low" reason={`后台巡检已完成，worker 已运行 ${result.worker.runCount} 次。`} />
    </section>
  );
}

function AgentRunResultPanel({
  result,
  sourceMessages,
  sourceFiles,
  onContinueGoalPlan
}: {
  result: AgentRunResult;
  sourceMessages: Message[];
  sourceFiles: FileItem[];
  onContinueGoalPlan?: (goalPlanId: string) => void;
}) {
  const title = agentIntentTitle(result.intent);
  const structured = result.result;
  const withGoalPlan = (panel: ReactNode) => (
    <>
      {panel}
      {result.goalPlan ? (
        <AgentGoalPlanCard plan={result.goalPlan} onContinue={onContinueGoalPlan} />
      ) : null}
    </>
  );

  if (result.files) {
    return withGoalPlan(
      <section className="result-panel">
        <div className="result-heading">
          <Search size={18} />
          <h3>{title}</h3>
        </div>
        <FinalAnswer>
          <ul>
            {result.files.length > 0 ? (
              result.files.map((file) => (
                <li key={file.id}>{file.name} · {file.agentCanShare ? 'Agent 可代发' : '需要本人确认'}</li>
              ))
            ) : (
              <li>没有找到符合授权边界的文件。</li>
            )}
          </ul>
        </FinalAnswer>
        <RiskLine riskLevel={result.log.risk.level} reason={result.log.risk.reason} />
      </section>
    );
  }

  if (isRoomSummary(structured)) {
    return withGoalPlan(
      <section className="result-panel">
        <div className="result-heading">
          <CheckCircle2 size={18} />
          <h3>{title}</h3>
        </div>
        <FinalAnswer>
          <p>{structured.headline}</p>
          <ul>
            {structured.todos.map((todo) => (
              <li key={todo}>{todo}</li>
            ))}
          </ul>
        </FinalAnswer>
        <RiskLine riskLevel={result.log.risk.level} reason={result.log.risk.reason} />
      </section>
    );
  }

  if (isDeadlineAnswer(structured)) {
    return withGoalPlan(
      <section className="result-panel">
        <div className="result-heading">
          <Search size={18} />
          <h3>{title}</h3>
        </div>
        <FinalAnswer>
          <FormattedAnswer text={structured.answer} />
        </FinalAnswer>
        <EvidenceDisclosure citations={structured.citations} sourceMessages={sourceMessages} sourceFiles={sourceFiles} />
        <RiskLine riskLevel={result.log.risk.level} reason={result.log.risk.reason} />
      </section>
    );
  }

  if (isWebSearchAnswer(structured)) {
    return withGoalPlan(
      <section className="result-panel">
        <div className="result-heading">
          <Search size={18} />
          <h3>{title}</h3>
        </div>
        <FinalAnswer>
          <FormattedAnswer text={structured.answer} />
          {structured.results.length > 0 ? (
            <ul className="web-result-list">
              {structured.results.map((item) => (
                <li key={item.url}>
                  <a href={item.url} target="_blank" rel="noreferrer">
                    <span>{item.title}</span>
                    <ExternalLink size={14} />
                  </a>
                  <small>{item.snippet}</small>
                </li>
              ))}
            </ul>
          ) : null}
        </FinalAnswer>
        <RiskLine riskLevel={result.log.risk.level} reason={result.log.risk.reason} />
      </section>
    );
  }

  if (isFileShareAction(structured)) {
    return withGoalPlan(
      <section className="result-panel">
        <div className="result-heading">
          <FileText size={18} />
          <h3>{title}</h3>
        </div>
        <FinalAnswer>
          <p>{structured.file?.name ?? '没有可自动代发的授权文件'}</p>
        </FinalAnswer>
        <RiskLine riskLevel={structured.risk.level} reason={structured.risk.reason} />
      </section>
    );
  }

  if (isSendMessageAction(structured)) {
    return withGoalPlan(
      <section className="result-panel">
        <div className="result-heading">
          <Send size={18} />
          <h3>{title}</h3>
        </div>
        <FinalAnswer>
          <FormattedAnswer text={structured.status === 'executed' ? `已代发：${structured.messageBody}` : `未自动发送：${structured.messageBody}`} />
        </FinalAnswer>
        <RiskLine riskLevel={structured.risk.level} reason={structured.risk.reason} />
      </section>
    );
  }

  if (isCoordinationResult(structured)) {
    return withGoalPlan(
      <section className="result-panel">
        <div className="result-heading">
          <Users size={18} />
          <h3>{title}</h3>
        </div>
        <FinalAnswer>
          <FormattedAnswer text={structured.proposedPlan} />
        </FinalAnswer>
        <RiskLine riskLevel={structured.risk.level} reason={structured.risk.reason} />
      </section>
    );
  }

  if (isChatResult(structured)) {
    return withGoalPlan(
      <section className="result-panel">
        <div className="result-heading">
          <MessageSquare size={18} />
          <h3>{title}</h3>
        </div>
        <FinalAnswer>
          <FormattedAnswer text={structured.reply} />
        </FinalAnswer>
        <RiskLine riskLevel={result.log.risk.level} reason={result.log.risk.reason} />
      </section>
    );
  }

  return withGoalPlan(
    <section className="result-panel">
      <div className="result-heading">
        <Bot size={18} />
        <h3>{title}</h3>
      </div>
      <FinalAnswer>
        <p>{result.requiresHuman ? '需要人工确认。' : 'Agent 已完成工具调用。'}</p>
      </FinalAnswer>
      <RiskLine riskLevel={result.log.risk.level} reason={result.log.risk.reason} />
    </section>
  );
}

function AgentGoalPlanCard({
  plan,
  onContinue
}: {
  plan: AgentGoalPlan;
  onContinue?: (goalPlanId: string) => void;
}) {
  const totalSteps = plan.steps.length;
  const completedSteps = plan.steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length;
  const pendingConfirmationCount = plan.steps.filter(
    (step) => step.requiresHuman || step.status === 'needs_confirmation'
  ).length + plan.actionRequestIds.length;
  const progress = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
  const visibleSteps = plan.steps.slice(0, 5);
  const hiddenStepCount = Math.max(0, plan.steps.length - visibleSteps.length);
  const canContinue = plan.status !== 'completed' && plan.status !== 'blocked' && Boolean(onContinue);

  return (
    <section className={`goal-plan-card status-${plan.status}`} data-testid="agent-goal-plan-card">
      <div className="goal-plan-hero">
        <div className="goal-plan-icon">
          <ListChecks size={18} />
        </div>
        <div className="goal-plan-title">
          <span>{goalPlanStatusLabel(plan.status)}</span>
          <h3>{scrubTechnicalToolNames(plan.summary) || '已整理当前目标和下一步。'}</h3>
        </div>
        <div className="goal-plan-score" aria-label="goal plan progress">
          <strong>{completedSteps}/{totalSteps}</strong>
          <small>完成</small>
        </div>
      </div>

      <div className="goal-plan-progress" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>

      <div className="goal-plan-metrics" aria-label="goal plan summary">
        <span>
          <CheckCircle2 size={14} />
          {completedSteps} 项已完成
        </span>
        <span className={pendingConfirmationCount > 0 ? 'needs-attention' : ''}>
          <LockKeyhole size={14} />
          {pendingConfirmationCount > 0 ? `${pendingConfirmationCount} 项待确认` : '暂无待确认'}
        </span>
        <span>
          <ShieldCheck size={14} />
          {plan.contextIds.length} 条依据
        </span>
      </div>

      <ol className="goal-plan-steps" aria-label="goal plan steps">
        {visibleSteps.map((step) => (
          <GoalPlanStepRow key={step.id} step={step} />
        ))}
      </ol>

      {hiddenStepCount > 0 ? (
        <p className="goal-plan-hidden-count">还有 {hiddenStepCount} 个低优先级步骤已收起。</p>
      ) : null}

      <div className="goal-plan-footer">
        <span>运行细节已保留在右侧审计区，这里只展示用户需要判断的信息。</span>
        {canContinue ? (
          <button type="button" aria-label="continue goal plan" onClick={() => onContinue?.(plan.id)}>
            继续处理
            <ArrowRight size={15} />
          </button>
        ) : null}
      </div>
    </section>
  );
}

function GoalPlanStepRow({ step }: { step: AgentGoalPlanStep }) {
  const summary = scrubTechnicalToolNames(step.outputSummary ?? '');
  return (
    <li className={`goal-plan-step status-${step.status}`}>
      <span className="goal-plan-step-icon">{goalPlanStepIcon(step)}</span>
      <div>
        <strong>{scrubTechnicalToolNames(step.title) || goalPlanStepFallbackTitle(step)}</strong>
        <p>{summary || goalPlanStepFallbackSummary(step)}</p>
      </div>
      <em>{goalPlanStepStatusLabel(step.status)}</em>
    </li>
  );
}

function goalPlanStepIcon(step: AgentGoalPlanStep): ReactNode {
  if (step.status === 'completed' || step.status === 'skipped') {
    return <CheckCircle2 size={15} />;
  }
  if (step.status === 'needs_confirmation' || step.requiresHuman) {
    return <LockKeyhole size={15} />;
  }
  if (step.status === 'blocked') {
    return <AlertTriangle size={15} />;
  }
  return <CircleDashed size={15} />;
}

function goalPlanStatusLabel(status: AgentGoalPlan['status']): string {
  const labels: Record<AgentGoalPlan['status'], string> = {
    active: '进行中的计划',
    completed: '已完成的计划',
    needs_confirmation: '需要确认',
    blocked: '已阻止'
  };
  return labels[status];
}

function goalPlanStepStatusLabel(status: AgentGoalPlanStep['status']): string {
  const labels: Record<AgentGoalPlanStep['status'], string> = {
    pending: '待处理',
    running: '处理中',
    completed: '完成',
    needs_confirmation: '待确认',
    blocked: '已阻止',
    skipped: '已跳过'
  };
  return labels[status];
}

function goalPlanStepFallbackTitle(step: AgentGoalPlanStep): string {
  if (step.requiresHuman || step.status === 'needs_confirmation') {
    return '等待确认';
  }
  if (step.sideEffect === 'write') {
    return '准备执行动作';
  }
  return '整理上下文';
}

function goalPlanStepFallbackSummary(step: AgentGoalPlanStep): string {
  if (step.status === 'completed') {
    return '这一步已经完成。';
  }
  if (step.status === 'needs_confirmation' || step.requiresHuman) {
    return '需要你确认后再继续。';
  }
  if (step.status === 'blocked') {
    return '当前步骤被风险规则拦截。';
  }
  if (step.status === 'skipped') {
    return '这一步暂时不需要执行。';
  }
  return '等待继续处理。';
}

function scrubTechnicalToolNames(value: string): string {
  return value
    .replace(/\b(?:chat\.answer|room\.summarize|deadline\.answer|file\.search|file\.share|message\.send|web\.search|agent\.coordinate|task\.suggest_update)\b/g, '')
    .replace(/\b(?:deepseek|fallback)\.[a-z0-9_.-]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}

function EvidenceDisclosure(props: { citations: string[]; sourceMessages: Message[]; sourceFiles: FileItem[] }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeEvidence(props.citations, props.sourceMessages, props.sourceFiles);
  if (!summary) {
    return null;
  }
  return (
    <div className={`source-summary ${open ? 'is-open' : ''}`}>
      <button className="source-summary-button" type="button" onClick={() => setOpen((value) => !value)}>
        <ShieldCheck size={15} />
        <span>{summary}</span>
        <small>{open ? '收起' : '查看依据'}</small>
      </button>
      {open ? (
        <div className="citation-row">
          {props.citations.map((citation) => (
            <span key={citation}>{formatCitation(citation, props.sourceMessages, props.sourceFiles)}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PlanLine({ plan }: { plan?: string; reasoning?: string }) {
  const thought = compactPlanLine(plan);
  return thought ? (
    <div className="agent-thought">
      <strong>处理方式</strong>
      <p>{thought}</p>
    </div>
  ) : null;
}

function FinalAnswer({ children }: { children: ReactNode }) {
  return (
    <div className="agent-final">
      <strong>回答</strong>
      <div>{children}</div>
    </div>
  );
}

function FormattedAnswer({ text }: { text: string }) {
  const lines = normalizeAgentAnswerText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const nodes: ReactNode[] = [];
  let bullets: string[] = [];

  const flushBullets = () => {
    if (bullets.length === 0) {
      return;
    }
    const items = bullets;
    bullets = [];
    nodes.push(
      <ul key={`list-${nodes.length}`}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  };

  lines.forEach((line) => {
    const bullet = line.match(/^[-•]\s+(.+)$/u);
    if (bullet) {
      bullets.push(bullet[1].trim());
      return;
    }
    flushBullets();
    nodes.push(<p key={`p-${nodes.length}`}>{line}</p>);
  });
  flushBullets();

  return nodes.length > 0 ? <>{nodes}</> : null;
}

function normalizeAgentAnswerText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+[-•]\s+/g, '\n- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function RiskLine(props: { riskLevel: string; reason: string }) {
  if (props.riskLevel === 'low') {
    return null;
  }
  return (
    <div className={`risk-line ${props.riskLevel}`}>
      {props.riskLevel === 'high' ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
      <span>{props.riskLevel} · {props.reason}</span>
    </div>
  );
}

function agentIntentTitle(intent: AgentRunResult['intent']) {
  const titles: Record<AgentRunResult['intent'], string> = {
    summary: 'Agent 总结',
    deadline: 'Agent 问答',
    find_file: 'Agent 找文件',
    share_file: 'Agent 代发文件',
    send_message: 'Agent 代发消息',
    coordinate: 'Agent 协调',
    task_update_suggest: '任务更新建议',
    web_search: 'Agent 搜索',
    chat: 'Agent 对话'
  };
  return titles[intent];
}

function agentActionKindLabel(kind: AgentActionRequest['kind']) {
  const labels: Record<AgentActionRequest['kind'], string> = {
    summary: '总结群聊',
    deadline: '问截止',
    find_file: '查找文件',
    share_file: '文件代发',
    send_message: '代发消息',
    coordinate: 'Agent 协调',
    task_update: '任务更新',
    calendar_update: '日程更新',
    task_update_suggest: '任务更新建议'
  };
  return labels[kind];
}

function compactPlanLine(value?: string): string {
  const cleaned = value
    ?.replace(/\s+/g, ' ')
    .replace(/^(思考过程|思路|reasoning|plan)\s*[:：-]\s*/i, '')
    .trim();
  if (!cleaned) {
    return '';
  }

  const withoutListMarkers = cleaned.replace(/第\s*\d+\s*条\s*[:：]\s*/g, '');
  const firstSentence = withoutListMarkers.match(/^.{1,140}?[。！？.!?](?=\s|$)/u)?.[0] ?? withoutListMarkers;
  return firstSentence.length > 140 ? `${firstSentence.slice(0, 137)}...` : firstSentence;
}

function summarizeEvidence(citations: string[], messages: Message[], files: FileItem[]): string {
  if (citations.length === 0) {
    return '';
  }
  const messageIds = new Set(messages.map((message) => message.id));
  const fileIds = new Set(files.map((file) => file.id));
  const messageCount = citations.filter((citation) => messageIds.has(citation)).length;
  const fileCount = citations.filter((citation) => fileIds.has(citation)).length;
  const otherCount = citations.length - messageCount - fileCount;
  const parts = [
    messageCount > 0 ? `消息 ${messageCount} 条` : '',
    fileCount > 0 ? `文件 ${fileCount} 个` : '',
    otherCount > 0 ? `上下文 ${otherCount} 条` : ''
  ].filter(Boolean);
  return parts.length > 0 ? `依据：${parts.join(' · ')}` : '';
}

function formatCitation(citation: string, messages: Message[], files: FileItem[]) {
  const message = messages.find((candidate) => candidate.id === citation);
  if (message) {
    return `${message.senderName} ${formatTime(message.sentAt)} 的消息`;
  }

  const file = files.find((candidate) => candidate.id === citation);
  if (file) {
    return file.name;
  }

  if (citation.startsWith('$')) {
    return `Matrix 事件 ${citation.slice(1, 7)}`;
  }

  return formatContextCitation(citation);
}

function formatContextCitation(citation: string): string {
  if (citation === 'task-report') {
    return '任务：调研报告';
  }
  if (citation === 'task-slides') {
    return '任务：演示稿';
  }
  if (citation.startsWith('task-')) {
    return '任务线索';
  }
  if (citation.startsWith('mem-')) {
    return 'Agent 记忆';
  }
  if (citation.startsWith('calendar-') || citation.startsWith('schedule-')) {
    return '日程线索';
  }
  if (citation.startsWith('room-') || citation.startsWith('msg-')) {
    return '聊天上下文';
  }
  return '上下文线索';
}

function formatTime(value: string) {
  if (!value) {
    return '';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}
