import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  MessageSquare,
  PanelRightOpen,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
  Users
} from 'lucide-react';
import {
  confirmAgentAction,
  createStateEventSource,
  fetchState,
  fileDownloadUrl,
  generateDemoAssets,
  humanReply,
  runAgent,
  sendMessage,
  syncMatrixOnce,
  rejectAgentAction,
  uploadFile
} from './client/apiClient';
import type {
  AgentActionLog,
  AgentActionRequest,
  AgentRunResult,
  AiAutoreplyPolicy,
  AiReplyJob,
  CalendarItem,
  CoordinationResult,
  DeadlineAnswer,
  DemoState,
  FileItem,
  FileShareAction,
  MemoryItem,
  Message,
  RoomSummary,
  TaskItem
} from './domain/types';

type AgentResult =
  | { kind: 'summary'; value: RoomSummary }
  | { kind: 'deadline'; value: DeadlineAnswer }
  | { kind: 'file-share'; value: FileShareAction }
  | { kind: 'coordination'; value: CoordinationResult }
  | { kind: 'agent-run'; value: AgentRunResult }
  | { kind: 'human-reply'; value: Message }
  | { kind: 'assets'; value: FileItem[] }
  | { kind: 'sync'; value: { messagesAdded: number; checkpoints: DemoState['matrixObserverCheckpoints'] } };

const apiBaseUrl = import.meta.env.VITE_AGENT_API_BASE ?? '';
const currentUserId = 'user-lin';
const currentAgentId = 'agent-lin';

function App() {
  const [state, setState] = useState<DemoState | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState('room-team');
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [composer, setComposer] = useState('');
  const [agentPrompt, setAgentPrompt] = useState('这次作业什么时候截止？');
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  async function refreshState() {
    const nextState = await fetchState(apiBaseUrl);
    setState(nextState);
    return nextState;
  }

  useEffect(() => {
    let disposed = false;
    refreshState()
      .then((nextState) => {
        if (!disposed) {
          const initialSummary = {
            headline: '选择右侧动作开始真实 Agent 流程。',
            deadlines: [],
            todos: nextState.tasks.slice(0, 2).map((task) => `${task.deadline} · ${task.title}`),
            sources: []
          };
          setAgentResult({ kind: 'summary', value: initialSummary });
        }
      })
      .catch((loadError) => {
        if (!disposed) {
          setError(loadError instanceof Error ? loadError.message : '无法连接本地 API 服务');
        }
      });

    const events = createStateEventSource(apiBaseUrl);
    events.addEventListener('state', (event) => {
      if (!disposed) {
        setState(JSON.parse((event as MessageEvent).data) as DemoState);
      }
    });
    events.onerror = () => {
      if (!disposed) {
        setError('实时连接已断开；请确认本地 API 服务仍在运行。');
      }
    };

    return () => {
      disposed = true;
      events.close();
    };
  }, []);

  if (!state) {
    return (
      <main className="empty-shell">
        <div className="empty-panel">
          <Bot size={28} />
          <h1>正在连接 Agent IM API</h1>
          <p>{error ?? '读取真实本地数据库和事件流。'}</p>
        </div>
      </main>
    );
  }

  const selectedRoom = state.rooms.find((room) => room.id === selectedRoomId) ?? state.rooms[0];
  const currentUser = state.users.find((user) => user.id === currentUserId)!;
  const currentAgent = state.agents.find((agent) => agent.id === currentAgentId)!;
  const roomMessages = state.messages.filter((message) => message.roomId === selectedRoom.id);
  const roomFiles = state.files.filter((file) => file.roomId === selectedRoom.id);
  const visibleFiles =
    roomFiles.length > 0 ? roomFiles : state.files.filter((file) => currentAgent.allowedRoomIds.includes(file.roomId));
  const visibleMemories = state.memories
    .filter(
      (memory) =>
        memory.ownerAgentId === currentAgentId &&
        (memory.scopeRoomIds.includes(selectedRoom.id) ||
          memory.scopeRoomIds.some((roomId) => currentAgent.allowedRoomIds.includes(roomId)))
    )
    .slice(0, 5);
  const roomTasks =
    selectedRoom.id === 'room-class'
      ? state.tasks
      : state.tasks.filter((task) => task.id !== 'task-report');

  async function runAction<T>(label: string, action: () => Promise<T>): Promise<T | undefined> {
    setBusyAction(label);
    setError(null);
    try {
      const result = await action();
      await refreshState();
      return result;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '操作失败');
      return undefined;
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSummarize() {
    await runAction('summary', async () => {
      const response = await runAgent(apiBaseUrl, {
        agentId: currentAgentId,
        roomId: selectedRoom.id,
        intent: 'summary',
        userText: agentPrompt || '总结当前群聊'
      });
      setAgentResult({ kind: 'agent-run', value: response });
      return response;
    });
  }

  async function handleDeadlineQuestion() {
    await runAction('deadline', async () => {
      const response = await runAgent(apiBaseUrl, {
        agentId: currentAgentId,
        roomId: selectedRoom.id,
        intent: 'deadline',
        userText: agentPrompt
      });
      setAgentResult({ kind: 'agent-run', value: response });
      return response;
    });
  }

  async function handleFileShare() {
    await runAction('file-share', async () => {
      const response = await runAgent(apiBaseUrl, {
        agentId: currentAgentId,
        roomId: selectedRoom.id,
        intent: 'share_file',
        userText: agentPrompt || '把最新行动计划发一下',
        targetUserId: 'user-chen'
      });
      setAgentResult({ kind: 'agent-run', value: response });
      return response;
    });
  }

  async function handleCoordinate() {
    await runAction('coordination', async () => {
      const response = await runAgent(apiBaseUrl, {
        agentId: currentAgentId,
        roomId: selectedRoom.id,
        intent: 'coordinate',
        userText: agentPrompt || '把周二 20:30 的合稿检查改到周三 23:00，并确认大家是否同意。',
        targetUserId: 'user-chen'
      });
      setAgentResult({ kind: 'agent-run', value: response });
      return response;
    });
  }

  async function handleFindFile() {
    await runAction('find-file', async () => {
      const response = await runAgent(apiBaseUrl, {
        agentId: currentAgentId,
        roomId: selectedRoom.id,
        intent: 'find_file',
        userText: agentPrompt || '最新行动计划'
      });
      setAgentResult({ kind: 'agent-run', value: response });
      return response;
    });
  }

  async function handleGenerateAssets() {
    await runAction('generate-assets', async () => {
      const response = await generateDemoAssets(apiBaseUrl, {
        roomId: selectedRoom.id,
        senderId: currentUserId
      });
      setAgentResult({ kind: 'assets', value: response.files });
      return response;
    });
  }

  async function handleSyncMatrix() {
    await runAction('matrix-sync', async () => {
      const response = await syncMatrixOnce(apiBaseUrl);
      setAgentResult({ kind: 'sync', value: response });
      return response;
    });
  }

  async function handleAiHumanReply(userId: string) {
    await runAction(`ai-reply-${userId}`, async () => {
      const response = await humanReply(apiBaseUrl, {
        roomId: selectedRoom.id,
        userId,
        prompt: composer.trim() || agentPrompt || '请结合当前聊天自然回复。'
      });
      setAgentResult({ kind: 'human-reply', value: response.message });
      return response;
    });
  }

  async function handleSendMessage() {
    const text = composer.trim();
    if (!text) {
      return;
    }
    await runAction('send', async () => {
      const message = await sendMessage(apiBaseUrl, {
        roomId: selectedRoom.id,
        senderId: currentUserId,
        body: text
      });
      setComposer('');
      return message;
    });
  }

  async function handleUploadFile(file: File) {
    await runAction('upload-file', async () => {
      const uploaded = await uploadFile(apiBaseUrl, {
        roomId: selectedRoom.id,
        senderId: currentUserId,
        file,
        agentCanShare: true
      });
      return uploaded;
    });
  }

  async function handleConfirmAgentAction(actionId: string) {
    await runAction(`confirm-${actionId}`, async () => {
      return confirmAgentAction(apiBaseUrl, {
        actionId,
        reviewerId: currentUserId,
        reason: '用户在 Agent 工作台确认'
      });
    });
  }

  async function handleRejectAgentAction(actionId: string) {
    await runAction(`reject-${actionId}`, async () => {
      return rejectAgentAction(apiBaseUrl, {
        actionId,
        reviewerId: currentUserId,
        reason: '用户在 Agent 工作台拒绝'
      });
    });
  }

  return (
    <main className="app-shell">
      <Sidebar
        currentUserName={currentUser.name}
        rooms={state.rooms}
        selectedRoomId={selectedRoom.id}
        onSelectRoom={setSelectedRoomId}
      />
      <ChatPanel
        room={selectedRoom}
        messages={roomMessages}
        files={state.files}
        users={state.users}
        composer={composer}
        busyAction={busyAction}
        onComposerChange={setComposer}
        onSend={handleSendMessage}
        onFileUpload={handleUploadFile}
        onAiHumanReply={handleAiHumanReply}
      />
      <AgentWorkbench
        agentName={currentAgent.displayName}
        prompt={agentPrompt}
        error={error}
        busyAction={busyAction}
        result={agentResult}
        files={visibleFiles}
        tasks={roomTasks}
        calendar={state.calendar}
        actions={state.actionRequests}
        logs={state.actionLogs}
        memories={visibleMemories}
        autoreplyPolicies={state.aiAutoreplyPolicies}
        aiReplyJobs={state.aiReplyJobs}
        users={state.users}
        selectedRoomId={selectedRoom.id}
        sourceMessages={state.messages}
        sourceFiles={state.files}
        onPromptChange={setAgentPrompt}
        onSummarize={handleSummarize}
        onDeadlineQuestion={handleDeadlineQuestion}
        onFindFile={handleFindFile}
        onFileShare={handleFileShare}
        onCoordinate={handleCoordinate}
        onGenerateAssets={handleGenerateAssets}
        onSyncMatrix={handleSyncMatrix}
        onConfirmAction={handleConfirmAgentAction}
        onRejectAction={handleRejectAgentAction}
      />
    </main>
  );
}

function Sidebar(props: {
  currentUserName: string;
  rooms: DemoState['rooms'];
  selectedRoomId: string;
  onSelectRoom: (roomId: string) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark">A</div>
        <div>
          <h1>Agent IM</h1>
          <p>Local real API workspace</p>
        </div>
      </div>

      <div className="profile-panel">
        <div className="avatar">LW</div>
        <div>
          <strong>{props.currentUserName}</strong>
          <span>个人 Agent 在线托管中</span>
        </div>
      </div>

      <nav className="room-list" aria-label="rooms">
        {props.rooms.map((room) => (
          <button
            aria-label={room.name}
            className={`room-button ${room.id === props.selectedRoomId ? 'is-active' : ''}`}
            key={room.id}
            onClick={() => props.onSelectRoom(room.id)}
            type="button"
          >
            <span className="room-icon">
              {room.type === 'direct' ? <Bot size={16} /> : <MessageSquare size={16} />}
            </span>
            <span className="room-meta">
              <strong>{room.name}</strong>
              <small>{room.matrixAlias}</small>
            </span>
            {room.unreadCount > 0 ? <em>{room.unreadCount}</em> : null}
          </button>
        ))}
      </nav>

      <div className="protocol-panel">
        <ShieldCheck size={18} />
        <div>
          <strong>风险评估</strong>
          <span>主 Agent + risk-mini-v1</span>
        </div>
      </div>
    </aside>
  );
}

function ChatPanel(props: {
  room: DemoState['rooms'][number];
  messages: Message[];
  files: FileItem[];
  users: DemoState['users'];
  composer: string;
  busyAction: string | null;
  onComposerChange: (value: string) => void;
  onSend: () => void;
  onFileUpload: (file: File) => void;
  onAiHumanReply: (userId: string) => void;
}) {
  const roomFilesById = useMemo(() => new Map(props.files.map((file) => [file.id, file])), [props.files]);
  const aiHumanMembers = props.users.filter(
    (user) => props.room.memberIds.includes(user.id) && user.id !== currentUserId
  );

  return (
    <section className="chat-panel">
      <header className="chat-header">
        <div>
          <h2>{props.room.name}</h2>
          <p>{props.room.matrixAlias}</p>
        </div>
        <div className="chat-header-side">
          <div className="member-stack" aria-label="members">
            {props.room.memberIds.slice(0, 4).map((memberId) => {
              const user = props.users.find((candidate) => candidate.id === memberId);
              return (
                <span key={memberId} title={user?.name}>
                  {user?.avatar ?? '--'}
                </span>
              );
            })}
          </div>
          <div className="ai-reply-bar" aria-label="AI 角色发言">
            {aiHumanMembers.slice(0, 3).map((user) => (
              <button
                key={user.id}
                type="button"
                onClick={() => props.onAiHumanReply(user.id)}
                disabled={Boolean(props.busyAction)}
              >
                <Sparkles size={14} />
                <span>让{user.name}回复</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="message-list">
        {props.messages.map((message) => {
          const attachedFile = message.fileId ? roomFilesById.get(message.fileId) : undefined;
          return (
            <article className={`message-row ${message.senderId === currentUserId ? 'is-self' : ''}`} key={message.id}>
              <div className="message-avatar">{message.senderName.slice(0, 2)}</div>
              <div className="message-bubble">
                <div className="message-topline">
                  <strong>{message.senderName}</strong>
                  {message.agentLabel ? <span className="agent-badge">{message.agentLabel}</span> : null}
                  <time>{formatTime(message.sentAt)}</time>
                </div>
                <p>{message.body}</p>
                {message.fileId ? <FileAttachment file={attachedFile} fallbackName={message.body} /> : null}
              </div>
            </article>
          );
        })}
      </div>

      <footer className="composer">
        <label className="upload-button" aria-label="upload file" title="上传文件">
          <Upload size={18} />
          <input
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                props.onFileUpload(file);
                event.target.value = '';
              }
            }}
            disabled={props.busyAction === 'upload-file'}
          />
        </label>
        <input
          aria-label="message"
          onChange={(event) => props.onComposerChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              props.onSend();
            }
          }}
          placeholder="输入消息"
          value={props.composer}
        />
        <button type="button" onClick={props.onSend} aria-label="send message" disabled={props.busyAction === 'send'}>
          <Send size={18} />
        </button>
      </footer>
    </section>
  );
}

function FileAttachment(props: { file?: FileItem; fallbackName: string }) {
  const label = props.file?.name ?? props.fallbackName;
  if (props.file?.mxcUri) {
    return (
      <a className="file-chip" href={fileDownloadUrl(apiBaseUrl, props.file.id)} download={props.file.name}>
        <FileText size={16} />
        <span>{label}</span>
        <Download size={14} />
      </a>
    );
  }

  return (
    <div className="file-chip is-unavailable" title="文件没有 Matrix media backing，暂不能下载">
      <FileText size={16} />
      <span>{label}</span>
    </div>
  );
}

function AgentWorkbench(props: {
  agentName: string;
  prompt: string;
  error: string | null;
  busyAction: string | null;
  result: AgentResult | null;
  files: FileItem[];
  tasks: TaskItem[];
  calendar: CalendarItem[];
  actions: AgentActionRequest[];
  logs: AgentActionLog[];
  memories: MemoryItem[];
  autoreplyPolicies: AiAutoreplyPolicy[];
  aiReplyJobs: AiReplyJob[];
  users: DemoState['users'];
  selectedRoomId: string;
  sourceMessages: Message[];
  sourceFiles: FileItem[];
  onPromptChange: (value: string) => void;
  onSummarize: () => void;
  onDeadlineQuestion: () => void;
  onFindFile: () => void;
  onFileShare: () => void;
  onCoordinate: () => void;
  onGenerateAssets: () => void;
  onSyncMatrix: () => void;
  onConfirmAction: (actionId: string) => void;
  onRejectAction: (actionId: string) => void;
}) {
  const pendingActions = props.actions.filter((action) => action.status === 'needs_confirmation' || action.status === 'pending');

  return (
    <aside className="agent-workbench">
      <header className="agent-header">
        <div className="agent-orb">
          <Bot size={22} />
        </div>
        <div>
          <h2>{props.agentName}</h2>
          <p>可读群聊、文件、任务、日程</p>
        </div>
      </header>

      <div className="agent-query">
        <label htmlFor="agent-prompt">Agent 输入</label>
        <div className="query-row">
          <input
            id="agent-prompt"
            value={props.prompt}
            onChange={(event) => props.onPromptChange(event.target.value)}
          />
          <button type="button" onClick={props.onDeadlineQuestion} aria-label="ask agent" disabled={Boolean(props.busyAction)}>
            <Search size={17} />
          </button>
        </div>
      </div>

      <div className="action-grid">
        <ActionButton icon={<PanelRightOpen size={17} />} label="总结群聊" onClick={props.onSummarize} disabled={Boolean(props.busyAction)} />
        <ActionButton icon={<Clock3 size={17} />} label="问截止" onClick={props.onDeadlineQuestion} disabled={Boolean(props.busyAction)} />
        <ActionButton icon={<Search size={17} />} label="Agent 找文件" onClick={props.onFindFile} disabled={Boolean(props.busyAction)} />
        <ActionButton icon={<FileText size={17} />} label="离线代发" onClick={props.onFileShare} disabled={Boolean(props.busyAction)} />
        <ActionButton icon={<Users size={17} />} label="Agent 协调" onClick={props.onCoordinate} disabled={Boolean(props.busyAction)} />
        <ActionButton icon={<Upload size={17} />} label="生成真实文件" onClick={props.onGenerateAssets} disabled={Boolean(props.busyAction)} />
        <ActionButton icon={<RefreshCw size={17} />} label="同步 Matrix" onClick={props.onSyncMatrix} disabled={Boolean(props.busyAction)} />
      </div>

      {props.error ? <div className="error-banner">{props.error}</div> : null}
      {props.result ? (
        <ResultPanel
          result={props.result}
          sourceMessages={props.sourceMessages}
          sourceFiles={props.sourceFiles}
        />
      ) : null}

      <section className="data-section">
        <div className="section-title">
          <Sparkles size={17} />
          <h3>自动聊天</h3>
        </div>
        <div className="compact-list">
          {props.autoreplyPolicies
            .filter((policy) => policy.allowedRoomIds.includes(props.selectedRoomId))
            .sort((a, b) => a.priority - b.priority)
            .map((policy) => {
              const user = props.users.find((candidate) => candidate.id === policy.userId);
              const latestJob = props.aiReplyJobs.find(
                (job) => job.targetUserId === policy.userId && job.roomId === props.selectedRoomId
              );
              return (
                <div className="compact-row" key={policy.userId}>
                  <strong>{user?.name ?? policy.userId} 自动回复</strong>
                  <span>
                    {policy.enabled ? '开启' : '关闭'} · {policy.triggerMode === 'all_messages' ? '任何消息' : '仅被提及'} ·{' '}
                    {latestJob ? `${latestJob.status} ${latestJob.replyMessageId ?? ''}` : '等待新消息'}
                  </span>
                </div>
              );
            })}
        </div>
      </section>

      {pendingActions.length > 0 ? (
        <section className="data-section confirmation-section">
          <div className="section-title">
            <AlertTriangle size={17} />
            <h3>待确认动作</h3>
          </div>
          <div className="confirmation-list">
            {pendingActions.map((action) => (
              <div className="confirmation-row" key={action.id}>
                <div>
                  <strong>{agentActionKindLabel(action.kind)}</strong>
                  <span>{String(action.input.requestText ?? action.input.proposal ?? '等待人工确认')}</span>
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
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="data-section">
        <div className="section-title">
          <FileText size={17} />
          <h3>文件库</h3>
        </div>
        <div className="compact-list">
          {props.files.slice(0, 5).map((file) => {
            const content = (
              <>
                <strong>
                  {file.name}
                  {file.mxcUri ? <Download size={13} /> : null}
                </strong>
                <span>
                  v{file.version} · {file.agentCanShare ? '允许代发' : '仅本人'} ·{' '}
                  {file.mxcUri ? 'Matrix media' : '仅元数据'} · {formatFileSize(file.size)}
                </span>
              </>
            );

            return file.mxcUri ? (
              <a
                className="compact-row file-row-link"
                href={fileDownloadUrl(apiBaseUrl, file.id)}
                download={file.name}
                key={file.id}
              >
                {content}
              </a>
            ) : (
            <div className="compact-row" key={file.id}>
              {content}
            </div>
            );
          })}
        </div>
      </section>

      <section className="data-section">
        <div className="section-title">
          <CalendarClock size={17} />
          <h3>任务与日程</h3>
        </div>
        <div className="task-list">
          {props.tasks.slice(0, 3).map((task) => (
            <div className="task-row" key={task.id}>
              <span className={`status-dot ${task.status}`} />
              <div>
                <strong>{task.title}</strong>
                <small>{task.deadline} · {task.owners.join('、')}</small>
              </div>
            </div>
          ))}
        </div>
        <div className="calendar-strip">
          <Clock3 size={15} />
          <span>{props.calendar[0]?.title} · {formatTime(props.calendar[0]?.startsAt ?? '')}</span>
        </div>
      </section>

      <section className="data-section">
        <div className="section-title">
          <Bot size={17} />
          <h3>结构化记忆</h3>
        </div>
        <div className="memory-list">
          {props.memories.length > 0 ? (
            props.memories.map((memory) => (
              <div className="memory-row" key={memory.id}>
                <strong>{memory.kind}</strong>
                <span>{memory.content}</span>
                <small>{memory.sourceIds.length} 个来源 · {memory.scopeRoomIds.join('、')}</small>
              </div>
            ))
          ) : (
            <div className="memory-row is-empty">
              <strong>等待 Agent 写入</strong>
              <span>总结、问截止、文件代发和协调都会留下可追溯记忆。</span>
            </div>
          )}
        </div>
      </section>

      <section className="data-section audit-section">
        <div className="section-title">
          <ShieldCheck size={17} />
          <h3>审计记录</h3>
        </div>
        <div className="audit-list">
          {props.logs.slice(0, 4).map((log, index) => (
            <div className="audit-row" key={`${log.id}-${index}`}>
              {log.risk.level === 'high' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
              <div>
                <strong>{log.action}</strong>
                <span>{log.risk.level} · {log.risk.reason}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}

function ActionButton(props: { icon: ReactNode; label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button className="action-button" onClick={props.onClick} type="button" disabled={props.disabled}>
      {props.icon}
      <span>{props.label}</span>
      <ChevronRight size={15} />
    </button>
  );
}

function CitationRow(props: { citations: string[]; sourceMessages: Message[]; sourceFiles: FileItem[] }) {
  return (
    <div className="citation-row">
      {props.citations.map((citation) => (
        <span key={citation}>{formatCitation(citation, props.sourceMessages, props.sourceFiles)}</span>
      ))}
    </div>
  );
}

function ResultPanel({
  result,
  sourceMessages,
  sourceFiles
}: {
  result: AgentResult;
  sourceMessages: Message[];
  sourceFiles: FileItem[];
}) {
  if (result.kind === 'agent-run') {
    return <AgentRunResultPanel result={result.value} sourceMessages={sourceMessages} sourceFiles={sourceFiles} />;
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

  if (result.kind === 'assets') {
    return (
      <section className="result-panel">
        <div className="result-heading">
          <Upload size={18} />
          <h3>真实文件已生成</h3>
        </div>
        <ul>
          {result.value.map((file) => (
            <li key={file.id}>{file.name} · {file.contentType} · {formatFileSize(file.size)}</li>
          ))}
        </ul>
      </section>
    );
  }

  if (result.kind === 'sync') {
    return (
      <section className="result-panel">
        <div className="result-heading">
          <RefreshCw size={18} />
          <h3>Matrix 同步</h3>
        </div>
        <p>新增 {result.value.messagesAdded} 条 Matrix 事件，checkpoint {result.value.checkpoints.length} 个房间。</p>
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
        <p>{result.value.answer}</p>
        <CitationRow citations={result.value.citations} sourceMessages={sourceMessages} sourceFiles={sourceFiles} />
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

function AgentRunResultPanel({
  result,
  sourceMessages,
  sourceFiles
}: {
  result: AgentRunResult;
  sourceMessages: Message[];
  sourceFiles: FileItem[];
}) {
  const title = agentIntentTitle(result.intent);
  const structured = result.result;

  if (result.files) {
    return (
      <section className="result-panel">
        <div className="result-heading">
          <Search size={18} />
          <h3>{title}</h3>
        </div>
        <ul>
          {result.files.length > 0 ? (
            result.files.map((file) => (
              <li key={file.id}>{file.name} · {file.agentCanShare ? 'Agent 可代发' : '需要本人确认'}</li>
            ))
          ) : (
            <li>没有找到符合授权边界的文件。</li>
          )}
        </ul>
        <RiskLine riskLevel={result.log.risk.level} reason={result.log.risk.reason} />
      </section>
    );
  }

  if (isRoomSummary(structured)) {
    return (
      <section className="result-panel">
        <div className="result-heading">
          <CheckCircle2 size={18} />
          <h3>{title}</h3>
        </div>
        <p>{structured.headline}</p>
        <ul>
          {structured.todos.map((todo) => (
            <li key={todo}>{todo}</li>
          ))}
        </ul>
        <RiskLine riskLevel={result.log.risk.level} reason={result.log.risk.reason} />
      </section>
    );
  }

  if (isDeadlineAnswer(structured)) {
    return (
      <section className="result-panel">
        <div className="result-heading">
          <Search size={18} />
          <h3>{title}</h3>
        </div>
        <p>{structured.answer}</p>
        <CitationRow citations={structured.citations} sourceMessages={sourceMessages} sourceFiles={sourceFiles} />
        <RiskLine riskLevel={result.log.risk.level} reason={result.log.risk.reason} />
      </section>
    );
  }

  if (isFileShareAction(structured)) {
    return (
      <section className="result-panel">
        <div className="result-heading">
          <FileText size={18} />
          <h3>{title}</h3>
        </div>
        <p>{structured.file?.name ?? '没有可自动代发的授权文件'}</p>
        <RiskLine riskLevel={structured.risk.level} reason={structured.risk.reason} />
      </section>
    );
  }

  if (isCoordinationResult(structured)) {
    return (
      <section className="result-panel">
        <div className="result-heading">
          <Users size={18} />
          <h3>{title}</h3>
        </div>
        <p>{structured.proposedPlan}</p>
        <RiskLine riskLevel={structured.risk.level} reason={structured.risk.reason} />
      </section>
    );
  }

  return (
    <section className="result-panel">
      <div className="result-heading">
        <Bot size={18} />
        <h3>{title}</h3>
      </div>
      <p>{result.requiresHuman ? '需要人工确认。' : 'Agent 已完成工具调用。'}</p>
      <RiskLine riskLevel={result.log.risk.level} reason={result.log.risk.reason} />
    </section>
  );
}

function agentIntentTitle(intent: AgentRunResult['intent']) {
  const titles: Record<AgentRunResult['intent'], string> = {
    summary: 'Agent 总结',
    deadline: 'Agent 问答',
    find_file: 'Agent 找文件',
    share_file: 'Agent 代发文件',
    coordinate: 'Agent 协调',
    task_update_suggest: '任务更新建议',
    chat: 'Agent 对话'
  };
  return titles[intent];
}

function isRoomSummary(value: AgentRunResult['result']): value is RoomSummary {
  return Boolean(value && 'headline' in value && 'todos' in value);
}

function isDeadlineAnswer(value: AgentRunResult['result']): value is DeadlineAnswer {
  return Boolean(value && 'answer' in value && 'citations' in value);
}

function isFileShareAction(value: AgentRunResult['result']): value is FileShareAction {
  return Boolean(value && 'file' in value && 'risk' in value && !('proposedPlan' in value));
}

function isCoordinationResult(value: AgentRunResult['result']): value is CoordinationResult {
  return Boolean(value && 'proposedPlan' in value);
}

function RiskLine(props: { riskLevel: string; reason: string }) {
  return (
    <div className={`risk-line ${props.riskLevel}`}>
      {props.riskLevel === 'high' ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
      <span>{props.riskLevel} · {props.reason}</span>
    </div>
  );
}

function agentActionKindLabel(kind: AgentActionRequest['kind']) {
  const labels: Record<AgentActionRequest['kind'], string> = {
    summary: '总结群聊',
    deadline: '问截止',
    find_file: '查找文件',
    share_file: '文件代发',
    coordinate: 'Agent 协调',
    task_update: '任务更新',
    calendar_update: '日程更新',
    task_update_suggest: '任务更新建议'
  };
  return labels[kind];
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

  return citation;
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

function formatFileSize(size?: number) {
  if (!size) {
    return 'size unknown';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export default App;
