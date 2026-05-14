import { join } from 'node:path';
import { createDemoState } from '../domain/demoState';
import {
  createMatrixRoom,
  joinMatrixRoom,
  loginMatrixUser,
  MatrixStore,
  writeMatrixBootstrap,
  type MatrixBootstrap
} from './matrixClient';

const homeserverUrl = process.env.MATRIX_HOMESERVER_URL ?? 'http://127.0.0.1:8008';
const password = process.env.MATRIX_DEMO_PASSWORD ?? 'demo-pass';
const bootstrapPath = process.env.MATRIX_BOOTSTRAP_PATH ?? join(process.cwd(), 'data', 'matrix-bootstrap.json');

const existing = await MatrixStore.fromFile(bootstrapPath);
if (existing) {
  console.log(`Matrix bootstrap already exists: ${bootstrapPath}`);
  process.exit(0);
}

const users = {
  'user-lin': await loginMatrixUser(homeserverUrl, 'lin', password),
  'user-chen': await loginMatrixUser(homeserverUrl, 'chen', password),
  'user-zhao': await loginMatrixUser(homeserverUrl, 'zhao', password),
  'user-teacher': await loginMatrixUser(homeserverUrl, 'teacher', password)
};

const rooms: MatrixBootstrap['rooms'] = {};
rooms['room-class'] = await createMatrixRoom(homeserverUrl, users['user-teacher'].accessToken, {
  name: '信息系统 2 班',
  invite: [users['user-lin'].matrixUserId, users['user-chen'].matrixUserId, users['user-zhao'].matrixUserId]
});
rooms['room-team'] = await createMatrixRoom(homeserverUrl, users['user-zhao'].accessToken, {
  name: '调研报告第 4 组',
  invite: [users['user-lin'].matrixUserId, users['user-chen'].matrixUserId]
});
rooms['room-agent'] = await createMatrixRoom(homeserverUrl, users['user-lin'].accessToken, {
  name: 'A2A 协商记录',
  invite: [users['user-chen'].matrixUserId]
});

for (const user of Object.values(users)) {
  for (const roomId of Object.values(rooms)) {
    try {
      await joinMatrixRoom(homeserverUrl, user.accessToken, roomId);
    } catch {
      // Users can only join rooms they were invited to; ignore unrelated rooms.
    }
  }
}

const bootstrap: MatrixBootstrap = { homeserverUrl, users, rooms };
await writeMatrixBootstrap(bootstrapPath, bootstrap);

const matrixStore = await MatrixStore.fromFile(bootstrapPath);
const seed = createDemoState();
if (!matrixStore) {
  throw new Error('Matrix bootstrap file was not created.');
}

for (const message of seed.messages) {
  await matrixStore.sendMessage(seed, {
    roomId: message.roomId,
    senderId: message.senderId,
    body: message.body
  }, {
    agentLabel: message.agentLabel,
    sourceAgentId: message.sourceAgentId,
    fileId: message.fileId
  });
}

console.log(`Matrix bootstrap written: ${bootstrapPath}`);
