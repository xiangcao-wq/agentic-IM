import { runFileShareAction } from './agentRuntime';
import { buildActorInstructions, demoActors, type DemoActorId } from './aiDemoActors';
import type { AiProvider } from './aiProvider';
import { createDemoAssets, type DemoAsset } from './demoAssets';
import { extractTextChunks } from './fileTextIndex';
import type { AgentActionLog, DemoState, FileItem, Message } from '../domain/types';

interface SendOptions {
  agentLabel?: string;
  sourceAgentId?: string;
  fileId?: string;
  fileName?: string;
  mxcUri?: string;
  mimeType?: string;
  size?: number;
}

export interface DemoMatrixGateway {
  uploadMedia(input: {
    senderId: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<{ mxcUri: string; size: number }>;
  sendMessage(
    state: DemoState,
    input: { roomId: string; senderId: string; body: string },
    options?: SendOptions
  ): Promise<Message>;
}

interface AiDemoScenarioInput {
  state: DemoState;
  aiProvider: AiProvider;
  matrixGateway: DemoMatrixGateway;
  now?: string;
}

export interface AiDemoScenarioResult {
  state: DemoState;
  transcript: Message[];
}

export async function runAiDemoScenario(input: AiDemoScenarioInput): Promise<AiDemoScenarioResult> {
  const now = input.now ?? new Date().toISOString();
  let state = input.state;
  const transcript: Message[] = [];

  const uploaded = await uploadScenarioAssets(state, input.matrixGateway, now);
  state = uploaded.state;
  transcript.push(...uploaded.messages);

  for (const turn of createHumanAndAgentTurns()) {
    const actor = demoActors[turn.actorId];
    const text = await input.aiProvider.generateText({
      actorId: actor.id,
      actorRole: actor.role,
      instructions: buildActorInstructions(actor),
      input: buildTurnPrompt(state, turn.goal),
      maxOutputTokens: 160
    });
    const message = await input.matrixGateway.sendMessage(
      state,
      {
        roomId: turn.roomId,
        senderId: actor.matrixSenderId,
        body: text
      },
      actor.agentLabel
        ? {
            agentLabel: actor.agentLabel,
            sourceAgentId: actor.agentId
          }
        : undefined
    );
    transcript.push(message);
    state = {
      ...state,
      actionLogs: [
        createAiGenerationLog({
          actorId: turn.actorId,
          agentId: actor.agentId,
          roomId: turn.roomId,
          messageId: message.id,
          now
        }),
        ...state.actionLogs
      ]
    };
  }

  const runtime = await runFileShareAction(state, {
    agentId: 'agent-lin',
    roomId: 'room-team',
    requesterId: 'user-chen',
    requestText: '陈晨请求把最新 action plan 文件发到小组群，林雯已授权个人助手代发。',
    createdAt: now
  });
  state = runtime.state;

  if (runtime.result.message && runtime.result.file) {
    const file = runtime.result.file;
    const message = await input.matrixGateway.sendMessage(
      state,
      {
        roomId: runtime.result.message.roomId,
        senderId: runtime.result.message.senderId,
        body: runtime.result.message.body
      },
      {
        agentLabel: runtime.result.message.agentLabel,
        sourceAgentId: runtime.result.message.sourceAgentId,
        fileId: file.id,
        fileName: file.name,
        mxcUri: file.mxcUri,
        mimeType: file.contentType,
        size: file.size
      }
    );
    transcript.push(message);
  }

  return { state, transcript };
}

async function uploadScenarioAssets(
  state: DemoState,
  matrixGateway: DemoMatrixGateway,
  now: string
): Promise<{ state: DemoState; messages: Message[] }> {
  let nextState = state;
  const messages: Message[] = [];

  for (const asset of createDemoAssets()) {
    const uploaded = await matrixGateway.uploadMedia({
      senderId: 'user-lin',
      filename: asset.name,
      contentType: asset.contentType,
      bytes: asset.bytes
    });
    const file = createScenarioFile(nextState, asset, uploaded, now);
    const message = await matrixGateway.sendMessage(
      nextState,
      {
        roomId: file.roomId,
        senderId: file.uploaderId,
        body: file.name
      },
      {
        fileId: file.id,
        fileName: file.name,
        mxcUri: file.mxcUri,
        mimeType: file.contentType,
        size: file.size
      }
    );
    messages.push(message);
    const chunks = extractTextChunks(file, asset.bytes);
    nextState = {
      ...nextState,
      files: [file, ...nextState.files],
      fileTextChunks: [...chunks, ...(nextState.fileTextChunks ?? [])],
      actionLogs: [
        createAssetUploadLog({
          file,
          messageId: message.id,
          now
        }),
        ...nextState.actionLogs
      ]
    };
  }

  return { state: nextState, messages };
}

function createScenarioFile(
  state: DemoState,
  asset: DemoAsset,
  uploaded: { mxcUri: string; size: number },
  now: string
): FileItem {
  const latestVersion = state.files
    .filter((file) => file.roomId === 'room-team' && file.uploaderId === 'user-lin')
    .reduce((max, file) => Math.max(max, file.version), 0);

  return {
    id: `file-ai-seed-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: asset.name,
    uploaderId: 'user-lin',
    version: latestVersion + 1,
    roomId: 'room-team',
    updatedAt: now,
    visibility: 'room',
    agentCanShare: true,
    tags: asset.tags,
    summary: asset.summary,
    mxcUri: uploaded.mxcUri,
    contentType: asset.contentType,
    size: uploaded.size
  };
}

function createHumanAndAgentTurns(): Array<{ actorId: DemoActorId; roomId: string; goal: string }> {
  return [
    {
      actorId: 'user-zhao',
      roomId: 'room-team',
      goal: '作为组长，基于文件和任务，推动小组锁定今晚的合稿安排。'
    },
    {
      actorId: 'user-chen',
      roomId: 'room-team',
      goal: '作为资料负责人，说明访谈材料状态，并自然请求林雯或她的个人助手发送最新材料。'
    },
    {
      actorId: 'agent-chen',
      roomId: 'room-agent',
      goal: '代表陈晨向林雯的个人助手发起任务协调，请求确认文件代发和补截图时间。'
    },
    {
      actorId: 'agent-lin',
      roomId: 'room-agent',
      goal: '代表林雯回应陈晨的个人助手，说明可自动代发文件，但日程变更需要人工确认。'
    }
  ];
}

function buildTurnPrompt(state: DemoState, goal: string): string {
  const files = state.files
    .slice(0, 5)
    .map((file) => `${file.name} v${file.version} ${file.agentCanShare ? '可由个人助手代发' : '不可代发'}`)
    .join('\n');
  const tasks = state.tasks.map((task) => `${task.title} - ${task.deadline} - ${task.status}`).join('\n');

  return [
    '当前小组文件：',
    files,
    '',
    '当前任务：',
    tasks,
    '',
    '## Current Turn Goal',
    goal,
    '',
    '请生成一条自然、具体、可推进任务的聊天消息。'
  ].join('\n');
}

function createAiGenerationLog(input: {
  actorId: DemoActorId;
  agentId?: string;
  roomId: string;
  messageId: string;
  now: string;
}): AgentActionLog {
  return {
    id: `log-ai-message-${input.actorId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    agentId: input.agentId ?? `actor-${input.actorId}`,
    roomId: input.roomId,
    action: `ai_actor_message:${input.actorId}`,
    status: 'executed',
    risk: {
      level: 'low',
      score: 0.15,
      reason: 'AI actor generated a demo conversation turn and wrote it to Matrix.',
      model: 'ai-demo-orchestrator'
    },
    contextIds: [input.messageId],
    toolCalls: [
      'ai_provider.generate_text',
      demoActors[input.actorId].role === 'human_user'
        ? 'deepseek.flash.chat.completions'
        : 'deepseek.pro.chat.completions',
      'matrix.send_event'
    ],
    createdAt: input.now
  };
}

function createAssetUploadLog(input: { file: FileItem; messageId: string; now: string }): AgentActionLog {
  return {
    id: `log-ai-asset-${input.file.id}`,
    agentId: 'agent-lin',
    roomId: input.file.roomId,
    action: `ai_seed_asset_upload:${input.file.name}`,
    status: 'executed',
    risk: {
      level: 'low',
      score: 0.1,
      reason: 'Demo asset generated locally and uploaded to Matrix media repository.',
      model: 'ai-demo-orchestrator'
    },
    contextIds: [input.file.id, input.messageId],
    toolCalls: ['demo_asset.create', 'matrix.media.upload', 'matrix.send_event'],
    createdAt: input.now
  };
}
