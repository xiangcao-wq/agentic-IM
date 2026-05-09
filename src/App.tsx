import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ClipboardList,
  Download,
  ExternalLink,
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
  checkAiStatus,
  confirmAgentAction,
  createStateEventSource,
  downloadFile,
  fetchState,
  getAgentTrace,
  getAutopilotWorkerStatus,
  humanReply,
  runAgent,
  runAutopilotWorkerOnce,
  sendMessage,
  rejectAgentAction,
  updateAutopilotPolicy,
  uploadFile,
  type AutopilotWorkerRunResponse,
  type AutopilotWorkerStatus
} from './client/apiClient';
import type {
  AgentActionLog,
  AgentActionRequest,
  AgentProgressEvent,
  AgentTrace,
  AgentRunIntent,
  AgentRunRequest,
  AgentRunResult,
  AiAutoreplyPolicy,
  AiReplyJob,
  AiRuntimeStatus,
  CalendarItem,
  ChatResult,
  CoordinationResult,
  DeadlineAnswer,
  DemoState,
  FileItem,
  FileShareAction,
  MemoryItem,
  Message,
  RoomSummary,
  SendMessageAction,
  TaskItem,
  WebSearchAnswer
} from './domain/types';
import { sortMessagesChronologically } from './domain/messages';
import {
  buildAgentTimelineItems,
  buildPermissionCenterItems,
  type AgentTimelineItem,
  type PermissionCenterItem
} from './client/agentTimeline';

type AgentResult =
  | { kind: 'summary'; value: RoomSummary }
  | { kind: 'deadline'; value: DeadlineAnswer }
  | { kind: 'file-share'; value: FileShareAction }
  | { kind: 'coordination'; value: CoordinationResult }
  | { kind: 'agent-run'; value: AgentRunResult }
  | { kind: 'autopilot-run'; value: AutopilotWorkerRunResponse }
  | { kind: 'human-reply'; value: Message };

type RoomFilter = 'all' | 'group' | 'direct';
type EventStreamStatus = 'connecting' | 'connected' | 'disconnected';
type RoomContentTab = 'chat' | 'tasks' | 'files' | 'calendar' | 'members';
type AgentTraceLoadStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

const apiBaseUrl = import.meta.env.VITE_AGENT_API_BASE ?? '';
const currentUserId = 'user-lin';
const currentAgentId = 'agent-lin';
const eventStreamDisconnectedError = '实时连接已断开；请确认本地 API 服务仍在运行。';
const quickSummaryPrompt = '总结当前群聊：列出关键结论、已确认事项、待办、风险和下一步。';
const quickDeadlinePrompt = '只根据当前聊天、任务和日程回答：这次作业什么时候截止？还有哪些临近时间点？';
const quickFindFilePrompt = '在当前聊天可用文件里查找最新行动计划、演示稿、证据包或引用材料，列出文件名和用途。';
const defaultFileSharePrompt = '把最新行动计划发给陈晨';
const defaultCoordinatePrompt = '把周二 20:30 的合稿检查改到周三 23:00，并确认大家是否同意。';

const softAppear = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
} as const;

function App() {
  const [state, setState] = useState<DemoState | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState('room-team');
  const [roomSearch, setRoomSearch] = useState('');
  const [roomFilter, setRoomFilter] = useState<RoomFilter>('all');
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [agentTrace, setAgentTrace] = useState<AgentTrace | null>(null);
  const [agentTraceStatus, setAgentTraceStatus] = useState<AgentTraceLoadStatus>('idle');
  const [agentProgressEvents, setAgentProgressEvents] = useState<AgentProgressEvent[]>([]);
  const [composer, setComposer] = useState('');
  const [agentPrompt, setAgentPrompt] = useState('这次作业什么时候截止？');
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [eventStreamStatus, setEventStreamStatus] = useState<EventStreamStatus>('connecting');
  const [autopilotWorker, setAutopilotWorker] = useState<AutopilotWorkerStatus | null>(null);
  const eventStreamErrorVisibleRef = useRef(false);
  const agentRunSequenceRef = useRef(0);

  async function refreshState() {
    const [nextState, workerStatus] = await Promise.all([
      fetchState(apiBaseUrl),
      getAutopilotWorkerStatus(apiBaseUrl).catch(() => null)
    ]);
    setState(nextState);
    if (workerStatus) {
      setAutopilotWorker(workerStatus.worker);
    }
    return nextState;
  }

  async function refreshAutopilotWorkerStatus() {
    const workerStatus = await getAutopilotWorkerStatus(apiBaseUrl).catch(() => null);
    if (workerStatus) {
      setAutopilotWorker(workerStatus.worker);
    }
  }

  function loadAgentTraceForRun(sequence: number, traceRunId: string) {
    if (agentRunSequenceRef.current === sequence) {
      setAgentTraceStatus('loading');
    }
    void getAgentTrace(apiBaseUrl, traceRunId)
      .then((trace) => {
        if (agentRunSequenceRef.current === sequence) {
          setAgentTrace(trace);
          setAgentTraceStatus('ready');
        }
      })
      .catch(() => {
        if (agentRunSequenceRef.current === sequence) {
          setAgentTrace(null);
          setAgentTraceStatus('unavailable');
        }
      });
  }

  useEffect(() => {
    let disposed = false;
    refreshState()
      .catch((loadError) => {
        if (!disposed) {
          eventStreamErrorVisibleRef.current = false;
          setError(loadError instanceof Error ? loadError.message : '无法连接本地 API 服务');
        }
      });

    function clearEventStreamError() {
      setError((currentError) => {
        if (!eventStreamErrorVisibleRef.current) {
          return currentError;
        }
        eventStreamErrorVisibleRef.current = false;
        return null;
      });
    }

    function handleStreamReady() {
      if (!disposed) {
        setEventStreamStatus('connected');
        clearEventStreamError();
      }
    }

    function handleStreamFailure() {
      if (!disposed) {
        setEventStreamStatus('disconnected');
        setError((currentError) => {
          if (currentError === eventStreamDisconnectedError) {
            eventStreamErrorVisibleRef.current = true;
            return currentError;
          }
          if (currentError) {
            eventStreamErrorVisibleRef.current = false;
            return currentError;
          }
          eventStreamErrorVisibleRef.current = true;
          return eventStreamDisconnectedError;
        });
      }
    }

    const events = createStateEventSource(apiBaseUrl);
    void events.ready.then(handleStreamReady).catch(handleStreamFailure);

    const handleStateEvent = (event: { data: string }) => {
      if (!disposed) {
        setEventStreamStatus('connected');
        clearEventStreamError();
        setState(JSON.parse(event.data) as DemoState);
      }
    };
    const handleAgentProgressEvent = (event: { data: string }) => {
      if (!disposed) {
        setEventStreamStatus('connected');
        clearEventStreamError();
        const progress = JSON.parse(event.data) as AgentProgressEvent;
        setAgentProgressEvents((current) => [progress, ...current.filter((candidate) => candidate.id !== progress.id)].slice(0, 12));
      }
    };
    events.addEventListener('ready', handleStreamReady);
    events.addEventListener('state', handleStateEvent);
    events.addEventListener('agent-progress', handleAgentProgressEvent);
    events.addEventListener('error', handleStreamFailure);

    const workerStatusTimer = window.setInterval(() => {
      void refreshAutopilotWorkerStatus();
    }, 15_000);

    return () => {
      disposed = true;
      window.clearInterval(workerStatusTimer);
      events.removeEventListener('ready', handleStreamReady);
      events.removeEventListener('state', handleStateEvent);
      events.removeEventListener('agent-progress', handleAgentProgressEvent);
      events.removeEventListener('error', handleStreamFailure);
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
  const roomMessages = sortMessagesChronologically(state.messages.filter((message) => message.roomId === selectedRoom.id));
  const roomFiles = state.files.filter((file) => file.roomId === selectedRoom.id);
  const roomTasks = getTasksForRoom(state, selectedRoom.id);
  const filteredRooms = filterRooms(state.rooms, roomSearch, roomFilter);

  async function runAction<T>(label: string, action: () => Promise<T>): Promise<T | undefined> {
    setBusyAction(label);
    setError(null);
    eventStreamErrorVisibleRef.current = false;
    try {
      const result = await action();
      await refreshState();
      return result;
    } catch (actionError) {
      eventStreamErrorVisibleRef.current = false;
      setError(actionError instanceof Error ? actionError.message : '操作失败');
      return undefined;
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDownloadFile(file: FileItem) {
    try {
      const downloaded = await downloadFile(apiBaseUrl, file.id);
      const objectUrl = URL.createObjectURL(downloaded.blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = downloaded.filename;
      link.rel = 'noreferrer';
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      }
    } catch (downloadError) {
      eventStreamErrorVisibleRef.current = false;
      setError(downloadError instanceof Error ? downloadError.message : '文件下载失败');
    }
  }

  async function runAgentWorkbenchAction(label: string, request: AgentRunRequest): Promise<AgentRunResult | undefined> {
    const runId = agentRunSequenceRef.current + 1;
    agentRunSequenceRef.current = runId;
    setBusyAction(label);
    setError(null);
    setAgentTrace(null);
    setAgentTraceStatus('idle');
    eventStreamErrorVisibleRef.current = false;
    try {
      const response = await runAgent(apiBaseUrl, request);
      if (agentRunSequenceRef.current === runId) {
        setAgentResult({ kind: 'agent-run', value: response });
      }
      if (response.runId) {
        loadAgentTraceForRun(runId, response.runId);
      }
      await refreshState();
      return response;
    } catch (actionError) {
      if (agentRunSequenceRef.current === runId) {
        eventStreamErrorVisibleRef.current = false;
        setError(actionError instanceof Error ? actionError.message : '操作失败');
      }
      return undefined;
    } finally {
      if (agentRunSequenceRef.current === runId) {
        setBusyAction(null);
      }
    }
  }

  async function handleSummarize() {
    await runAgentWorkbenchAction('summary', {
        agentId: currentAgentId,
        roomId: selectedRoom.id,
        intent: 'summary',
        userText: quickSummaryPrompt
    });
  }

  async function handleDeadlineQuestion() {
    await runAgentWorkbenchAction('deadline', {
        agentId: currentAgentId,
        roomId: selectedRoom.id,
        intent: 'deadline',
        userText: quickDeadlinePrompt
    });
  }

  async function handleFileShare() {
    await runAgentWorkbenchAction('file-share', {
        agentId: currentAgentId,
        roomId: selectedRoom.id,
        intent: 'share_file',
        userText: defaultFileSharePrompt
    });
  }

  async function handleCoordinate() {
    await runAgentWorkbenchAction('coordination', {
        agentId: currentAgentId,
        roomId: selectedRoom.id,
        intent: 'coordinate',
        userText: defaultCoordinatePrompt
    });
  }

  async function handleFindFile() {
    await runAgentWorkbenchAction('find-file', {
        agentId: currentAgentId,
        roomId: selectedRoom.id,
        intent: 'find_file',
        userText: quickFindFilePrompt
    });
  }

  async function handleAgentChat() {
    const userText = agentPrompt.trim();
    if (!userText) {
      return;
    }
    const inferredIntent = inferWorkbenchIntent(userText);
    const messageBody = inferredIntent === 'send_message' ? extractWorkbenchMessageBody(userText) : undefined;
    await runAgentWorkbenchAction('chat', compactAgentRunRequest({
      agentId: currentAgentId,
      roomId: selectedRoom.id,
      intent: inferredIntent,
      userText,
      messageBody
    }));
  }

  async function handleCheckAiStatus() {
    setBusyAction('ai-status-check');
    setError(null);
    eventStreamErrorVisibleRef.current = false;
    try {
      const response = await checkAiStatus(apiBaseUrl);
      setState((current) => (current ? { ...current, aiStatus: response.aiStatus } : current));
      return response;
    } catch (statusError) {
      eventStreamErrorVisibleRef.current = false;
      setError(statusError instanceof Error ? statusError.message : 'LLM 状态检查失败');
      return undefined;
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRefreshState() {
    setBusyAction('refresh-state');
    setError(null);
    eventStreamErrorVisibleRef.current = false;
    try {
      return await refreshState();
    } catch (refreshError) {
      eventStreamErrorVisibleRef.current = false;
      setError(refreshError instanceof Error ? refreshError.message : '刷新状态失败');
      return undefined;
    } finally {
      setBusyAction(null);
    }
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

  async function handleToggleAutopilot() {
    const currentState = state;
    if (!currentState) {
      return;
    }
    const policy = currentState.agentAutopilotPolicies.find((candidate) => candidate.agentId === currentAgentId);
    const roomEnabled = Boolean(policy?.enabled && policy.allowedRoomIds.includes(selectedRoom.id));
    const nextRoomEnabled = !roomEnabled;
    const remainingRoomCount = policy?.allowedRoomIds.filter((roomId) => roomId !== selectedRoom.id).length ?? 0;
    await runAction('autopilot-policy', async () => {
      return updateAutopilotPolicy(apiBaseUrl, {
        agentId: currentAgentId,
        enabled: nextRoomEnabled ? true : remainingRoomCount > 0 ? policy?.enabled ?? false : false,
        roomId: selectedRoom.id,
        roomEnabled: nextRoomEnabled
      });
    });
  }

  async function handleRunAutopilotWorker() {
    await runAction('autopilot-worker', async () => {
      const response = await runAutopilotWorkerOnce(apiBaseUrl);
      setAutopilotWorker(response.worker);
      setAgentResult({ kind: 'autopilot-run', value: response });
      return response;
    });
  }

  return (
    <Tooltip.Provider delayDuration={260} skipDelayDuration={100}>
      <main className="app-shell">
        <Sidebar
          currentUserName={currentUser.name}
          allRooms={state.rooms}
          rooms={filteredRooms}
          roomSearch={roomSearch}
          roomFilter={roomFilter}
          selectedRoomId={selectedRoom.id}
          onFilterChange={setRoomFilter}
          onSearchChange={setRoomSearch}
          onSelectRoom={setSelectedRoomId}
        />
        <ChatPanel
          room={selectedRoom}
          messages={roomMessages}
          sourceMessages={state.messages}
          files={state.files}
          tasks={roomTasks}
          calendar={state.calendar}
          users={state.users}
          aiStatus={state.aiStatus}
          composer={composer}
          busyAction={busyAction}
          onComposerChange={setComposer}
          onSend={handleSendMessage}
          onFileUpload={handleUploadFile}
          onDownloadFile={handleDownloadFile}
          onSummarize={handleSummarize}
          onRefreshTasks={handleRefreshState}
        />
        <AgentWorkbench
          agent={currentAgent}
          selectedRoom={selectedRoom}
          prompt={agentPrompt}
          error={error}
          busyAction={busyAction}
          result={agentResult}
          trace={agentTrace}
          traceStatus={agentTraceStatus}
          aiStatus={state.aiStatus}
          actions={state.actionRequests}
          a2aSessions={state.a2aSessions}
          autopilotPolicies={state.agentAutopilotPolicies}
          autopilotWorker={autopilotWorker}
          selectedRoomId={selectedRoom.id}
          sourceMessages={state.messages}
          sourceFiles={state.files}
          onPromptChange={setAgentPrompt}
          onAgentChat={handleAgentChat}
          onSummarize={handleSummarize}
          onDeadlineQuestion={handleDeadlineQuestion}
          onFindFile={handleFindFile}
          onFileShare={handleFileShare}
          onCoordinate={handleCoordinate}
          onConfirmAction={handleConfirmAgentAction}
          onRejectAction={handleRejectAgentAction}
          onToggleAutopilot={handleToggleAutopilot}
          onRunAutopilotWorker={handleRunAutopilotWorker}
        />
      </main>
    </Tooltip.Provider>
  );
}

function Sidebar(props: {
  currentUserName: string;
  allRooms: DemoState['rooms'];
  rooms: DemoState['rooms'];
  roomSearch: string;
  roomFilter: RoomFilter;
  selectedRoomId: string;
  onFilterChange: (filter: RoomFilter) => void;
  onSearchChange: (value: string) => void;
  onSelectRoom: (roomId: string) => void;
}) {
  const countableRooms = filterRooms(props.allRooms, props.roomSearch, 'all');
  const groupCount = countableRooms.filter((room) => room.type !== 'direct').length;
  const directCount = countableRooms.filter((room) => room.type === 'direct').length;

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark">A</div>
        <div>
          <h1>Agent IM</h1>
          <p>AI Agent 协作工作台</p>
        </div>
      </div>

      <div className="profile-panel">
        <div className="avatar">LW</div>
        <div>
          <strong>{props.currentUserName}</strong>
          <span><i /> 在线 | 个人 Agent</span>
        </div>
        <ChevronRight size={16} />
      </div>

      <label className="room-search">
        <Search size={16} />
        <input
          aria-label="search rooms"
          placeholder="搜索会话"
          value={props.roomSearch}
          onChange={(event) => props.onSearchChange(event.target.value)}
        />
      </label>

      <div className="room-tabs" aria-label="room filters">
        <button className={props.roomFilter === 'all' ? 'is-active' : ''} type="button" onClick={() => props.onFilterChange('all')}>全部</button>
        <button className={props.roomFilter === 'group' ? 'is-active' : ''} type="button" onClick={() => props.onFilterChange('group')}>群聊 {groupCount}</button>
        <button className={props.roomFilter === 'direct' ? 'is-active' : ''} type="button" onClick={() => props.onFilterChange('direct')}>私聊 {directCount}</button>
      </div>

      <nav className="room-list" aria-label="rooms">
        {props.rooms.length > 0 ? (
          props.rooms.map((room) => (
            <motion.button
              aria-label={room.name}
              className={`room-button ${room.id === props.selectedRoomId ? 'is-active' : ''}`}
              key={room.id}
              onClick={() => props.onSelectRoom(room.id)}
              type="button"
              whileHover={{ x: 3 }}
              whileTap={{ scale: 0.985 }}
              transition={{ duration: 0.16 }}
            >
              <span className="room-icon">
                {room.type === 'direct' ? <Bot size={16} /> : <MessageSquare size={16} />}
              </span>
              <span className="room-meta">
                <strong>{room.name}</strong>
                <small>{room.matrixAlias}</small>
              </span>
              {room.unreadCount > 0 ? <em>{room.unreadCount}</em> : null}
            </motion.button>
          ))
        ) : (
          <div className="room-empty">没有匹配的会话</div>
        )}
      </nav>

      <div className="protocol-panel">
        <ShieldCheck size={18} />
        <div>
          <strong>风险评估</strong>
          <span>主 Agent + risk-mini-v1</span>
          <b>低风险</b>
        </div>
      </div>
    </aside>
  );
}

function ChatPanel(props: {
  room: DemoState['rooms'][number];
  messages: Message[];
  sourceMessages: Message[];
  files: FileItem[];
  tasks: TaskItem[];
  calendar: CalendarItem[];
  users: DemoState['users'];
  aiStatus?: AiRuntimeStatus;
  composer: string;
  busyAction: string | null;
  onComposerChange: (value: string) => void;
  onSend: () => void;
  onFileUpload: (file: File) => void;
  onDownloadFile: (file: FileItem) => void;
  onSummarize: () => void;
  onRefreshTasks: () => void;
}) {
  const [activeTab, setActiveTab] = useState<RoomContentTab>('chat');
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const roomFilesById = useMemo(() => new Map(props.files.map((file) => [file.id, file])), [props.files]);
  const roomFiles = props.files.filter((file) => file.roomId === props.room.id);
  const roomCalendar = props.calendar.filter((item) => item.roomId === props.room.id);
  const roomMembers = props.room.memberIds
    .map((memberId) => props.users.find((candidate) => candidate.id === memberId))
    .filter((user): user is DemoState['users'][number] => Boolean(user));
  const tabs: Array<{ id: RoomContentTab; label: string; count: number }> = [
    { id: 'chat', label: '聊天', count: props.messages.length },
    { id: 'tasks', label: '任务', count: props.tasks.length },
    { id: 'files', label: '文件', count: roomFiles.length },
    { id: 'calendar', label: '日程', count: roomCalendar.length },
    { id: 'members', label: '成员', count: props.room.memberIds.length }
  ];

  useEffect(() => {
    setActiveTab('chat');
  }, [props.room.id]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView?.({ block: 'end' });
  }, [props.room.id, props.messages.length]);

  return (
    <section className="chat-panel">
      <header className="chat-header">
        <div className="chat-title-block">
          <div className="chat-title-line">
            <h2>{props.room.name}</h2>
          </div>
          <p>{props.room.matrixAlias} · {props.room.memberIds.length} 成员</p>
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
          <div className="chat-top-actions">
            <button type="button" onClick={props.onSummarize} disabled={Boolean(props.busyAction)}>
              <RefreshCw size={15} />
              <span>总结当前群聊</span>
            </button>
          </div>
        </div>
      </header>

      <div className="room-content-tabs" aria-label="room panels">
        {tabs.map((tab) => (
          <button
            className={activeTab === tab.id ? 'is-active' : ''}
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{tab.label}</span>
            <em>{tab.count}</em>
          </button>
        ))}
      </div>

      {activeTab !== 'chat' ? (
        <motion.div className="room-detail-motion" key={activeTab} {...softAppear}>
          <RoomDetailPanel
            activeTab={activeTab}
            tasks={props.tasks}
            files={roomFiles}
            calendar={roomCalendar}
            members={roomMembers}
            messages={props.sourceMessages}
            users={props.users}
            onDownloadFile={props.onDownloadFile}
            onRefreshTasks={props.onRefreshTasks}
          />
        </motion.div>
      ) : null}

      <div className="message-list">
        {props.messages.map((message) => {
          const attachedFile = message.fileId ? roomFilesById.get(message.fileId) : undefined;
          return (
            <motion.article
              className={`message-row ${message.senderId === currentUserId ? 'is-self' : ''}`}
              key={message.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
            >
              <div className="message-avatar">{message.senderName.slice(0, 2)}</div>
              <div className="message-bubble">
                <div className="message-topline">
                  <strong>{message.senderName}</strong>
                  {message.agentLabel ? <span className="agent-badge">{message.agentLabel}</span> : null}
                  <time>{formatTime(message.sentAt)}</time>
                </div>
                <p>{message.body}</p>
                {message.fileId ? (
                  <FileAttachment file={attachedFile} fallbackName={message.body} onDownload={props.onDownloadFile} />
                ) : null}
              </div>
            </motion.article>
          );
        })}
        <div ref={messageEndRef} />
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
          aria-label="chat composer"
          onChange={(event) => props.onComposerChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              props.onSend();
            }
          }}
          placeholder="输入消息"
          value={props.composer}
        />
        <button type="button" onClick={props.onSend} aria-label="send chat" disabled={props.busyAction === 'send'}>
          <Send size={18} />
        </button>
      </footer>

    </section>
  );
}

function RoomDetailPanel(props: {
  activeTab: Exclude<RoomContentTab, 'chat'>;
  tasks: TaskItem[];
  files: FileItem[];
  calendar: CalendarItem[];
  members: DemoState['users'];
  messages: Message[];
  users: DemoState['users'];
  onDownloadFile: (file: FileItem) => void;
  onRefreshTasks: () => void;
}) {
  if (props.activeTab === 'tasks') {
    return (
      <TaskExtractionPanel
        tasks={props.tasks}
        messages={props.messages}
        users={props.users}
        onRefresh={props.onRefreshTasks}
      />
    );
  }

  if (props.activeTab === 'files') {
    return <RoomFilesPanel files={props.files} users={props.users} onDownloadFile={props.onDownloadFile} />;
  }

  if (props.activeTab === 'calendar') {
    return <RoomCalendarPanel calendar={props.calendar} />;
  }

  return <RoomMembersPanel members={props.members} />;
}

function RoomFilesPanel(props: { files: FileItem[]; users: DemoState['users']; onDownloadFile: (file: FileItem) => void }) {
  return (
    <section className="room-detail-panel">
      <div className="room-detail-header">
        <div>
          <h3>可用文件 <span>{props.files.length}</span></h3>
          <p>只显示当前会话内 Agent 可见的文件元数据。</p>
        </div>
      </div>
      <div className="detail-list">
        {props.files.length > 0 ? props.files.map((file) => {
          const uploader = props.users.find((user) => user.id === file.uploaderId);
          const downloadable = isDownloadableFile(file);
          return (
            <div className="detail-row" key={file.id}>
              <FileText size={16} />
              <div>
                <strong>{file.name}</strong>
                <span>
                  {uploader?.name ?? file.uploaderId} · {formatTime(file.updatedAt)} · {downloadable ? '可下载' : '仅元数据'}
                </span>
              </div>
              {downloadable ? (
                <a
                  href="#"
                  download={file.name}
                  aria-label={`download ${file.name}`}
                  onClick={(event) => {
                    event.preventDefault();
                    props.onDownloadFile(file);
                  }}
                >
                  <Download size={15} />
                </a>
              ) : null}
            </div>
          );
        }) : (
          <div className="detail-empty">当前会话还没有可用文件。</div>
        )}
      </div>
    </section>
  );
}

function RoomCalendarPanel(props: { calendar: CalendarItem[] }) {
  return (
    <section className="room-detail-panel">
      <div className="room-detail-header">
        <div>
          <h3>相关日程 <span>{props.calendar.length}</span></h3>
          <p>来自当前会话的内部日程数据，确认后会实时更新。</p>
        </div>
      </div>
      <div className="detail-list">
        {props.calendar.length > 0 ? props.calendar.map((item) => (
          <div className="detail-row" key={item.id}>
            <Clock3 size={16} />
            <div>
              <strong>{item.title}</strong>
              <span>{formatDateTime(item.startsAt)} · {item.attendees.length} 人参与</span>
            </div>
          </div>
        )) : (
          <div className="detail-empty">当前会话还没有相关日程。</div>
        )}
      </div>
    </section>
  );
}

function RoomMembersPanel(props: { members: DemoState['users'] }) {
  return (
    <section className="room-detail-panel">
      <div className="room-detail-header">
        <div>
          <h3>成员 <span>{props.members.length}</span></h3>
          <p>当前会话成员和在线状态。</p>
        </div>
      </div>
      <div className="member-detail-grid">
        {props.members.map((member) => (
          <div className="member-detail" key={member.id}>
            <i>{member.avatar}</i>
            <div>
              <strong>{member.name}</strong>
              <span>{member.status === 'online' ? '在线' : '离线'}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function TaskExtractionPanel(props: {
  tasks: TaskItem[];
  messages: Message[];
  users: DemoState['users'];
  onRefresh: () => void;
}) {
  const taskRows = props.tasks.slice(0, 5);
  const sourceMessages = taskRows
    .map((task) => props.messages.find((message) => message.id === task.sourceMessageId))
    .filter((message): message is Message => Boolean(message));
  const latestSource = sortMessagesChronologically(sourceMessages).at(-1);
  return (
    <section className="task-extraction-panel">
      <div className="task-extraction-header">
        <div>
          <h3>从当前对话中提取的任务 <span>{props.tasks.length}</span></h3>
          <p>
            {latestSource ? `最近来源 ${formatTime(latestSource.sentAt)}` : '当前对话暂无结构化任务'} · 基于 {sourceMessages.length} 条来源消息
          </p>
        </div>
        <button type="button" onClick={props.onRefresh}>
          <RefreshCw size={15} />
          <span>刷新状态</span>
        </button>
      </div>
      <div className="task-table" role="table" aria-label="extracted tasks">
        <div className="task-table-row is-head" role="row">
          <span>任务</span>
          <span>负责人</span>
          <span>截止时间</span>
          <span>状态</span>
          <span>来源消息</span>
        </div>
        {taskRows.length > 0 ? taskRows.map((task) => {
          const source = props.messages.find((message) => message.id === task.sourceMessageId);
          const owner = props.users.find((user) => task.owners.includes(user.name));
          return (
            <div className="task-table-row" role="row" key={task.id}>
              <span className="task-name">
                <span className={`task-source-dot ${task.status}`} />
                {task.title}
              </span>
              <span>
                <UserChip user={owner} fallback={task.owners.join('、')} />
              </span>
              <span>{task.deadline}</span>
              <span><StatusPill status={task.status} /></span>
              <span>{source ? `${formatTime(source.sentAt)} ${source.senderName}` : task.sourceMessageId}</span>
            </div>
          );
        }) : (
          <div className="task-table-empty">这个对话还没有可追溯的结构化任务。</div>
        )}
      </div>
    </section>
  );
}

function UserChip({ user, fallback }: { user?: DemoState['users'][number]; fallback: string }) {
  return (
    <span className="user-chip">
      <i>{user?.avatar ?? fallback.slice(0, 2)}</i>
      {user?.name ?? fallback}
    </span>
  );
}

function StatusPill({ status }: { status: TaskItem['status'] }) {
  const labels: Record<TaskItem['status'], string> = {
    pending: '待完成',
    in_progress: '进行中',
    done: '已完成'
  };
  return (
    <span className={`task-status ${status}`}>
      <b />
      {labels[status]}
    </span>
  );
}

function FileAttachment(props: { file?: FileItem; fallbackName: string; onDownload: (file: FileItem) => void }) {
  const label = props.file?.name ?? props.fallbackName;
  const file = props.file;
  if (isDownloadableFile(file)) {
    return (
      <a
        className="file-chip"
        href="#"
        download={file.name}
        onClick={(event) => {
          event.preventDefault();
          props.onDownload(file);
        }}
      >
        <FileText size={16} />
        <span>{label}</span>
        <Download size={14} />
      </a>
    );
  }

  return (
    <div className="file-chip is-unavailable" title="文件没有可下载的 Matrix 或本地媒体备份，暂不能下载">
      <FileText size={16} />
      <span>{label}</span>
    </div>
  );
}

function isDownloadableFile(file: FileItem | undefined): file is FileItem {
  return Boolean(file?.mxcUri || file?.localPath);
}

function AgentWorkbench(props: {
  agent: DemoState['agents'][number];
  selectedRoom: DemoState['rooms'][number];
  prompt: string;
  error: string | null;
  busyAction: string | null;
  result: AgentResult | null;
  trace: AgentTrace | null;
  traceStatus: AgentTraceLoadStatus;
  aiStatus?: AiRuntimeStatus;
  actions: AgentActionRequest[];
  a2aSessions: DemoState['a2aSessions'];
  autopilotPolicies: DemoState['agentAutopilotPolicies'];
  autopilotWorker: AutopilotWorkerStatus | null;
  selectedRoomId: string;
  sourceMessages: Message[];
  sourceFiles: FileItem[];
  onPromptChange: (value: string) => void;
  onAgentChat: () => void;
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

  return (
    <aside className="agent-workbench">
      <header className="agent-header">
        <div className="agent-orb">
          <Bot size={22} />
        </div>
        <div>
          <h2>我的 Agent</h2>
          <p>{props.agent.displayName}</p>
        </div>
        <span className={`ai-status-pill ${aiStatus.kind}`}>{aiStatus.label}</span>
      </header>

      <div className="agent-output-area">
        {props.error ? (
          <motion.div className="error-banner" key="agent-error" {...softAppear}>
            {props.error}
          </motion.div>
        ) : null}
        <AgentBusyPanel busyAction={props.busyAction} />
        <AnimatePresence mode="popLayout">
          {props.result ? (
            <motion.div className="agent-result-motion" key={resultKey} {...softAppear}>
              <ResultPanel
                result={props.result}
                sourceMessages={props.sourceMessages}
                sourceFiles={props.sourceFiles}
              />
            </motion.div>
          ) : (
            <motion.div className="agent-output-placeholder" key="empty-agent-result" aria-hidden="true" />
          )}
        </AnimatePresence>

        {props.result?.kind === 'agent-run' && (props.trace || props.traceStatus !== 'idle') ? (
          <AgentTracePanel
            trace={props.trace}
            traceStatus={props.traceStatus}
            timelineItems={timelineItems}
            permissionItems={permissionItems}
          />
        ) : null}

        {pendingActions.length > 0 ? (
          <section className="data-section confirmation-section">
            <div className="section-title">
              <AlertTriangle size={17} />
              <h3>待确认动作</h3>
            </div>
            <div className="confirmation-list">
              {pendingActions.map((action) => (
                <motion.div className="confirmation-row" key={action.id} layout {...softAppear}>
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
                  <motion.div className={`compact-row a2a-row status-${session.status}`} key={session.id} layout {...softAppear}>
                    <strong>
                      <span>{a2aStatusLabel(session.status)}</span>
                      <em>{session.risk.level}</em>
                    </strong>
                    <span>{session.goal}</span>
                    {latestTurn ? <small>{latestTurn.message}</small> : null}
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
        <div className="action-grid">
          <ActionButton icon={<PanelRightOpen size={17} />} label="总结群聊" onClick={props.onSummarize} disabled={props.busyAction === 'summary'} />
          <ActionButton icon={<Clock3 size={17} />} label="问截止" onClick={props.onDeadlineQuestion} disabled={props.busyAction === 'deadline'} />
          <ActionButton icon={<Search size={17} />} label="Agent 找文件" onClick={props.onFindFile} disabled={props.busyAction === 'find-file'} />
          <ActionButton icon={<FileText size={17} />} label="请求代发" onClick={props.onFileShare} disabled={props.busyAction === 'file-share'} />
          <ActionButton icon={<Users size={17} />} label="Agent 协调" onClick={props.onCoordinate} disabled={props.busyAction === 'coordination'} />
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

        <div className="agent-query">
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
    </aside>
  );
}

function AgentTracePanel(props: {
  trace: AgentTrace | null;
  traceStatus: AgentTraceLoadStatus;
  timelineItems: AgentTimelineItem[];
  permissionItems: PermissionCenterItem[];
}) {
  if (props.traceStatus === 'loading') {
    return (
      <section className="data-section agent-trace-section" data-testid="agent-trace-panel">
        <div className="section-title">
          <ClipboardList size={17} />
          <h3>Agent Timeline</h3>
        </div>
        <div className="compact-list agent-timeline-list">
          <div className="compact-row trace-row tone-neutral">
            <strong>Loading trace</strong>
            <span>Waiting for replay data</span>
          </div>
        </div>
      </section>
    );
  }

  if (props.traceStatus === 'unavailable') {
    return (
      <section className="data-section agent-trace-section" data-testid="agent-trace-panel">
        <div className="section-title">
          <ClipboardList size={17} />
          <h3>Agent Timeline</h3>
        </div>
        <div className="compact-list agent-timeline-list">
          <div className="compact-row trace-row tone-warning">
            <strong>Trace unavailable</strong>
            <span>Run result is available, but replay data could not be loaded.</span>
          </div>
        </div>
      </section>
    );
  }

  if (!props.trace) {
    return null;
  }

  return (
    <section className="data-section agent-trace-section" data-testid="agent-trace-panel">
      <div className="section-title">
        <ClipboardList size={17} />
        <h3>Agent Timeline</h3>
      </div>
      <div className="compact-list agent-timeline-list">
        <div className="trace-summary-row">
          <strong>{props.trace.status}</strong>
          <span>
            {props.trace.eventCount} events
            {props.trace.toolCalls.length > 0 ? ` | ${props.trace.toolCalls.join(', ')}` : ''}
          </span>
        </div>
        {props.timelineItems.slice(-8).map((item) => (
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

      <div className="section-title permission-title">
        <ShieldCheck size={17} />
        <h3>Permission Center</h3>
      </div>
      <div className="compact-list permission-center-list">
        {props.permissionItems.length > 0 ? (
          props.permissionItems.map((item) => (
            <div className={`compact-row permission-row outcome-${item.outcome}`} key={item.id}>
              <strong>
                <span>{item.label}</span>
                {item.riskLevel ? <em>{item.riskLevel}</em> : null}
              </strong>
              <span>
                {item.toolName}
                {item.requiredPermissions.length > 0 ? ` | ${item.requiredPermissions.join(', ')}` : ''}
                {item.requiresHuman ? ' | human review' : ' | policy auto'}
              </span>
              <small>
                {formatTime(item.timestamp)}
                {item.reason ? ` | ${item.reason}` : ''}
              </small>
            </div>
          ))
        ) : (
          <div className="compact-row permission-row outcome-allow">
            <strong>No permission decision</strong>
          </div>
        )}
      </div>
    </section>
  );
}

function AgentBusyPanel({ busyAction }: { busyAction: string | null }) {
  if (!busyAction) {
    return null;
  }
  return (
    <section className="agent-busy-panel" role="status" aria-live="polite">
      <RefreshCw size={16} />
      <div>
        <strong>正在执行</strong>
        <span>{busyActionLabel(busyAction)}</span>
      </div>
    </section>
  );
}

function AgentScopePanel(props: {
  agent: DemoState['agents'][number];
  rooms: DemoState['rooms'];
  selectedRoom: DemoState['rooms'][number];
  pendingCount: number;
}) {
  const readableRooms = props.rooms.filter((room) => props.agent.allowedRoomIds.includes(room.id));
  return (
    <section className="agent-card">
      <div className="agent-card-grid">
        <span>当前对话</span>
        <strong>{props.selectedRoom.name}</strong>
        <span>可读范围</span>
        <strong>{readableRooms.map((room) => room.name).join('、') || '无'}</strong>
        <span>可用工具</span>
        <strong>{props.agent.allowedToolIds.map(toolIdLabel).join('、') || '只读问答'}</strong>
        <span>待确认</span>
        <strong>{props.pendingCount} 个</strong>
      </div>
    </section>
  );
}

function RuntimeStepsPanel(props: {
  busyAction: string | null;
  logs: AgentActionLog[];
  progressEvents: AgentProgressEvent[];
}) {
  const latestProgress = props.progressEvents.at(-1);
  const hasTerminalProgress = latestProgress?.phase === 'completed' || latestProgress?.phase === 'failed';
  const showBusyAction = Boolean(props.busyAction && !hasTerminalProgress);

  return (
    <section className="data-section runtime-section">
      {props.progressEvents.length > 0 ? (
        <>
          <div className="section-title">
            <RefreshCw size={17} />
            <h3>实时步骤</h3>
          </div>
          <div className="compact-list runtime-progress-list">
            {props.progressEvents.map((event) => (
              <div className={`compact-row progress-${event.phase}`} key={event.id}>
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
          </div>
        </>
      ) : null}
      <div className="section-title">
        <ShieldCheck size={17} />
        <h3>运行记录</h3>
      </div>
      <div className="compact-list">
        {showBusyAction ? (
          <div className="compact-row is-running">
            <strong>执行中</strong>
            <span>{busyActionLabel(props.busyAction ?? '')}</span>
          </div>
        ) : null}
        {props.logs.length > 0 ? (
          props.logs.map((log) => (
            <div className="compact-row" key={log.id}>
              <strong>{log.action}</strong>
              <span>{formatLogStatus(log)} · {log.toolCalls.join(' → ') || '未调用工具'} · {formatTime(log.createdAt)}</span>
            </div>
          ))
        ) : (
          <div className="compact-row is-empty">
            <strong>暂无记录</strong>
            <span>当前对话还没有 Agent 工具执行记录。</span>
          </div>
        )}
      </div>
    </section>
  );
}

function AutoReplyStatusPanel(props: {
  autoreplyPolicies: AiAutoreplyPolicy[];
  aiReplyJobs: AiReplyJob[];
  selectedRoomId: string;
  users: DemoState['users'];
}) {
  const policies = props.autoreplyPolicies
    .filter((policy) => policy.allowedRoomIds.includes(props.selectedRoomId))
    .sort((a, b) => a.priority - b.priority);

  if (policies.length === 0) {
    return null;
  }

  return (
    <section className="data-section">
      <div className="section-title">
        <Sparkles size={17} />
        <h3>自动回复状态</h3>
      </div>
      <div className="compact-list">
        {policies.map((policy) => {
          const user = props.users.find((candidate) => candidate.id === policy.userId);
          const latestJob = props.aiReplyJobs.find(
            (job) => job.targetUserId === policy.userId && job.roomId === props.selectedRoomId
          );
          return (
            <div className="compact-row" key={policy.userId}>
              <strong>{user?.name ?? policy.userId}</strong>
              <span>
                {policy.enabled ? '开启' : '关闭'} · {policy.triggerMode === 'all_messages' ? '任何消息' : '仅被提及'} ·{' '}
                {latestJob ? formatAiReplyJobStatus(latestJob) : '等待新消息'}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EvidencePanel(props: {
  result: AgentResult | null;
  sourceMessages: Message[];
  sourceFiles: FileItem[];
  sourceMemories: MemoryItem[];
  actions: AgentActionRequest[];
  logs: AgentActionLog[];
}) {
  const ids = getEvidenceIds(props.result, props.logs).slice(0, 5);
  if (ids.length === 0) {
    return null;
  }

  return (
    <section className="data-section evidence-section">
      <div className="section-title">
        <ClipboardList size={17} />
        <h3>判断依据</h3>
      </div>
      <ul className="evidence-list">
        {ids.map((id) => (
          <li key={id}>{formatCitation(id, props.sourceMessages, props.sourceFiles, props.sourceMemories, props.actions)}</li>
        ))}
      </ul>
    </section>
  );
}

function SystemStatusPanel(props: {
  aiStatus?: AiRuntimeStatus;
  derived: { kind: 'connected' | 'fallback' | 'failed'; label: string };
  eventStreamStatus: EventStreamStatus;
  onCheck: () => void;
  busy: boolean;
}) {
  const cacheRate = props.aiStatus?.cache ? Math.round(props.aiStatus.cache.promptCacheHitRate * 100) : 0;
  const streamClass = props.eventStreamStatus === 'disconnected' ? 'bad' : props.eventStreamStatus === 'connected' ? 'good' : '';
  const streamLabel =
    props.eventStreamStatus === 'disconnected'
      ? '断开'
      : props.eventStreamStatus === 'connected'
        ? '可用'
        : '连接中';
  const checkedAt = props.aiStatus?.lastCheckedAt ? formatTime(props.aiStatus.lastCheckedAt) : '未完成';
  return (
    <section className="data-section system-section">
      <div className="section-title">
        <ShieldCheck size={17} />
        <h3>系统状态</h3>
      </div>
      <dl className="status-grid">
        <dt>实时连接</dt>
        <dd className={streamClass}>{streamLabel}</dd>
        <dt>模型检查</dt>
        <dd>{checkedAt}</dd>
        <dt>缓存命中率</dt>
        <dd>{cacheRate}%</dd>
        <dt>模型</dt>
        <dd>{props.aiStatus?.agentModel ?? 'fallback'}</dd>
      </dl>
      <button className="status-check-button" type="button" onClick={props.onCheck} disabled={props.busy}>
        <RefreshCw size={15} />
        <span>检查 LLM</span>
      </button>
    </section>
  );
}

function ActionButton(props: { icon: ReactNode; label: string; onClick: () => void; disabled: boolean }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <motion.button
          className="action-button"
          onClick={props.onClick}
          type="button"
          disabled={props.disabled}
          whileHover={{ y: -2 }}
          whileTap={{ scale: 0.98 }}
          transition={{ duration: 0.14 }}
        >
          {props.icon}
          <span>{props.label}</span>
          <ChevronRight size={15} />
        </motion.button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" side="top" align="center" sideOffset={8}>
          {props.label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
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

function getAgentResultKey(result: AgentResult): string {
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
        <PlanLine plan={result.plan} reasoning={result.reasoning} />
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
    return (
      <section className="result-panel">
        <div className="result-heading">
          <CheckCircle2 size={18} />
          <h3>{title}</h3>
        </div>
        <PlanLine plan={result.plan} reasoning={result.reasoning} />
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
    return (
      <section className="result-panel">
        <div className="result-heading">
          <Search size={18} />
          <h3>{title}</h3>
        </div>
        <PlanLine plan={result.plan} reasoning={result.reasoning} />
        <FinalAnswer>
          <p>{structured.answer}</p>
        </FinalAnswer>
        <CitationRow citations={structured.citations} sourceMessages={sourceMessages} sourceFiles={sourceFiles} />
        <RiskLine riskLevel={result.log.risk.level} reason={result.log.risk.reason} />
      </section>
    );
  }

  if (isWebSearchAnswer(structured)) {
    return (
      <section className="result-panel">
        <div className="result-heading">
          <Search size={18} />
          <h3>{title}</h3>
        </div>
        <PlanLine plan={result.plan} reasoning={result.reasoning} />
        <FinalAnswer>
          <p>{structured.answer}</p>
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
    return (
      <section className="result-panel">
        <div className="result-heading">
          <FileText size={18} />
          <h3>{title}</h3>
        </div>
        <PlanLine plan={result.plan} reasoning={result.reasoning} />
        <FinalAnswer>
          <p>{structured.file?.name ?? '没有可自动代发的授权文件'}</p>
        </FinalAnswer>
        <RiskLine riskLevel={structured.risk.level} reason={structured.risk.reason} />
      </section>
    );
  }

  if (isSendMessageAction(structured)) {
    return (
      <section className="result-panel">
        <div className="result-heading">
          <Send size={18} />
          <h3>{title}</h3>
        </div>
        <PlanLine plan={result.plan} reasoning={result.reasoning} />
        <FinalAnswer>
          <p>{structured.status === 'executed' ? `已代发：${structured.messageBody}` : `未自动发送：${structured.messageBody}`}</p>
        </FinalAnswer>
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
        <PlanLine plan={result.plan} reasoning={result.reasoning} />
        <FinalAnswer>
          <p>{structured.proposedPlan}</p>
        </FinalAnswer>
        <RiskLine riskLevel={structured.risk.level} reason={structured.risk.reason} />
      </section>
    );
  }

  if (isChatResult(structured)) {
    return (
      <section className="result-panel">
        <div className="result-heading">
          <MessageSquare size={18} />
          <h3>{title}</h3>
        </div>
        <PlanLine plan={result.plan} reasoning={result.reasoning} />
        <FinalAnswer>
          <p>{structured.reply}</p>
        </FinalAnswer>
        <RiskLine riskLevel={result.log.risk.level} reason={result.log.risk.reason} />
      </section>
    );
  }

  return (
    <section className="result-panel">
      <div className="result-heading">
        <Bot size={18} />
        <h3>{title}</h3>
      </div>
      <PlanLine plan={result.plan} reasoning={result.reasoning} />
      <FinalAnswer>
        <p>{result.requiresHuman ? '需要人工确认。' : 'Agent 已完成工具调用。'}</p>
      </FinalAnswer>
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
    send_message: 'Agent 代发消息',
    coordinate: 'Agent 协调',
    task_update_suggest: '任务更新建议',
    web_search: 'Agent 搜索',
    chat: 'Agent 对话'
  };
  return titles[intent];
}

function PlanLine({ plan, reasoning }: { plan?: string; reasoning?: string }) {
  const thought = compactPlanLine(plan);
  return thought ? (
    <div className="agent-thought">
      <strong>处理方式</strong>
      <p>{thought}</p>
    </div>
  ) : null;
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

function FinalAnswer({ children }: { children: ReactNode }) {
  return (
    <div className="agent-final">
      <strong>最终回答</strong>
      <div>{children}</div>
    </div>
  );
}

function isRoomSummary(value: AgentRunResult['result']): value is RoomSummary {
  return Boolean(value && 'headline' in value && 'todos' in value);
}

function isDeadlineAnswer(value: AgentRunResult['result']): value is DeadlineAnswer {
  return Boolean(value && 'answer' in value && 'citations' in value && !('results' in value));
}

function isWebSearchAnswer(value: AgentRunResult['result']): value is WebSearchAnswer {
  return Boolean(value && 'answer' in value && 'results' in value && 'citations' in value);
}

function isFileShareAction(value: AgentRunResult['result']): value is FileShareAction {
  return Boolean(value && 'file' in value && 'risk' in value && !('proposedPlan' in value));
}

function isSendMessageAction(value: AgentRunResult['result']): value is SendMessageAction {
  return Boolean(value && 'messageBody' in value && 'targetRoomId' in value && 'risk' in value);
}

function isCoordinationResult(value: AgentRunResult['result']): value is CoordinationResult {
  return Boolean(value && 'proposedPlan' in value);
}

function isChatResult(value: AgentRunResult['result']): value is ChatResult {
  return Boolean(value && 'reply' in value);
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
    send_message: '消息代发',
    coordinate: 'Agent 协调',
    task_update: '任务更新',
    calendar_update: '日程更新',
    task_update_suggest: '任务更新建议'
  };
  return labels[kind];
}

function a2aStatusLabel(status: DemoState['a2aSessions'][number]['status']) {
  const labels: Record<DemoState['a2aSessions'][number]['status'], string> = {
    active: '进行中',
    completed: '已完成',
    needs_confirmation: '待确认',
    blocked: '已阻止'
  };
  return labels[status];
}

function formatAiReplyJobStatus(job: AiReplyJob) {
  if (job.status === 'completed') {
    return `已回复 ${job.replyMessageId ?? ''}`.trim();
  }
  if (job.status === 'skipped') {
    return `未生成回复 · ${job.reason}`;
  }
  if (job.status === 'failed') {
    return `失败 · ${job.reason}`;
  }
  return `生成中 · ${job.reason}`;
}

function deriveAiStatus(
  result: AgentResult | null,
  globalStatus?: AiRuntimeStatus
): { kind: 'connected' | 'fallback' | 'failed'; label: string } {
  if (globalStatus?.configured) {
    const model = globalStatus.agentModel ? ` · ${globalStatus.agentModel}` : '';
    const cache = formatAiCacheLabel(globalStatus);
    if (globalStatus.health === 'failed') {
      return { kind: 'failed', label: 'LLM failed, fallback used' };
    }
    if (globalStatus.health === 'unknown') {
      return { kind: 'fallback', label: `LLM configured, not checked${cache}` };
    }
    return { kind: 'connected', label: `LLM connected${model}${cache}` };
  }
  if (globalStatus && !globalStatus.configured) {
    return { kind: 'fallback', label: 'LLM missing, fallback active' };
  }
  if (result?.kind !== 'agent-run') {
    return { kind: 'fallback', label: 'LLM missing, fallback active' };
  }
  const toolCalls = result.value.log.toolCalls;
  if (toolCalls.includes('fallback.local_context') && toolCalls.some((tool) => tool.includes('deepseek'))) {
    return { kind: 'failed', label: 'LLM failed, fallback used' };
  }
  if (toolCalls.some((tool) => tool.includes('deepseek'))) {
    return { kind: 'connected', label: 'LLM connected' };
  }
  return { kind: 'fallback', label: 'LLM missing, fallback active' };
}

function formatAiCacheLabel(status: AiRuntimeStatus): string {
  const cache = status.cache;
  if (!cache || cache.requestCount <= 0) {
    return '';
  }
  return ` | cache ${Math.round(cache.promptCacheHitRate * 100)}%`;
}

function filterRooms(rooms: DemoState['rooms'], search: string, filter: RoomFilter): DemoState['rooms'] {
  const query = search.trim().toLowerCase();
  return rooms.filter((room) => {
    const matchesFilter =
      filter === 'all' ||
      (filter === 'group' && room.type !== 'direct') ||
      (filter === 'direct' && room.type === 'direct');
    const matchesSearch =
      !query ||
      room.name.toLowerCase().includes(query) ||
      room.matrixAlias.toLowerCase().includes(query);
    return matchesFilter && matchesSearch;
  });
}

function getTasksForRoom(state: DemoState, roomId: string): TaskItem[] {
  const selectedRoom = state.rooms.find((room) => room.id === roomId);
  return state.tasks.filter((task) => {
    const source = state.messages.find((message) => message.id === task.sourceMessageId);
    if (!source) {
      return false;
    }
    if (source.roomId === roomId) {
      return true;
    }
    return selectedRoom?.type === 'team' && source.roomId === 'room-class';
  });
}

function toolIdLabel(toolId: string): string {
  const labels: Record<string, string> = {
    room_search: '读群聊',
    file_share: '文件代发',
    message_send: '消息代发',
    task_update: '任务更新',
    calendar_suggest: '日程建议'
  };
  return labels[toolId] ?? toolId;
}

function compactAgentRunRequest(input: AgentRunRequest): AgentRunRequest {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== '')
  ) as AgentRunRequest;
}

function inferWorkbenchIntent(text: string): AgentRunIntent | undefined {
  const lowered = text.toLowerCase();
  if (
    includesAnyText(text, ['能代谁', '可以代谁', '你是谁', '你的权限', '能做什么']) ||
    includesAnyText(lowered, ['who can you act for', 'what can you do'])
  ) {
    return undefined;
  }
  const asksFileShare = includesAnyText(text, ['发文件', '代发', '转发', '分享', '发一下', '发给']) &&
    includesAnyText(text, ['文件', '演示稿', '行动计划', '材料', '图片', '海报']);
  if (asksFileShare || includesAnyText(lowered, ['share file', 'send file', 'send the deck', 'send slides'])) {
    return 'share_file';
  }

  const asksMessageSend =
    includesAnyText(text, ['发消息', '发送消息', '帮我发', '代我发', '告诉', '通知', '转告']) ||
    includesAnyText(lowered, ['send a message', 'send message', 'tell ', 'notify ']);
  if (asksMessageSend) {
    return 'send_message';
  }

  return undefined;
}

function extractWorkbenchMessageBody(text: string): string {
  const explicit = text.match(/(?:发消息|发送消息|帮我发|代我发|告诉|通知|转告|send(?: a)? message|tell|notify)[^:：，,。]*[:：,，]\s*(.+)$/i);
  const say = text.match(/(?:说|内容是)\s*[“"']?(.+?)[”"']?$/);
  return (explicit?.[1] ?? say?.[1] ?? text).trim();
}

function includesAnyText(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
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

function agentProgressPhaseOrder(phase: AgentProgressEvent['phase']): number {
  const order: Record<AgentProgressEvent['phase'], number> = {
    started: 0,
    planning: 1,
    executing: 2,
    completed: 3,
    failed: 4
  };
  return order[phase];
}

function formatCitation(
  citation: string,
  messages: Message[],
  files: FileItem[],
  memories: MemoryItem[] = [],
  actions: AgentActionRequest[] = []
) {
  const message = messages.find((candidate) => candidate.id === citation);
  if (message) {
    return `${message.senderName} ${formatTime(message.sentAt)} 的消息`;
  }

  const file = files.find((candidate) => candidate.id === citation);
  if (file) {
    return file.name;
  }

  const memory = memories.find((candidate) => candidate.id === citation);
  if (memory) {
    return `Agent 记忆：${truncateText(memory.content, 72)}`;
  }

  const action = actions.find((candidate) => candidate.id === citation);
  if (action) {
    return `待确认动作：${agentActionKindLabel(action.kind)} · ${formatActionInput(action)}`;
  }

  if (citation.startsWith('$')) {
    return `Matrix 事件 ${citation.slice(1, 7)}`;
  }

  return citation;
}

function formatActionInput(action: AgentActionRequest): string {
  return truncateText(String(action.input.requestText ?? action.input.proposal ?? action.kind), 56);
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function getEvidenceIds(result: AgentResult | null, logs: AgentActionLog[]): string[] {
  if (result?.kind === 'agent-run') {
    const structured = result.value.result;
    const citations = isDeadlineAnswer(structured) ? structured.citations : [];
    return uniqueStrings([
      ...citations,
      ...result.value.log.contextIds,
      result.value.memory?.id,
      result.value.actionRequest?.id
    ]);
  }
  if (result?.kind === 'deadline') {
    return result.value.citations;
  }
  const latest = logs[0];
  return latest ? latest.contextIds : [];
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

function formatDateTime(value: string) {
  if (!value) {
    return '';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
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

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter(Boolean) as string[])];
}

export default App;
