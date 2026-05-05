import { createRuntimeDemoAssets } from '../src/server/demoAssets.ts';

const apiBaseUrl = process.env.AGENT_IM_API_URL ?? 'http://127.0.0.1:8791';
const roomId = process.env.AGENT_IM_DEMO_ROOM_ID ?? 'room-team';
const senderId = process.env.AGENT_IM_DEMO_SENDER_ID ?? 'user-lin';
const apiToken = process.env.AGENT_IM_API_TOKEN ?? '';
const force = process.argv.includes('--force');

const headers = apiToken
  ? {
      'x-agent-im-token': apiToken
    }
  : {};

const stateResponse = await fetch(`${apiBaseUrl}/api/state`, { headers });
if (!stateResponse.ok) {
  throw new Error(`Failed to read state from ${apiBaseUrl}: HTTP ${stateResponse.status}`);
}

const state = await stateResponse.json();
const existingNames = new Set(
  (state.files ?? [])
    .filter((file) => file.roomId === roomId)
    .map((file) => file.name)
);

const uploaded = [];
const skipped = [];

for (const asset of createRuntimeDemoAssets()) {
  if (!force && existingNames.has(asset.name)) {
    skipped.push(asset.name);
    continue;
  }

  const url = new URL('/api/files/upload', apiBaseUrl);
  url.searchParams.set('roomId', roomId);
  url.searchParams.set('senderId', senderId);
  url.searchParams.set('agentCanShare', 'true');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': asset.contentType,
      'x-file-name': encodeURIComponent(asset.name)
    },
    body: Buffer.from(asset.bytes)
  });

  if (!response.ok) {
    throw new Error(`Failed to upload ${asset.name}: HTTP ${response.status} ${await response.text()}`);
  }

  const file = await response.json();
  uploaded.push({
    id: file.id,
    name: file.name,
    contentType: file.contentType,
    size: file.size,
    downloadable: Boolean(file.localPath || file.mxcUri)
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      apiBaseUrl,
      roomId,
      senderId,
      uploadedCount: uploaded.length,
      skippedCount: skipped.length,
      uploaded,
      skipped
    },
    null,
    2
  )
);
