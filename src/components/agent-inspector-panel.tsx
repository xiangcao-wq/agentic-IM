import { useState } from 'react';
import { FileText } from 'lucide-react';
import type {
  AgentActionLog,
  AgentProgressEvent,
  AgentTrace,
  DemoState,
  FileItem
} from '../domain/types';
import type { AgentTimelineItem, PermissionCenterItem } from '../client/agentTimeline';

type AgentTraceLoadStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export function AgentInspectorPanel(props: {
  agent: DemoState['agents'][number];
  busyAction: string | null;
  files: FileItem[];
  logs: AgentActionLog[];
  permissionItems: PermissionCenterItem[];
  pendingCount: number;
  progressEvents: AgentProgressEvent[];
  rooms: DemoState['rooms'];
  selectedRoom: DemoState['rooms'][number];
  timelineItems: AgentTimelineItem[];
  trace: AgentTrace | null;
  traceStatus: AgentTraceLoadStatus;
}) {
  return (
    <aside className="agent-console-inspector agent-inspector" aria-label="Agent runtime inspector">
      <InspectorTimelinePanel
        busyAction={props.busyAction}
        logs={props.logs}
        progressEvents={props.progressEvents}
        timelineItems={props.timelineItems}
        trace={props.trace}
        traceStatus={props.traceStatus}
      />
      <InspectorPermissionPanel
        agent={props.agent}
        permissionItems={props.permissionItems}
        pendingCount={props.pendingCount}
        rooms={props.rooms}
        selectedRoom={props.selectedRoom}
      />
      <InspectorFilesPanel files={props.files} />
    </aside>
  );
}

function InspectorTimelinePanel(props: {
  busyAction: string | null;
  logs: AgentActionLog[];
  progressEvents: AgentProgressEvent[];
  timelineItems: AgentTimelineItem[];
  trace: AgentTrace | null;
  traceStatus: AgentTraceLoadStatus;
}) {
  const [auditOpen, setAuditOpen] = useState(false);
  const latestProgress = props.progressEvents.at(-1);
  const hasTerminalProgress = latestProgress?.phase === 'completed' || latestProgress?.phase === 'failed';
  const showBusyAction = Boolean(props.busyAction && !hasTerminalProgress);
  const traceToolCalls = Array.isArray(props.trace?.toolCalls)
    ? props.trace.toolCalls.filter((toolCall): toolCall is string => typeof toolCall === 'string' && toolCall.length > 0)
    : [];
  const eventCount = typeof props.trace?.eventCount === 'number' ? props.trace.eventCount : props.timelineItems.length;
  const hasAuditDetails = Boolean(props.trace || props.logs.length > 0 || props.progressEvents.length > 0 || showBusyAction);
  const summary = runtimeSummary({
    busyAction: props.busyAction,
    eventCount,
    hasTerminalProgress,
    logs: props.logs,
    progressEvents: props.progressEvents,
    trace: props.trace,
    traceStatus: props.traceStatus
  });

  return (
    <section className="data-section inspector-card inspector-timeline" data-testid="agent-trace-panel">
      <div className="inspector-section-heading">
        <div>
          <span>01</span>
          <h3>Agent 活动</h3>
        </div>
        <em>{props.traceStatus === 'loading' ? 'loading' : props.trace ? props.trace.status : 'live'}</em>
      </div>

      <div className={`runtime-summary-card tone-${summary.tone}`}>
        <strong>{summary.title}</strong>
        <span>{summary.detail}</span>
      </div>

      {hasAuditDetails ? (
        <button className="audit-disclosure-button" type="button" onClick={() => setAuditOpen((value) => !value)}>
          {auditOpen ? '收起运行详情' : '查看运行详情'}
        </button>
      ) : null}

      {auditOpen ? (
        <>
      {props.traceStatus === 'loading' ? (
        <div className="compact-list agent-timeline-list">
          <div className="compact-row trace-row tone-neutral">
            <strong>Loading trace</strong>
            <span>Waiting for replay data</span>
          </div>
        </div>
      ) : props.traceStatus === 'unavailable' ? (
        <div className="compact-list agent-timeline-list">
          <div className="compact-row trace-row tone-warning">
            <strong>Trace unavailable</strong>
            <span>Run result is available, but replay data could not be loaded.</span>
          </div>
        </div>
      ) : props.trace ? (
        <div className="compact-list agent-timeline-list">
          <div className="trace-summary-row">
            <strong>{props.trace.status}</strong>
            <span>
              {eventCount} events
              {traceToolCalls.length > 0 ? ` | ${traceToolCalls.join(', ')}` : ''}
              {props.trace.truncated ? ' | partial trace' : ''}
            </span>
          </div>
          {props.timelineItems.slice(-6).map((item) => (
            <div className={`compact-row trace-row tone-${item.tone}`} key={item.id}>
              <strong>
                <span>{item.title}</span>
                {item.riskLevel ? <em>{item.riskLevel}</em> : null}
              </strong>
              <span>
                {item.detail}
                {item.toolName ? ` | ${item.toolName}` : ''}
              </span>
              <small>{formatTime(item.timestamp)}</small>
            </div>
          ))}
        </div>
      ) : (
        <div className="compact-list agent-timeline-list">
          {props.progressEvents.length > 0 ? (
            <>
              <div className="trace-list-summary">实时步骤</div>
              {props.progressEvents.slice(-4).map((event) => (
                <div className={`compact-row trace-row progress-${event.phase}`} key={event.id}>
                  <strong>{event.label}</strong>
                  <span>
                    {agentProgressPhaseLabel(event.phase)}
                    {event.detail ? ` · ${event.detail}` : ''}
                    {event.toolCalls.length > 0 ? ` · ${event.toolCalls.join(' → ')}` : ''}
                    {' · '}
                    {formatTime(event.createdAt)}
                  </span>
                </div>
              ))}
            </>
          ) : null}
          {showBusyAction ? (
            <div className="compact-row trace-row is-running">
              <strong>执行中</strong>
              <span>{busyActionLabel(props.busyAction ?? '')}</span>
            </div>
          ) : null}
          {props.logs.length > 0 ? (
            props.logs.slice(0, 6).map((log) => (
              <div className="compact-row trace-row" key={log.id}>
                <strong>{log.action}</strong>
                <span>{formatLogStatus(log)} · {log.toolCalls.join(' → ') || '未调用工具'} · {formatTime(log.createdAt)}</span>
              </div>
            ))
          ) : !showBusyAction && props.progressEvents.length === 0 ? (
            <div className="compact-row trace-row is-empty">
              <strong>等待 Agent 动作</strong>
              <span>执行后这里会展示步骤、工具调用和结果。</span>
            </div>
          ) : null}
        </div>
      )}
        </>
      ) : null}
    </section>
  );
}

function runtimeSummary(input: {
  busyAction: string | null;
  eventCount: number;
  hasTerminalProgress: boolean;
  logs: AgentActionLog[];
  progressEvents: AgentProgressEvent[];
  trace: AgentTrace | null;
  traceStatus: AgentTraceLoadStatus;
}): { title: string; detail: string; tone: 'neutral' | 'success' | 'warning' | 'danger' } {
  if (input.traceStatus === 'loading') {
    return {
      title: '正在读取执行记录',
      detail: 'Agent 已返回结果，正在补充审计记录。',
      tone: 'neutral'
    };
  }
  if (input.traceStatus === 'unavailable') {
    return {
      title: '结果已生成，审计记录暂不可用',
      detail: '这不影响本次回答；稍后可以重新查看运行详情。',
      tone: 'warning'
    };
  }
  if (input.trace) {
    const partial = input.trace.truncated ? '，partial trace' : '';
    return {
      title: input.trace.status === 'completed' ? '已完成' : traceStatusLabel(input.trace.status),
      detail: `完成 ${input.eventCount} 个步骤${partial}。技术日志已收起，可按需展开。`,
      tone: input.trace.status === 'completed' ? 'success' : 'neutral'
    };
  }
  if (input.busyAction && !input.hasTerminalProgress) {
    return {
      title: '正在处理',
      detail: busyActionLabel(input.busyAction),
      tone: 'neutral'
    };
  }
  if (input.progressEvents.length > 0) {
    const latest = input.progressEvents[0];
    return {
      title: agentProgressPhaseLabel(latest.phase),
      detail: latest.label,
      tone: latest.phase === 'failed' ? 'danger' : latest.phase === 'completed' ? 'success' : 'neutral'
    };
  }
  if (input.logs.length > 0) {
    return {
      title: '最近完成',
      detail: `已记录 ${input.logs.length} 次 Agent 动作。`,
      tone: 'success'
    };
  }
  return {
    title: '等待 Agent 动作',
    detail: '执行后这里会显示给用户看的活动摘要。',
    tone: 'neutral'
  };
}

function traceStatusLabel(status: string): string {
  if (status === 'failed') {
    return '执行失败';
  }
  if (status === 'cancelled') {
    return '已取消';
  }
  return '进行中';
}

function permissionOutcomeLabel(outcome: PermissionCenterItem['outcome']): string {
  if (outcome === 'allow') {
    return '已放行';
  }
  if (outcome === 'deny') {
    return '已阻止';
  }
  if (outcome === 'ask') {
    return '待确认';
  }
  return '已记录';
}

function permissionOutcomeDescription(outcome: PermissionCenterItem['outcome']): string {
  if (outcome === 'allow') {
    return '符合当前授权边界。';
  }
  if (outcome === 'deny') {
    return '不符合当前授权边界。';
  }
  if (outcome === 'ask') {
    return '需要用户确认后继续。';
  }
  return '已记录权限判断。';
}

function InspectorPermissionPanel(props: {
  agent: DemoState['agents'][number];
  permissionItems: PermissionCenterItem[];
  pendingCount: number;
  rooms: DemoState['rooms'];
  selectedRoom: DemoState['rooms'][number];
}) {
  const readableRooms = props.rooms.filter((room) => props.agent.allowedRoomIds.includes(room.id));
  const visiblePermissionItems = props.permissionItems.slice(-8);

  return (
    <section className="data-section inspector-card inspector-permission">
      <div className="inspector-section-heading">
        <div>
          <span>02</span>
          <h3>边界与确认</h3>
        </div>
        <em>{props.pendingCount > 0 ? `${props.pendingCount} 待确认` : '已守护'}</em>
      </div>
      <div className="permission-scope-grid">
        <span>当前对话</span>
        <strong>{props.selectedRoom.name}</strong>
        <span>可读范围</span>
        <strong>{readableRooms.length} 个聊天室</strong>
        <span>可用工具</span>
        <strong>{props.agent.allowedToolIds.length || 0} 项</strong>
      </div>
      <div className="compact-list permission-center-list">
        {props.permissionItems.length > visiblePermissionItems.length ? (
          <div className="trace-list-summary">显示最近 8 条，共 {props.permissionItems.length} 条</div>
        ) : null}
        {props.permissionItems.length > 0 ? (
          visiblePermissionItems.map((item) => (
            <div className={`compact-row permission-row outcome-${item.outcome}`} key={item.id}>
              <strong>
                <span>{permissionOutcomeLabel(item.outcome)}</span>
                {item.riskLevel ? <em>{item.riskLevel}</em> : null}
              </strong>
              <span>{item.reason || permissionOutcomeDescription(item.outcome)}</span>
              <small>
                {formatTime(item.timestamp)}
                {item.requiresHuman ? ' · 需要人工确认' : ' · 自动放行'}
              </small>
            </div>
          ))
        ) : props.pendingCount > 0 ? (
          <div className="compact-row permission-row outcome-neutral">
            <strong>{props.pendingCount} 个动作等待确认</strong>
            <span>确认前不会发送文件、改日程或更新任务。</span>
          </div>
        ) : (
          <div className="compact-row permission-row outcome-neutral">
            <strong>暂无边界决策</strong>
            <span>当前操作没有触发文件、日程或任务变更。</span>
          </div>
        )}
      </div>
    </section>
  );
}

function InspectorFilesPanel(props: { files: FileItem[] }) {
  const authorizedCount = props.files.filter((file) => file.agentCanShare).length;

  return (
    <section className="data-section inspector-card inspector-files">
      <div className="inspector-section-heading">
        <div>
          <span>03</span>
          <h3>Files</h3>
        </div>
        <em>{authorizedCount}/{props.files.length} authorized</em>
      </div>
      <div className="compact-list inspector-file-list">
        {props.files.length > 0 ? (
          props.files.map((file) => (
            <div className={`compact-row inspector-file-row ${file.agentCanShare ? 'can-share' : 'needs-review'}`} key={file.id}>
              <FileText size={15} />
              <div>
                <strong>{file.name}</strong>
                <span>{file.agentCanShare ? 'Agent 可代发' : '需要本人确认'} · {file.contentType ?? '未知类型'}</span>
              </div>
            </div>
          ))
        ) : (
          <div className="compact-row is-empty">
            <strong>暂无文件</strong>
            <span>当前聊天室还没有可处理文件。</span>
          </div>
        )}
      </div>
    </section>
  );
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

function formatLogStatus(log: AgentActionLog): string {
  const statusLabels: Record<AgentActionLog['status'], string> = {
    executed: '已执行',
    needs_confirmation: '待确认',
    blocked: '已阻止'
  };
  return `${statusLabels[log.status]} · ${log.risk.level}`;
}

function agentProgressPhaseLabel(phase: AgentProgressEvent['phase']): string {
  const labels: Record<AgentProgressEvent['phase'], string> = {
    started: '已接收',
    planning: '规划中',
    executing: '执行中',
    completed: '已完成',
    failed: '失败'
  };
  return labels[phase];
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
