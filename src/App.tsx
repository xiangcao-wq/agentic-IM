import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  Bot,
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
  Sparkles
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
  type AutopilotWorkerStatus
} from './client/apiClient';
import type {
  AgentActionRequest,
  AgentProgressEvent,
  AgentTrace,
  AgentRunIntent,
  AgentRunRequest,
  AgentRunResult,
  AiRuntimeStatus,
  CalendarItem,
  DemoState,
  FileItem,
  Message,
  TaskItem
} from './domain/types';
import { sortMessagesChronologically } from './domain/messages';
import type { AgentResult } from './components/agent-result-panel';
import { AgentShortcutPopover } from './components/agent-shortcut-popover';
import { ReviewerGuideModal } from './components/reviewer-guide-modal';

const AgentWorkbench = lazy(() =>
  import('./components/agent-console-workbench').then((module) => ({
    default: module.AgentWorkbench
  }))
);

type RoomFilter = 'all' | 'group' | 'direct';
type EventStreamStatus = 'connecting' | 'connected' | 'disconnected';
type RoomContentTab = 'chat' | 'tasks' | 'files' | 'calendar' | 'members';
type AgentTraceLoadStatus = 'idle' | 'loading' | 'ready' | 'unavailable';
type WorkspaceMode = 'im' | 'agent-console';

const apiBaseUrl = import.meta.env.VITE_AGENT_API_BASE ?? '';
const currentUserId = 'user-lin';
const currentAgentId = 'agent-lin';
const eventStreamDisconnectedError = '实时连接已断开；请确认本地 API 服务仍在运行。';
const quickSummaryPrompt = '总结当前群聊：列出关键结论、已确认事项、待办、风险和下一步。';
const quickDeadlinePrompt = '只根据当前聊天、任务和日程回答：这次作业什么时候截止？还有哪些临近时间点？';
const quickFindFilePrompt = '在当前聊天可用文件里查找最新行动计划、演示稿、证据包或引用材料，列出文件名和用途。';
const defaultFileSharePrompt = '把最新行动计划发给陈晨';
const defaultCoordinatePrompt = '把周二 20:30 的合稿检查改到周三 23:00，并确认大家是否同意。';
const reviewerGuideStorageKey = 'agentbridge-review-guide-dismissed';

const softAppear = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
} as const;

function shouldShowReviewerGuide(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }
  try {
    return window.localStorage.getItem(reviewerGuideStorageKey) !== 'true';
  } catch {
    return true;
  }
}

function markReviewerGuideDismissed(): void {
  try {
    window.localStorage.setItem(reviewerGuideStorageKey, 'true');
  } catch {
    // The guide remains dismissible even when storage is unavailable.
  }
}

function App() {
  const [state, setState] = useState<DemoState | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState('room-team');
  const [roomSearch, setRoomSearch] = useState('');
  const [roomFilter, setRoomFilter] = useState<RoomFilter>('all');
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('im');
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
  const [reviewerGuideOpen, setReviewerGuideOpen] = useState(shouldShowReviewerGuide);
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

  function handleCloseReviewerGuide() {
    markReviewerGuideDismissed();
    setReviewerGuideOpen(false);
  }

  function handleOpenReviewerGuide() {
    setReviewerGuideOpen(true);
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
          <h1>正在连接 AgentBridge API</h1>
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
      if (response.runId && response.eventCursor) {
        loadAgentTraceForRun(runId, response.runId);
      }
      await refreshState().catch(() => undefined);
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

  async function runAgentConsoleShortcut(action: () => Promise<void>) {
    setWorkspaceMode('agent-console');
    await action();
  }

  async function handleAgentDraftReply() {
    const userText = composer.trim()
      ? `请根据当前群聊上下文，帮我起草一条适合发送的回复：${composer.trim()}`
      : '请根据当前群聊上下文，帮我起草一条可以直接发送的回复。';
    setAgentPrompt(userText);
    setWorkspaceMode('agent-console');
    await runAgentWorkbenchAction('chat', {
      agentId: currentAgentId,
      roomId: selectedRoom.id,
      userText
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

  async function handleContinueGoalPlan(goalPlanId: string) {
    await runAgentWorkbenchAction('chat', compactAgentRunRequest({
      agentId: currentAgentId,
      roomId: selectedRoom.id,
      userText: '继续',
      goalPlanId
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
      {workspaceMode === 'im' ? (
          <main className="app-shell app-shell-im">
            <Sidebar
              agents={state.agents}
              autopilotPolicies={state.agentAutopilotPolicies}
              currentUserName={currentUser.name}
              allRooms={state.rooms}
              rooms={filteredRooms}
              roomSearch={roomSearch}
              roomFilter={roomFilter}
              selectedRoomId={selectedRoom.id}
              users={state.users}
              onFilterChange={setRoomFilter}
              onOpenAgentConsole={() => setWorkspaceMode('agent-console')}
              onSearchChange={setRoomSearch}
              onOpenGuide={handleOpenReviewerGuide}
              onSelectRoom={setSelectedRoomId}
            />
            <ChatPanel
              room={selectedRoom}
              messages={roomMessages}
              sourceMessages={state.messages}
              agents={state.agents}
              autopilotPolicies={state.agentAutopilotPolicies}
              files={state.files}
              tasks={roomTasks}
              calendar={state.calendar}
              actionRequests={state.actionRequests}
              users={state.users}
              aiStatus={state.aiStatus}
              error={error}
              composer={composer}
              busyAction={busyAction}
              onComposerChange={setComposer}
              onSend={handleSendMessage}
              onFileUpload={handleUploadFile}
              onDownloadFile={handleDownloadFile}
              onSummarize={() => runAgentConsoleShortcut(handleSummarize)}
              onDeadlineQuestion={() => runAgentConsoleShortcut(handleDeadlineQuestion)}
              onFindFile={() => runAgentConsoleShortcut(handleFindFile)}
              onAgentDraftReply={handleAgentDraftReply}
              onOpenAgentConsole={() => setWorkspaceMode('agent-console')}
              onRefreshTasks={handleRefreshState}
            />
          </main>
        ) : (
          <Suspense fallback={<AgentConsoleLoading />}>
            <AgentWorkbench
              agent={currentAgent}
              rooms={filteredRooms}
              allRooms={state.rooms}
              roomSearch={roomSearch}
              roomFilter={roomFilter}
              selectedRoom={selectedRoom}
              prompt={agentPrompt}
              error={error}
              busyAction={busyAction}
              result={agentResult}
              trace={agentTrace}
              traceStatus={agentTraceStatus}
              progressEvents={agentProgressEvents}
              aiStatus={state.aiStatus}
              actions={state.actionRequests}
              logs={state.actionLogs}
              a2aSessions={state.a2aSessions}
              autopilotPolicies={state.agentAutopilotPolicies}
              autopilotWorker={autopilotWorker}
              selectedRoomId={selectedRoom.id}
              sourceMessages={state.messages}
              sourceFiles={state.files}
              onBackToChat={() => setWorkspaceMode('im')}
              onFilterChange={setRoomFilter}
              onSearchChange={setRoomSearch}
              onSelectRoom={setSelectedRoomId}
              onPromptChange={setAgentPrompt}
              onAgentChat={handleAgentChat}
              onContinueGoalPlan={handleContinueGoalPlan}
              onSummarize={handleSummarize}
              onDeadlineQuestion={handleDeadlineQuestion}
              onFindFile={handleFindFile}
              onFileShare={handleFileShare}
              onCoordinate={handleCoordinate}
              onConfirmAction={handleConfirmAgentAction}
              onRejectAction={handleRejectAgentAction}
              onToggleAutopilot={handleToggleAutopilot}
              onRunAutopilotWorker={handleRunAutopilotWorker}
              agents={state.agents}
              users={state.users}
            />
          </Suspense>
        )}
      <ReviewerGuideModal
        agentName={currentAgent.displayName}
        currentUserName={currentUser.name}
        onClose={handleCloseReviewerGuide}
        open={reviewerGuideOpen}
        roomName={selectedRoom.name}
      />
    </Tooltip.Provider>
  );
}

function AgentConsoleLoading() {
  return (
    <main className="agent-console-loading" aria-busy="true" aria-live="polite">
      <div className="agent-console-loading-card">
        <span className="agent-console-loading-orb">
          <Bot size={22} />
        </span>
        <div>
          <strong>正在打开 Agent 操作台</strong>
          <p>正在加载协作流、边界确认和文件上下文。</p>
        </div>
      </div>
    </main>
  );
}

function Sidebar(props: {
  agents: DemoState['agents'];
  autopilotPolicies: DemoState['agentAutopilotPolicies'];
  currentUserName: string;
  allRooms: DemoState['rooms'];
  rooms: DemoState['rooms'];
  roomSearch: string;
  roomFilter: RoomFilter;
  selectedRoomId: string;
  onFilterChange: (filter: RoomFilter) => void;
  onOpenAgentConsole?: () => void;
  onSearchChange: (value: string) => void;
  onOpenGuide: () => void;
  onSelectRoom: (roomId: string) => void;
  users: DemoState['users'];
}) {
  const countableRooms = filterRooms(props.allRooms, props.roomSearch, 'all');
  const groupCount = countableRooms.filter((room) => room.type !== 'direct').length;
  const directCount = countableRooms.filter((room) => room.type === 'direct').length;
  const currentUser = props.users.find((user) => user.id === currentUserId);
  const currentManaged = currentUser ? isUserAssistantManaged(currentUser, props.agents, props.autopilotPolicies, props.selectedRoomId) : false;

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark">A</div>
        <div>
          <h1>AgentBridge</h1>
          <p>A2A 原生聊天空间</p>
        </div>
      </div>

      <div className="profile-panel">
        <div className="avatar">LW</div>
        <div>
          <strong>{props.currentUserName}</strong>
          <span>
            <i className={presenceClass(currentUser?.status ?? 'offline', currentManaged)} />
            {props.currentUserName} · {presenceLabel(currentUser?.status ?? 'offline', currentManaged, { longManaged: true })}
          </span>
        </div>
        <ChevronRight size={16} />
      </div>

      <button className="review-guide-button" type="button" onClick={props.onOpenGuide}>
        <Sparkles size={16} />
        <span>协作指南</span>
      </button>

      {props.onOpenAgentConsole ? (
        <button className="agent-console-entry" type="button" onClick={props.onOpenAgentConsole}>
          <Bot size={16} />
          <span>Agent 操作台</span>
          <ChevronRight size={15} />
        </button>
      ) : null}

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
          props.rooms.map((room) => {
            const roomMembers = membersForRoom(room, props.users);
            return (
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
                  <small>{roomStatusLine(room, roomMembers, props.agents, props.autopilotPolicies)}</small>
                </span>
                {room.unreadCount > 0 ? <em>{room.unreadCount}</em> : null}
              </motion.button>
            );
          })
        ) : (
          <div className="room-empty">没有匹配的会话</div>
        )}
      </nav>

      <div className="protocol-panel">
        <ShieldCheck size={18} />
        <div>
          <strong>权限保护</strong>
          <span>文件、日程和任务变更会先确认</span>
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
  agents: DemoState['agents'];
  autopilotPolicies: DemoState['agentAutopilotPolicies'];
  files: FileItem[];
  tasks: TaskItem[];
  calendar: CalendarItem[];
  actionRequests: AgentActionRequest[];
  users: DemoState['users'];
  aiStatus?: AiRuntimeStatus;
  error: string | null;
  composer: string;
  busyAction: string | null;
  onComposerChange: (value: string) => void;
  onSend: () => void;
  onFileUpload: (file: File) => void;
  onDownloadFile: (file: FileItem) => void;
  onSummarize: () => void;
  onDeadlineQuestion: () => void;
  onFindFile: () => void;
  onAgentDraftReply: () => void;
  onOpenAgentConsole: () => void;
  onRefreshTasks: () => void;
}) {
  const [activeTab, setActiveTab] = useState<RoomContentTab>('chat');
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const roomFilesById = useMemo(() => new Map(props.files.map((file) => [file.id, file])), [props.files]);
  const roomFiles = props.files.filter((file) => file.roomId === props.room.id);
  const roomCalendar = props.calendar.filter((item) => item.roomId === props.room.id);
  const pendingActions = props.actionRequests.filter(
    (action) =>
      action.roomId === props.room.id &&
      action.agentId === currentAgentId &&
      action.status === 'needs_confirmation' &&
      action.requiresHuman
  );
  const primaryPendingAction = pendingActions[0];
  const completedActions = props.actionRequests
    .filter(
      (action) =>
        action.roomId === props.room.id &&
        action.agentId === currentAgentId &&
        action.status === 'executed' &&
        isVisibleCompletedAction(action)
    )
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const primaryCompletedAction = completedActions[0];
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
          <p>
            {props.room.matrixAlias} · {props.room.memberIds.length} 成员 ·{' '}
            {roomPresenceSummary(roomMembers, props.agents, props.autopilotPolicies, props.room.id)}
          </p>
          <div className="presence-strip" aria-label="成员状态">
            {roomMembers.slice(0, 4).map((member) => {
              const managed = isUserAssistantManaged(member, props.agents, props.autopilotPolicies, props.room.id);
              return (
                <span className={presenceClass(member.status, managed)} key={member.id}>
                  <i />
                  {member.name} · {presenceLabel(member.status, managed)}
                </span>
              );
            })}
          </div>
        </div>
        <div className="chat-header-side">
          <div className="member-stack" aria-label="members">
            {props.room.memberIds.slice(0, 4).map((memberId) => {
              const user = props.users.find((candidate) => candidate.id === memberId);
              const managed = user ? isUserAssistantManaged(user, props.agents, props.autopilotPolicies, props.room.id) : false;
              return (
                <span
                  className={presenceClass(user?.status ?? 'offline', managed)}
                  key={memberId}
                  title={user ? `${user.name} · ${presenceLabel(user.status, managed)}` : undefined}
                >
                  {user?.avatar ?? '--'}
                </span>
              );
            })}
          </div>
          <div className="chat-top-actions">
            <button type="button" onClick={props.onOpenAgentConsole}>
              <Bot size={15} />
              <span>Agent 操作台</span>
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

      {props.error ? (
        <motion.div className="error-banner chat-error-banner" key="chat-error" {...softAppear}>
          {props.error}
        </motion.div>
      ) : null}

      {primaryPendingAction ? (
        <PendingActionBanner
          action={primaryPendingAction}
          pendingCount={pendingActions.length}
          onOpenAgentConsole={props.onOpenAgentConsole}
        />
      ) : null}

      {!primaryPendingAction && primaryCompletedAction ? (
        <CompletedActionBanner
          action={primaryCompletedAction}
          onShowCalendar={() => setActiveTab('calendar')}
          onShowTasks={() => setActiveTab('tasks')}
        />
      ) : null}

      {activeTab !== 'chat' ? (
        <motion.div className="room-detail-motion" key={activeTab} {...softAppear}>
          <RoomDetailPanel
            activeTab={activeTab}
            tasks={props.tasks}
            files={roomFiles}
            calendar={roomCalendar}
            agents={props.agents}
            autopilotPolicies={props.autopilotPolicies}
            members={roomMembers}
            messages={props.sourceMessages}
            roomId={props.room.id}
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
                  {message.agentLabel ? <span className="agent-badge">{formatAgentBadge(message.agentLabel)}</span> : null}
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
        <AgentShortcutPopover
          buttonClassName="composer-agent-button"
          buttonLabel="打开 Agent 快捷菜单"
          side="top"
          align="start"
          actions={[
            {
              id: 'summary',
              icon: <PanelRightOpen size={16} />,
              label: '总结当前群聊',
              description: '提取结论、待办、风险和下一步',
              onSelect: props.onSummarize,
              disabled: props.busyAction === 'summary'
            },
            {
              id: 'deadline',
              icon: <Clock3 size={16} />,
              label: '问截止',
              description: '从聊天、任务和日程里找时间点',
              onSelect: props.onDeadlineQuestion,
              disabled: props.busyAction === 'deadline'
            },
            {
              id: 'find-file',
              icon: <Search size={16} />,
              label: 'Agent 找文件',
              description: '支持模糊线索和上下文匹配',
              onSelect: props.onFindFile,
              disabled: props.busyAction === 'find-file'
            },
            {
              id: 'draft',
              icon: <Sparkles size={16} />,
              label: 'Agent 写回复',
              description: '根据当前群聊草拟可发送内容',
              onSelect: props.onAgentDraftReply,
              disabled: props.busyAction === 'chat'
            },
            {
              id: 'console',
              icon: <Bot size={16} />,
              label: '进入 Agent 操作台',
              description: '处理高风险动作、文件和协作流',
              onSelect: props.onOpenAgentConsole
            }
          ]}
          upload={{
            disabled: props.busyAction === 'upload-file',
            onFileUpload: props.onFileUpload
          }}
        />
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

function CompletedActionBanner(props: {
  action: AgentActionRequest;
  onShowCalendar: () => void;
  onShowTasks: () => void;
}) {
  return (
    <motion.div className="chat-completed-action-banner" key={props.action.id} {...softAppear}>
      <span className="chat-completed-action-icon">
        <CheckCircle2 size={19} />
      </span>
      <div className="chat-completed-action-copy">
        <strong>{formatCompletedActionHeadline(props.action)}</strong>
        <span>{formatCompletedActionSummary(props.action)}</span>
      </div>
      <div className="chat-completed-action-buttons">
        {Boolean(props.action.input.calendarPatch) ? (
          <button type="button" onClick={props.onShowCalendar}>
            查看日程
          </button>
        ) : null}
        {Boolean(props.action.input.taskPatch) ? (
          <button type="button" onClick={props.onShowTasks}>
            查看任务
          </button>
        ) : null}
      </div>
    </motion.div>
  );
}

function isVisibleCompletedAction(action: AgentActionRequest): boolean {
  return (
    action.kind === 'coordinate' ||
    action.kind === 'calendar_update' ||
    action.kind === 'task_update' ||
    action.kind === 'task_update_suggest'
  );
}

function formatCompletedActionHeadline(action: AgentActionRequest): string {
  if (action.kind === 'coordinate') {
    return 'A2A 协商已完成';
  }
  if (action.kind === 'calendar_update') {
    return '日程已更新';
  }
  if (action.kind === 'task_update' || action.kind === 'task_update_suggest') {
    return '任务已更新';
  }
  return 'Agent 动作已完成';
}

function formatCompletedActionSummary(action: AgentActionRequest): string {
  const calendarTime = getCalendarPatchNewTime(action);
  const taskText = action.input.taskPatch ? '，任务已进入进行中' : '';
  if (calendarTime) {
    return `协商结果已生效：合稿检查调整到${calendarTime}${taskText}。`;
  }
  if (action.input.taskPatch) {
    return '协商结果已生效：任务状态已经更新。';
  }
  return '协商结果已同步到当前聊天室。';
}

function getCalendarPatchNewTime(action: AgentActionRequest): string | undefined {
  const patch = action.input.calendarPatch;
  if (!patch || typeof patch !== 'object' || !('newStartsAt' in patch)) {
    return undefined;
  }
  const newStartsAt = (patch as { newStartsAt?: unknown }).newStartsAt;
  if (typeof newStartsAt !== 'string') {
    return undefined;
  }
  return formatWeekdayTime(newStartsAt);
}

function formatWeekdayTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    weekday: 'short',
    timeZone: 'Asia/Shanghai'
  }).format(date);
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  }).format(date);
  return `${weekday} ${time}`;
}

function PendingActionBanner(props: {
  action: AgentActionRequest;
  pendingCount: number;
  onOpenAgentConsole: () => void;
}) {
  return (
    <motion.div className="chat-pending-action-banner" key={props.action.id} {...softAppear}>
      <span className="chat-pending-action-icon">
        <ShieldCheck size={18} />
      </span>
      <div className="chat-pending-action-copy">
        <strong>{formatPendingActionHeadline(props.action)}</strong>
        <span>{formatPendingActionSummary(props.action)}</span>
        <small>
          {formatPendingActionImpact(props.action)}
          {props.pendingCount > 1 ? ` 另有 ${props.pendingCount - 1} 项等待处理。` : ''}
        </small>
      </div>
      <button type="button" onClick={props.onOpenAgentConsole}>
        去确认
      </button>
    </motion.div>
  );
}

function formatPendingActionHeadline(action: AgentActionRequest): string {
  if (action.kind === 'coordinate') {
    return 'A2A 协商待确认';
  }
  if (action.kind === 'share_file') {
    return '文件代发待确认';
  }
  if (action.kind === 'send_message') {
    return '消息代发待确认';
  }
  if (action.kind === 'calendar_update') {
    return '日程更新待确认';
  }
  if (action.kind === 'task_update' || action.kind === 'task_update_suggest') {
    return '任务更新待确认';
  }
  return 'Agent 动作待确认';
}

function formatPendingActionSummary(action: AgentActionRequest): string {
  const raw = String(action.input.requestText ?? action.input.proposal ?? action.input.messageBody ?? '').trim();
  if (raw) {
    return raw.replace(/\s+/g, ' ');
  }
  if (action.kind === 'coordinate') {
    return 'Agent 已完成协商，等待你确认是否写入日程和任务。';
  }
  if (action.kind === 'share_file') {
    return 'Agent 找到了可代发文件，等待你确认后再发送。';
  }
  return 'Agent 已准备好下一步动作，等待你确认。';
}

function formatPendingActionImpact(action: AgentActionRequest): string {
  const hasCalendarPatch = Boolean(action.input.calendarPatch);
  const hasTaskPatch = Boolean(action.input.taskPatch);
  if (action.kind === 'coordinate' && hasCalendarPatch && hasTaskPatch) {
    return '确认后写入日程并推进相关任务。';
  }
  if (action.kind === 'coordinate' && hasCalendarPatch) {
    return '确认后写入日程，确认前不会改变数据。';
  }
  if (action.kind === 'share_file') {
    return '确认前不会发送任何文件。';
  }
  if (action.kind === 'send_message') {
    return '确认前不会替你发出消息。';
  }
  return '确认前不会改变聊天、文件、任务或日程。';
}

function RoomDetailPanel(props: {
  activeTab: Exclude<RoomContentTab, 'chat'>;
  tasks: TaskItem[];
  files: FileItem[];
  calendar: CalendarItem[];
  agents: DemoState['agents'];
  autopilotPolicies: DemoState['agentAutopilotPolicies'];
  members: DemoState['users'];
  messages: Message[];
  roomId: string;
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

  return (
    <RoomMembersPanel
      agents={props.agents}
      autopilotPolicies={props.autopilotPolicies}
      members={props.members}
      roomId={props.roomId}
    />
  );
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

function RoomMembersPanel(props: {
  agents: DemoState['agents'];
  autopilotPolicies: DemoState['agentAutopilotPolicies'];
  members: DemoState['users'];
  roomId: string;
}) {
  return (
    <section className="room-detail-panel">
      <div className="room-detail-header">
        <div>
          <h3>成员 <span>{props.members.length}</span></h3>
          <p>当前会话成员和在线状态。</p>
        </div>
      </div>
      <div className="member-detail-grid">
        {props.members.map((member) => {
          const managed = isUserAssistantManaged(member, props.agents, props.autopilotPolicies, props.roomId);
          const profile = member.collaborationProfile;
          return (
            <div className="member-detail" key={member.id}>
              <i className={presenceClass(member.status, managed)}>{member.avatar}</i>
              <div>
                <strong>{member.name}</strong>
                <span>{member.role} · {presenceLabel(member.status, managed)}</span>
                {profile ? (
                  <div className="member-story">
                    <p>{profile.responsibility}</p>
                    <small>当前：{profile.currentFocus}</small>
                    <small>时间：{profile.availability}</small>
                    <small>可托管：{profile.assistantScope.join('、')}</small>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
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

  const asksAgentToTellUser =
    includesAnyText(text, ['告诉我', '跟我说', '给我说', '通知我', '提醒我', '告诉一下我']) ||
    includesAnyText(lowered, ['tell me', 'let me know', 'show me', 'explain to me']);
  if (asksAgentToTellUser) {
    return undefined;
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

function membersForRoom(room: DemoState['rooms'][number], users: DemoState['users']): DemoState['users'] {
  return room.memberIds
    .map((memberId) => users.find((user) => user.id === memberId))
    .filter((user): user is DemoState['users'][number] => Boolean(user));
}

function isUserAssistantManaged(
  user: DemoState['users'][number],
  agents: DemoState['agents'],
  policies: DemoState['agentAutopilotPolicies'],
  roomId: string
): boolean {
  const agent = agents.find((candidate) => candidate.id === user.agentId);
  const policy = policies.find((candidate) => candidate.agentId === agent?.id);
  return Boolean(agent && policy?.enabled && policy.allowedRoomIds.includes(roomId));
}

function presenceLabel(
  status: DemoState['users'][number]['status'],
  assistantManaged: boolean,
  options: { longManaged?: boolean } = {}
): string {
  if (assistantManaged && status === 'offline') {
    return options.longManaged ? '离线，个人助手托管中' : '托管中';
  }
  if (assistantManaged) {
    return options.longManaged ? `${basePresenceLabel(status)}，个人助手托管中` : `${basePresenceLabel(status)}，托管中`;
  }
  return basePresenceLabel(status);
}

function basePresenceLabel(status: DemoState['users'][number]['status']): string {
  if (status === 'online') {
    return '在线';
  }
  if (status === 'busy') {
    return '忙碌';
  }
  return '离线';
}

function presenceClass(status: DemoState['users'][number]['status'], assistantManaged: boolean): string {
  return `presence-${assistantManaged ? 'managed' : status}`;
}

function roomPresenceSummary(
  members: DemoState['users'],
  agents: DemoState['agents'],
  policies: DemoState['agentAutopilotPolicies'],
  roomId: string
): string {
  return members
    .slice(0, 3)
    .map((member) => `${member.name}${presenceLabel(member.status, isUserAssistantManaged(member, agents, policies, roomId))}`)
    .join('，');
}

function roomStatusLine(
  room: DemoState['rooms'][number],
  members: DemoState['users'],
  agents: DemoState['agents'],
  policies: DemoState['agentAutopilotPolicies']
): string {
  const directLabel = room.type === 'direct' ? '私聊' : '群聊';
  return `${directLabel} · ${roomPresenceSummary(members, agents, policies, room.id)}`;
}

function formatAgentBadge(label: string): string {
  if (label.includes('代发')) {
    return '由个人助手代发';
  }
  if (label.includes('协')) {
    return '个人助手协商';
  }
  return '个人助手';
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
