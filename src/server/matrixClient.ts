import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { sortMessagesChronologically } from '../domain/messages';
import type { DemoState, Message } from '../domain/types';

export interface MatrixBootstrap {
  homeserverUrl: string;
  users: Record<string, { matrixUserId: string; accessToken: string }>;
  rooms: Record<string, string>;
}

interface MatrixEvent {
  event_id: string;
  sender: string;
  origin_server_ts: number;
  type: string;
  content?: {
    body?: string;
    msgtype?: string;
    agent_label?: string;
    source_agent_id?: string;
    file_id?: string;
    url?: string;
    info?: {
      mimetype?: string;
      size?: number;
    };
  };
}

interface SendOptions {
  agentLabel?: string;
  sourceAgentId?: string;
  fileId?: string;
  fileName?: string;
  mxcUri?: string;
  mimeType?: string;
  size?: number;
}

export class MatrixStore {
  constructor(private readonly bootstrap: MatrixBootstrap) {}

  static async fromFile(path: string): Promise<MatrixStore | null> {
    try {
      const bootstrap = JSON.parse(await readFile(path, 'utf8')) as MatrixBootstrap;
      return new MatrixStore(bootstrap);
    } catch {
      return null;
    }
  }

  async hydrateState(state: DemoState): Promise<DemoState> {
    const rooms = state.rooms.map((room) => ({
      ...room,
      matrixRoomId: this.bootstrap.rooms[room.id] ?? room.matrixRoomId
    }));
    const users = state.users.map((user) => ({
      ...user,
      matrixUserId: this.bootstrap.users[user.id]?.matrixUserId ?? user.matrixUserId
    }));

    return {
      ...state,
      users,
      rooms
    };
  }

  async sendMessage(
    state: DemoState,
    input: { roomId: string; senderId: string; body: string },
    options: SendOptions = {}
  ): Promise<Message> {
    const roomId = this.bootstrap.rooms[input.roomId];
    const user = this.bootstrap.users[input.senderId];
    if (!roomId || !user) {
      throw new Error(`Matrix mapping missing for room ${input.roomId} or sender ${input.senderId}`);
    }

    const txnId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const isFileMessage = Boolean(options.fileId || options.mxcUri);
    const messageBody = options.fileName ?? input.body;
    const response = await matrixRequest<{ event_id: string }>(
      this.bootstrap.homeserverUrl,
      `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      user.accessToken,
      {
        method: 'PUT',
        body: {
          msgtype: isFileMessage ? 'm.file' : 'm.text',
          body: messageBody,
          agent_label: options.agentLabel,
          source_agent_id: options.sourceAgentId,
          file_id: options.fileId,
          url: options.mxcUri,
          info: options.mxcUri
            ? {
                mimetype: options.mimeType,
                size: options.size
              }
            : undefined
        }
      }
    );

    const sender = state.users.find((candidate) => candidate.id === input.senderId);
    return {
      id: response.event_id,
      roomId: input.roomId,
      senderId: input.senderId,
      senderName: options.agentLabel ? sender?.name ?? input.senderId : sender?.name ?? input.senderId,
      body: messageBody,
      sentAt: new Date().toISOString(),
      type: options.agentLabel ? 'agent' : isFileMessage ? 'file' : 'text',
      agentLabel: options.agentLabel,
      sourceAgentId: options.sourceAgentId,
      fileId: options.fileId,
      mxcUri: options.mxcUri,
      contentType: options.mimeType,
      size: options.size
    };
  }

  async uploadMedia(input: {
    senderId: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<{ mxcUri: string; size: number }> {
    const user = this.bootstrap.users[input.senderId];
    if (!user) {
      throw new Error(`Matrix mapping missing for sender ${input.senderId}`);
    }

    const response = await matrixMediaRequest<{ content_uri: string }>(
      this.bootstrap.homeserverUrl,
      `/upload?filename=${encodeURIComponent(input.filename)}`,
      user.accessToken,
      input.contentType,
      input.bytes
    );

    return {
      mxcUri: response.content_uri,
      size: input.bytes.byteLength
    };
  }

  async downloadMedia(mxcUri: string, filename?: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const token = Object.values(this.bootstrap.users)[0]?.accessToken;
    if (!token) {
      throw new Error('Matrix access token is required for media download');
    }
    const media = parseMxcUri(mxcUri);
    const filenamePath = filename ? `/${encodeURIComponent(filename)}` : '';
    return matrixMediaDownload(
      this.bootstrap.homeserverUrl,
      `/download/${encodeURIComponent(media.serverName)}/${encodeURIComponent(media.mediaId)}${filenamePath}`,
      token
    );
  }

  async syncStateOnce(state: DemoState): Promise<{ state: DemoState; messagesAdded: number }> {
    const rooms = state.rooms.map((room) => ({
      ...room,
      matrixRoomId: this.bootstrap.rooms[room.id] ?? room.matrixRoomId
    }));
    const users = state.users.map((user) => ({
      ...user,
      matrixUserId: this.bootstrap.users[user.id]?.matrixUserId ?? user.matrixUserId
    }));
    const mappedState = { ...state, users, rooms };
    const messagesByRoom = await Promise.all(
      rooms.map(async (room) => this.fetchRoomMessages(mappedState, room.id, this.bootstrap.rooms[room.id]))
    );
    const existingMessageIds = new Set(state.messages.map((message) => message.id));
    const newMessages = messagesByRoom.flat().filter((message) => !existingMessageIds.has(message.id));
    const checkpoints = rooms
      .map((room) => {
        const latest = sortMessagesChronologically([...state.messages, ...newMessages])
          .filter((message) => message.roomId === room.id && message.id.startsWith('$'))
          .at(-1);
        return latest ? { roomId: room.id, lastEventId: latest.id } : undefined;
      })
      .filter(Boolean) as DemoState['matrixObserverCheckpoints'];

    return {
      state: {
        ...state,
        users,
        rooms,
        messages: sortMessagesChronologically([...state.messages, ...newMessages]),
        matrixObserverCheckpoints: checkpoints
      },
      messagesAdded: newMessages.length
    };
  }

  private async fetchRoomMessages(state: DemoState, localRoomId: string, matrixRoomId?: string): Promise<Message[]> {
    if (!matrixRoomId) {
      return [];
    }

    const token = Object.values(this.bootstrap.users)[0]?.accessToken;
    const response = await matrixRequest<{ chunk: MatrixEvent[] }>(
      this.bootstrap.homeserverUrl,
      `/rooms/${encodeURIComponent(matrixRoomId)}/messages?dir=b&limit=80`,
      token
    );

    return response.chunk
      .filter((event) => event.type === 'm.room.message' && event.content?.body)
      .map((event) => matrixEventToTrustedMessage(state, localRoomId, event))
      .reverse();
  }
}

export async function writeMatrixBootstrap(path: string, bootstrap: MatrixBootstrap): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(bootstrap, null, 2)}\n`, 'utf8');
}

export async function loginMatrixUser(
  homeserverUrl: string,
  localpart: string,
  password: string
): Promise<{ matrixUserId: string; accessToken: string }> {
  const response = await matrixRequest<{ user_id: string; access_token: string }>(homeserverUrl, '/login', undefined, {
    method: 'POST',
    body: {
      type: 'm.login.password',
      identifier: {
        type: 'm.id.user',
        user: localpart
      },
      password
    }
  });

  return {
    matrixUserId: response.user_id,
    accessToken: response.access_token
  };
}

export async function createMatrixRoom(
  homeserverUrl: string,
  accessToken: string,
  input: { name: string; invite: string[] }
): Promise<string> {
  const response = await matrixRequest<{ room_id: string }>(homeserverUrl, '/createRoom', accessToken, {
    method: 'POST',
    body: {
      name: input.name,
      preset: 'private_chat',
      invite: input.invite
    }
  });
  return response.room_id;
}

export async function joinMatrixRoom(homeserverUrl: string, accessToken: string, roomId: string): Promise<void> {
  await matrixRequest(homeserverUrl, `/rooms/${encodeURIComponent(roomId)}/join`, accessToken, {
    method: 'POST',
    body: {}
  });
}

async function matrixRequest<T>(
  homeserverUrl: string,
  path: string,
  accessToken?: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(`${homeserverUrl}/_matrix/client/v3${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      'content-type': 'application/json'
    },
    body: init.body ? JSON.stringify(init.body) : undefined
  });

  if (!response.ok) {
    throw new Error(`Matrix request failed ${response.status}: ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

async function matrixMediaRequest<T>(
  homeserverUrl: string,
  path: string,
  accessToken: string,
  contentType: string,
  bytes: Uint8Array
): Promise<T> {
  const response = await fetch(`${homeserverUrl}/_matrix/media/v3${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': contentType
    },
    body: bytes as BodyInit
  });

  if (!response.ok) {
    throw new Error(`Matrix media request failed ${response.status}: ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

async function matrixMediaDownload(
  homeserverUrl: string,
  path: string,
  accessToken: string
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await fetch(`${homeserverUrl}/_matrix/client/v1/media${path}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`Matrix media download failed ${response.status}: ${await response.text()}`);
  }

  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? 'application/octet-stream'
  };
}

function parseMxcUri(mxcUri: string): { serverName: string; mediaId: string } {
  const match = mxcUri.match(/^mxc:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`invalid Matrix media URI: ${mxcUri}`);
  }
  return {
    serverName: match[1],
    mediaId: match[2]
  };
}

function matrixEventToTrustedMessage(state: DemoState, localRoomId: string, event: MatrixEvent): Message {
  const user = state.users.find((candidate) => candidate.matrixUserId === event.sender);
  const trustedAgentMetadata = isTrustedAgentMetadata(state, localRoomId, event);
  const trustedFileMetadata = isTrustedFileMetadata(state, localRoomId, event);
  const isPlainMatrixFile =
    !event.content?.agent_label &&
    !event.content?.source_agent_id &&
    !event.content?.file_id &&
    event.content?.msgtype === 'm.file' &&
    Boolean(event.content.url);
  const isFileMessage = trustedFileMetadata || isPlainMatrixFile;

  return {
    id: event.event_id,
    roomId: localRoomId,
    senderId: user?.id ?? event.sender,
    senderName: trustedAgentMetadata ? stripAgentLabelSuffix(event.content!.agent_label!) : user?.name ?? event.sender,
    body: event.content?.body ?? '',
    sentAt: new Date(event.origin_server_ts).toISOString(),
    type: trustedAgentMetadata ? 'agent' : isFileMessage ? 'file' : 'text',
    agentLabel: trustedAgentMetadata ? event.content?.agent_label : undefined,
    sourceAgentId: trustedAgentMetadata ? event.content?.source_agent_id : undefined,
    fileId: trustedFileMetadata ? event.content?.file_id : undefined,
    mxcUri: isFileMessage ? event.content?.url : undefined,
    contentType: isFileMessage ? event.content?.info?.mimetype : undefined,
    size: isFileMessage ? event.content?.info?.size : undefined
  };
}

function isTrustedAgentMetadata(state: DemoState, localRoomId: string, event: MatrixEvent): boolean {
  const sourceAgentId = event.content?.source_agent_id;
  if (!event.content?.agent_label || !sourceAgentId) {
    return false;
  }
  const agent = state.agents.find((candidate) => candidate.id === sourceAgentId);
  const owner = agent ? state.users.find((candidate) => candidate.id === agent.ownerId) : undefined;
  return Boolean(agent?.allowedRoomIds.includes(localRoomId) && owner?.matrixUserId === event.sender);
}

function isTrustedFileMetadata(state: DemoState, localRoomId: string, event: MatrixEvent): boolean {
  const fileId = event.content?.file_id;
  if (!fileId || !event.content?.url) {
    return false;
  }
  const file = state.files.find((candidate) => candidate.id === fileId);
  const uploader = file ? state.users.find((candidate) => candidate.id === file.uploaderId) : undefined;
  return Boolean(file?.roomId === localRoomId && uploader?.matrixUserId === event.sender);
}

function stripAgentLabelSuffix(agentLabel: string): string {
  return agentLabel.replace(/\s*(代发|协调|浠ｅ彂|鍗忚皟)$/g, '');
}
