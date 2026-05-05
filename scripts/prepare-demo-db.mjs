import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createDemoState } from '../src/domain/demoState.ts';
import { createRuntimeDemoAssets } from '../src/server/demoAssets.ts';
import { extractTextChunks } from '../src/server/fileTextIndex.ts';

const root = process.cwd();
const dbPath = process.env.AGENT_IM_DB_PATH ?? join(root, 'data', 'agent-im-db.json');
const mediaDir = process.env.AGENT_IM_MEDIA_DIR ?? join(root, 'data', 'media');
const roomId = process.env.AGENT_IM_DEMO_ROOM_ID ?? 'room-team';
const senderId = process.env.AGENT_IM_DEMO_SENDER_ID ?? 'user-lin';

const state = createDemoState();
const room = state.rooms.find((candidate) => candidate.id === roomId);
const sender = state.users.find((candidate) => candidate.id === senderId);

if (!room) {
  throw new Error(`unknown room: ${roomId}`);
}
if (!sender) {
  throw new Error(`unknown sender: ${senderId}`);
}

await mkdir(mediaDir, { recursive: true });

let nextState = {
  ...state,
  messages: [...state.messages],
  files: [...state.files],
  fileTextChunks: [...(state.fileTextChunks ?? [])],
  actionLogs: [...state.actionLogs]
};

const preparedFiles = [];

for (const [index, asset] of createRuntimeDemoAssets().entries()) {
  const slug = safeId(asset.name);
  const fileId = `file-demo-runtime-${slug}`;
  const messageId = `msg-demo-runtime-${slug}`;
  const localPath = `${fileId}-${safePathSegment(asset.name)}`;
  const updatedAt = new Date(Date.parse('2026-05-04T16:00:00+08:00') + index * 60_000).toISOString();

  await writeFile(resolveMediaPath(mediaDir, localPath), Buffer.from(asset.bytes));

  const file = {
    id: fileId,
    name: asset.name,
    uploaderId: sender.id,
    version: 1,
    roomId: room.id,
    updatedAt,
    visibility: 'room',
    agentCanShare: true,
    tags: asset.tags,
    summary: asset.summary,
    contentType: asset.contentType,
    size: asset.bytes.byteLength,
    localPath
  };

  const message = {
    id: messageId,
    roomId: room.id,
    senderId: sender.id,
    senderName: sender.name,
    body: asset.name,
    sentAt: updatedAt,
    type: 'file',
    fileId: file.id,
    contentType: file.contentType,
    size: file.size
  };

  const log = {
    id: `log-demo-runtime-${slug}`,
    agentId: sender.agentId,
    roomId: room.id,
    action: `prepare_demo_asset:${asset.name}`,
    status: 'executed',
    risk: {
      level: 'low',
      score: 0.1,
      reason: 'Deployment seed created a room-visible downloadable demo asset with Agent sharing permission.',
      model: 'demo-seed-v1'
    },
    contextIds: [file.id, message.id],
    toolCalls: ['demo_assets.prepare', 'local.media.write', 'file_text.index'],
    createdAt: updatedAt
  };

  nextState = {
    ...nextState,
    files: [file, ...nextState.files.filter((candidate) => candidate.id !== file.id)],
    fileTextChunks: [
      ...extractTextChunks(file, asset.bytes),
      ...nextState.fileTextChunks.filter((chunk) => chunk.fileId !== file.id)
    ],
    messages: [...nextState.messages.filter((candidate) => candidate.id !== message.id), message],
    actionLogs: [log, ...nextState.actionLogs.filter((candidate) => candidate.id !== log.id)]
  };

  preparedFiles.push({
    id: file.id,
    name: file.name,
    contentType: file.contentType,
    size: file.size,
    localPath: file.localPath
  });
}

nextState.messages.sort((left, right) => new Date(left.sentAt).getTime() - new Date(right.sentAt).getTime());

await mkdir(resolve(dbPath, '..'), { recursive: true });
await writeFile(dbPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');

console.log(
  JSON.stringify(
    {
      ok: true,
      dbPath,
      mediaDir,
      files: preparedFiles.length,
      textChunks: nextState.fileTextChunks.length
    },
    null,
    2
  )
);

function safeId(value) {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function safePathSegment(value) {
  return (
    basename(value)
      .replace(/[^\w.-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'file'
  );
}

function resolveMediaPath(rootDir, relativePath) {
  const rootPath = resolve(rootDir);
  const target = resolve(rootPath, basename(relativePath));
  if (target !== rootPath && !target.startsWith(`${rootPath}\\`) && !target.startsWith(`${rootPath}/`)) {
    throw new Error(`invalid media path: ${relativePath}`);
  }
  return target;
}
