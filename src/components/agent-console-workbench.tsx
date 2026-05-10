import { useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Clock3,
  FileText,
  MessageSquare,
  PanelRightOpen,
  Search,
  Send,
  Users
} from 'lucide-react';
import type { AutopilotWorkerStatus } from '../client/apiClient';
import {
  buildAgentTimelineItems,
  buildPermissionCenterItems
} from '../client/agentTimeline';
import type {
  AgentActionLog,
  AgentActionRequest,
  AgentProgressEvent,
  AgentTrace,
  AiRuntimeStatus,
  DemoState,
  FileItem,
  Message
} from '../domain/types';
import { AgentInspectorPanel } from './agent-inspector-panel';
import { AgentShortcutPopover } from './agent-shortcut-popover';
import { ResultPanel, getAgentResultKey, type AgentResult } from './agent-result-panel';

type RoomFilter = 'all' | 'group' | 'direct';
type AgentTraceLoadStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

const workbenchAppear = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
} as const;

export function AgentWorkbench(props: {
  agent: DemoState['agents'][number];
  rooms: DemoState['rooms'];
  allRooms: DemoState['rooms'];
  roomSearch: string;
  roomFilter: RoomFilter;
  selectedRoom: DemoState['rooms'][number];
  prompt: string;
  error: string | null;
  busyAction: string | null;
  result: AgentResult | null;
  trace: AgentTrace | null;
  traceStatus: AgentTraceLoadStatus;
  progressEvents: AgentProgressEvent[];
  aiStatus?: AiRuntimeStatus;
  actions: AgentActionRequest[];
  logs: AgentActionLog[];
  a2aSessions: DemoState['a2aSessions'];
  autopilotPolicies: DemoState['agentAutopilotPolicies'];
  autopilotWorker: AutopilotWorkerStatus | null;
  selectedRoomId: string;
  sourceMessages: Message[];
  sourceFiles: FileItem[];
  onBackToChat: () => void;
  onFilterChange: (filter: RoomFilter) => void;
  onSearchChange: (value: string) => void;
  onSelectRoom: (roomId: string) => void;
  onPromptChange: (value: string) => void;
  onAgentChat: () => void;
  onContinueGoalPlan: (goalPlanId: string) => void;
  onSummarize: () => void;
  onDeadlineQuestion: () => void;
  onFindFile: () => void;
  onFileShare: () => void;
  onCoordinate: () => void;
  onConfirmAction: (actionId: string) => void;
  onRejectAction: (actionId: string) => void;
  onToggleAutopilot: () => void;
  onRunAutopilotWorker: () => void;
}) {
  const pendingActions = props.actions.filter(
    (action) =>
      action.agentId === props.agent.id &&
      action.roomId === props.selectedRoomId &&
      action.requiresHuman &&
      action.status === 'needs_confirmation'
  );
  const aiStatus = deriveAiStatus(props.result, props.aiStatus);
  const resultKey = props.result ? getAgentResultKey(props.result) : 'empty-agent-result';
  const timelineItems = useMemo(() => buildAgentTimelineItems(props.trace), [props.trace]);
  const permissionItems = useMemo(() => buildPermissionCenterItems(props.trace), [props.trace]);
  const roomLogs = props.logs.filter((log) => log.agentId === props.agent.id && log.roomId === props.selectedRoomId);
  const roomProgressEvents = props.progressEvents.filter(
    (event) => event.agentId === props.agent.id && event.roomId === props.selectedRoomId
  );
  const roomA2ASessions = props.a2aSessions
    .filter(
      (session) =>
        session.roomId === props.selectedRoomId &&
        (session.initiatorAgentId === props.agent.id || session.targetAgentIds.includes(props.agent.id))
    )
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 3);
  const autopilotPolicy = props.autopilotPolicies.find((policy) => policy.agentId === props.agent.id);
  const autopilotRoomEnabled = Boolean(autopilotPolicy?.enabled && autopilotPolicy.allowedRoomIds.includes(props.selectedRoomId));
  const countableRooms = filterRooms(props.allRooms, props.roomSearch, 'all');
  const groupCount = countableRooms.filter((room) => room.type !== 'direct').length;
  const directCount = countableRooms.filter((room) => room.type === 'direct').length;
  const roomFiles = props.sourceFiles.filter((file) => file.roomId === props.selectedRoomId).slice(0, 8);

  return (
    <main className="agent-console">
      <aside className="console-room-rail">
        <button className="console-back-button" type="button" onClick={props.onBackToChat}>
          <ArrowLeft size={16} />
          <span>返回聊天</span>
        </button>
        <div className="console-rail-heading">
          <strong>聊天室</strong>
          <span>选择 Agent 工作上下文</span>
        </div>
        <label className="room-search">
          <Search size={16} />
          <input
            aria-label="search rooms"
            placeholder="搜索群聊或私聊"
            value={props.roomSearch}
            onChange={(event) => props.onSearchChange(event.target.value)}
          />
        </label>
        <div className="room-tabs" aria-label="room filters">
          <button className={props.roomFilter === 'all' ? 'is-active' : ''} type="button" onClick={() => props.onFilterChange('all')}>全部</button>
          <button className={props.roomFilter === 'group' ? 'is-active' : ''} type="button" onClick={() => props.onFilterChange('group')}>群聊 {groupCount}</button>
          <button className={props.roomFilter === 'direct' ? 'is-active' : ''} type="button" onClick={() => props.onFilterChange('direct')}>私聊 {directCount}</button>
        </div>
        <nav className="room-list console-room-list" aria-label="agent console rooms">
          {props.rooms.map((room) => (
            <button
              className={`room-button ${room.id === props.selectedRoomId ? 'is-active' : ''}`}
              key={room.id}
              type="button"
              onClick={() => props.onSelectRoom(room.id)}
            >
              <span className="room-icon">
                {room.type === 'direct' ? <Bot size={16} /> : <MessageSquare size={16} />}
              </span>
              <span className="room-meta">
                <strong>{room.name}</strong>
                <small>{room.type === 'direct' ? '私聊' : '群聊'} · {room.matrixAlias}</small>
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <header className="agent-header agent-console-header">
        <div className="agent-orb">
          <Bot size={22} />
        </div>
        <div>
          <h2>{props.selectedRoom.name}</h2>
          <p>{props.agent.displayName} 正在处理当前聊天室</p>
        </div>
        <span className={`ai-status-pill ${aiStatus.kind}`}>{aiStatus.label}</span>
      </header>

      <div className="agent-output-area">
        {props.error ? (
          <motion.div className="error-banner" key="agent-error" {...workbenchAppear}>
            {props.error}
          </motion.div>
        ) : null}
        <AgentBusyPanel busyAction={props.busyAction} />
        <AnimatePresence mode="popLayout">
          {props.result ? (
            <motion.div className="agent-result-motion" key={resultKey} {...workbenchAppear}>
              <ResultPanel
                result={props.result}
                sourceMessages={props.sourceMessages}
                sourceFiles={props.sourceFiles}
                onContinueGoalPlan={props.onContinueGoalPlan}
              />
            </motion.div>
          ) : (
            <motion.div className="agent-output-placeholder" key="empty-agent-result" aria-hidden="true" />
          )}
        </AnimatePresence>

        {pendingActions.length > 0 ? (
          <section className="data-section confirmation-section">
            <div className="section-title">
              <AlertTriangle size={17} />
              <h3>待确认动作</h3>
            </div>
            <div className="confirmation-list">
              {pendingActions.map((action) => (
                <motion.div className="confirmation-row" key={action.id} layout {...workbenchAppear}>
                  <div>
                    <strong>{agentActionKindLabel(action.kind)}</strong>
                    <span>{formatActionRequestText(action)}</span>
                    <small>{action.risk?.level ?? 'pending'} · {action.risk?.reason ?? '等待风险评估'}</small>
                  </div>
                  <div className="confirmation-actions">
                    <button
                      type="button"
                      onClick={() => props.onConfirmAction(action.id)}
                      disabled={Boolean(props.busyAction)}
                    >
                      确认
                    </button>
                    <button
                      type="button"
                      onClick={() => props.onRejectAction(action.id)}
                      disabled={Boolean(props.busyAction)}
                    >
                      拒绝
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>
          </section>
        ) : null}

        {roomA2ASessions.length > 0 ? (
          <section className="data-section a2a-section" data-testid="a2a-session-panel">
            <div className="section-title">
              <MessageSquare size={17} />
              <h3>Agent 托管协作</h3>
            </div>
            <div className="compact-list">
              {roomA2ASessions.map((session) => {
                const latestTurn = session.turns.at(-1);
                const relatedPending = pendingActions.filter((action) =>
                  session.proposedActionRequestIds.includes(action.id)
                );
                return (
                  <motion.div className={`compact-row a2a-row status-${session.status}`} key={session.id} layout {...workbenchAppear}>
                    <strong>
                      <span>{a2aStatusLabel(session.status)}</span>
                      <em>{session.risk.level}</em>
                    </strong>
                    <span>{formatA2ASessionGoal(session.goal)}</span>
                    {latestTurn ? <small>{formatA2ATurnMessage(latestTurn.message)}</small> : null}
                    {relatedPending.length > 0 ? (
                      <small className="a2a-confirmation-hint">
                        等待确认：{relatedPending.map((action) => agentActionKindLabel(action.kind)).join('、')}
                      </small>
                    ) : null}
                  </motion.div>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>

      <div className="agent-dock">
        <div className="console-command-strip">
          <AgentShortcutPopover
            buttonClassName="console-plus-button"
            buttonLabel="打开 Agent 操作菜单"
            side="top"
            align="start"
            actions={[
              {
                id: 'summary',
                icon: <PanelRightOpen size={16} />,
                label: '总结群聊',
                description: '整理当前上下文和下一步',
                onSelect: props.onSummarize,
                disabled: props.busyAction === 'summary'
              },
              {
                id: 'deadline',
                icon: <Clock3 size={16} />,
                label: '问截止',
                description: '查询任务、日程和聊天里的时间约束',
                onSelect: props.onDeadlineQuestion,
                disabled: props.busyAction === 'deadline'
              },
              {
                id: 'find-file',
                icon: <Search size={16} />,
                label: 'Agent 找文件',
                description: '按模糊描述检索授权文件',
                onSelect: props.onFindFile,
                disabled: props.busyAction === 'find-file'
              },
              {
                id: 'share-file',
                icon: <FileText size={16} />,
                label: '请求代发',
                description: '高风险动作，进入人工确认',
                onSelect: props.onFileShare,
                disabled: props.busyAction === 'file-share',
                tone: 'risk'
              },
              {
                id: 'coordinate',
                icon: <Users size={16} />,
                label: 'Agent 协调',
                description: '发起 A2A 协商并记录过程',
                onSelect: props.onCoordinate,
                disabled: props.busyAction === 'coordination',
                tone: 'console'
              }
            ]}
          />
          <div className="console-command-strip-copy">
            <strong>Agent 操作</strong>
            <span>把低频动作收进菜单，主界面只保留任务和确认流。</span>
          </div>
        </div>

        {autopilotPolicy ? (
          <div className={`autopilot-policy ${autopilotRoomEnabled ? 'enabled' : 'disabled'}`}>
            <div>
              <span>{autopilotRoomEnabled ? '托管模式已开启' : '托管模式未开启'}</span>
              <small>
                {autopilotRoomEnabled
                  ? `当前房间可用 · ${autopilotPolicy.allowedActions.length} 项授权`
                  : '当前房间未授权'}
              </small>
            </div>
            {props.autopilotWorker ? (
              <small className="autopilot-worker-status">
                后台巡检：{autopilotWorkerLabel(props.autopilotWorker)} · 上次处理{' '}
                {props.autopilotWorker.lastProcessedCount} 条
              </small>
            ) : null}
            <button type="button" onClick={props.onToggleAutopilot} disabled={Boolean(props.busyAction)}>
              {autopilotRoomEnabled ? '关闭托管' : '开启托管'}
            </button>
            {autopilotRoomEnabled ? (
              <button
                className="autopilot-sweep-button"
                type="button"
                onClick={props.onRunAutopilotWorker}
                disabled={Boolean(props.busyAction)}
              >
                立即巡检
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="agent-query agent-console-command">
          <label htmlFor="agent-prompt">问 Agent 或下指令</label>
          <div className="query-row">
            <input
              id="agent-prompt"
              value={props.prompt}
              onChange={(event) => props.onPromptChange(event.target.value)}
            />
            <button type="button" onClick={props.onAgentChat} aria-label="send agent prompt" disabled={props.busyAction === 'chat'}>
              <Send size={17} />
            </button>
          </div>
        </div>
      </div>

      <AgentInspectorPanel
        agent={props.agent}
        busyAction={props.busyAction}
        files={roomFiles}
        logs={roomLogs}
        permissionItems={permissionItems}
        pendingCount={pendingActions.length}
        progressEvents={roomProgressEvents}
        rooms={props.allRooms}
        selectedRoom={props.selectedRoom}
        timelineItems={timelineItems}
        trace={props.trace}
        traceStatus={props.traceStatus}
      />
    </main>
  );
}

function AgentBusyPanel({ busyAction }: { busyAction: string | null }) {
  if (!busyAction) {
    return null;
  }
  return (
    <div className="agent-busy-panel">
      <span />
      <strong>{busyActionLabel(busyAction)}</strong>
    </div>
  );
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

function a2aStatusLabel(status: DemoState['a2aSessions'][number]['status']) {
  const labels: Record<DemoState['a2aSessions'][number]['status'], string> = {
    active: '协作中',
    completed: '已完成',
    needs_confirmation: '待确认',
    blocked: '已阻止'
  };
  return labels[status];
}

function deriveAiStatus(
  result: AgentResult | null,
  aiStatus?: AiRuntimeStatus
): { kind: 'connected' | 'fallback' | 'failed'; label: string } {
  if (aiStatus?.configured && aiStatus.health === 'connected') {
    const model = aiStatus.agentModel ?? aiStatus.humanModel ?? aiStatus.provider;
    return {
      kind: 'connected',
      label: `LLM connected · ${model}${formatAiCacheLabel(aiStatus)}`
    };
  }
  if (aiStatus?.configured && aiStatus.health === 'failed') {
    return { kind: 'failed', label: 'LLM failed · fallback rules active' };
  }
  if (aiStatus?.configured) {
    return { kind: 'fallback', label: 'LLM configured, not checked' };
  }
  if (result?.kind !== 'agent-run') {
    return { kind: 'fallback', label: 'LLM missing, fallback active' };
  }
  const toolCalls = result.value.log.toolCalls;
  if (toolCalls.includes('fallback.local_context') && toolCalls.some((tool) => tool.includes('deepseek'))) {
    return { kind: 'failed', label: 'LLM failed · fallback rules active' };
  }
  if (toolCalls.some((tool) => tool.includes('deepseek'))) {
    return { kind: 'connected', label: 'LLM connected' };
  }
  return { kind: 'fallback', label: 'LLM missing, fallback active' };
}

function formatAiCacheLabel(status: AiRuntimeStatus): string {
  const hitRate = status.cache?.promptCacheHitRate;
  if (typeof hitRate !== 'number') {
    return '';
  }
  return ` | cache ${Math.round(hitRate * 100)}%`;
}

function filterRooms(rooms: DemoState['rooms'], search: string, filter: RoomFilter): DemoState['rooms'] {
  const normalized = search.trim().toLowerCase();
  return rooms.filter((room) => {
    const matchesFilter =
      filter === 'all' ||
      (filter === 'group' && room.type !== 'direct') ||
      (filter === 'direct' && room.type === 'direct');
    const matchesSearch =
      !normalized ||
      room.name.toLowerCase().includes(normalized) ||
      room.matrixAlias.toLowerCase().includes(normalized);
    return matchesFilter && matchesSearch;
  });
}

function busyActionLabel(action: string): string {
  const labels: Record<string, string> = {
    summary: '正在总结当前对话',
    deadline: '正在检索截止时间',
    'find-file': '正在检索文件',
    'file-share': '正在评估文件代发',
    coordination: '正在生成协调建议',
    chat: '正在生成 Agent 回答',
    send: '正在发送消息',
    'upload-file': '正在上传并索引文件',
    'autopilot-policy': '正在更新托管授权',
    'autopilot-worker': '正在巡检待处理消息和任务',
    'ai-status-check': '正在检查 LLM 连接',
    'refresh-state': '正在刷新本地状态'
  };
  return labels[action] ?? action;
}

function autopilotWorkerLabel(worker: AutopilotWorkerStatus): string {
  if (!worker.enabled) {
    return '未启用';
  }
  if (worker.running) {
    return '运行中';
  }
  if (worker.lastError) {
    return '失败';
  }
  return '已启用';
}

function formatActionRequestText(action: AgentActionRequest): string {
  const raw = String(action.input.requestText ?? action.input.proposal ?? action.input.messageBody ?? '').trim();
  const fallback = fallbackActionRequestText(action.kind);
  return formatReadableDemoText(raw, fallback);
}

function formatA2ASessionGoal(goal: string): string {
  return formatReadableDemoText(
    goal,
    inferA2AGoalFallback(goal)
  );
}

function formatA2ATurnMessage(message: string): string {
  return formatReadableDemoText(
    message,
    inferA2ATurnFallback(message)
  );
}

function formatReadableDemoText(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed || isUnreadableDemoText(trimmed) || shouldUseReadableFallback(trimmed)) {
    return fallback;
  }
  return trimmed;
}

function shouldUseReadableFallback(value: string): boolean {
  if (value.length > 140) {
    return true;
  }
  if (value.includes('不是我的Agent') || value.includes('不是我的 Agent')) {
    return true;
  }
  if (isEnglishOperationalText(value)) {
    return true;
  }
  return /^(Needs confirmation|Negotiation produced|Selected file is authorized)/i.test(value) ||
    /fallback\.[a-z_.-]+|agent\.[a-z_.-]+/.test(value);
}

function isEnglishOperationalText(value: string): boolean {
  const englishLetters = value.match(/[A-Za-z]/g)?.length ?? 0;
  const cjkChars = value.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  if (cjkChars > 0 || englishLetters < 16) {
    return false;
  }
  return /\b(Agent|offline|slides?|file|negotiate|review|confirmation|delivered|handoff)\b/i.test(value);
}

function inferA2AGoalFallback(goal: string): string {
  if (/\b(slides?|file|send|handoff|offline)\b/i.test(goal)) {
    return '文件代发请求：对方请求发送最新材料，等待人工确认。';
  }
  return '日程协调提案：把合稿检查从周二 20:30 调整到周三 23:00，等待人工确认。';
}

function inferA2ATurnFallback(message: string): string {
  if (/\b(delivered|file|slides?)\b/i.test(message)) {
    return 'Agent 已完成授权文件代发。';
  }
  return 'Agent 已完成上下文检查，并将日程变更提交人工确认。';
}

function isUnreadableDemoText(value: string): boolean {
  const compact = value.replace(/\s/g, '');
  const questionMarks = (compact.match(/\?/g) ?? []).length;
  const readableChars = (compact.match(/[A-Za-z0-9\u4e00-\u9fff]/g) ?? []).length;
  return questionMarks >= 6 && questionMarks > readableChars;
}

function fallbackActionRequestText(kind: AgentActionRequest['kind']): string {
  if (kind === 'coordinate') {
    return '日程协调提案：把周二 20:30 的合稿检查改到周三 23:00，等待人工确认。';
  }
  if (kind === 'share_file') {
    return '文件代发请求：在授权范围内查找并发送最新材料，等待人工确认。';
  }
  if (kind === 'send_message') {
    return '消息代发请求：Agent 已准备好草稿，等待人工确认后发送。';
  }
  if (kind === 'task_update' || kind === 'task_update_suggest') {
    return '任务状态变更建议：Agent 已生成更新方案，等待人工确认。';
  }
  return `${agentActionKindLabel(kind)}：等待人工确认。`;
}
