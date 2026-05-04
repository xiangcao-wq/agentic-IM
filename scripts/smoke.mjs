const apiBase = process.env.AGENT_IM_API_BASE ?? 'http://127.0.0.1:8791';
const webBase = process.env.AGENT_IM_WEB_BASE ?? 'http://127.0.0.1:5175';
const apiToken = process.env.AGENT_IM_API_TOKEN ?? '';

const headers = {
  'content-type': 'application/json',
  ...(apiToken ? { 'x-agent-im-token': apiToken } : {})
};

async function requestJson(url, init = {}) {
  const response = await fetch(url, {
    headers,
    ...init,
    headers: {
      ...headers,
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${url} failed ${response.status}: ${text}`);
  }
  return body;
}

const state = await requestJson(`${apiBase}/api/state`);
if (!Array.isArray(state.rooms) || !state.rooms.some((room) => room.id === 'room-team')) {
  throw new Error('API state did not include the demo team room.');
}

const deadline = await requestJson(`${apiBase}/api/agent/run`, {
  method: 'POST',
  body: JSON.stringify({
    agentId: 'agent-lin',
    roomId: 'room-team',
    intent: 'deadline',
    userText: '这次作业什么时候截止？'
  })
});
if (!deadline.result?.answer?.includes('23:59')) {
  throw new Error('Agent deadline smoke check did not return the expected deadline.');
}

const actions = await requestJson(`${apiBase}/api/agent/actions`);
if (!Array.isArray(actions.actions)) {
  throw new Error('Agent action queue endpoint did not return an actions array.');
}

const sync = await requestJson(`${apiBase}/api/matrix/sync-once`, {
  method: 'POST',
  body: '{}'
});
if (typeof sync.messagesAdded !== 'number') {
  throw new Error('Matrix sync endpoint did not return messagesAdded.');
}

const web = await fetch(webBase);
if (!web.ok) {
  throw new Error(`${webBase} failed ${web.status}`);
}

console.log('Smoke checks passed.');
console.log(`Rooms: ${state.rooms.length}`);
console.log(`Actions: ${actions.actions.length}`);
console.log(`Matrix messages added: ${sync.messagesAdded}`);
