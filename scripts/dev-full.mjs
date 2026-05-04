import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const processes = [
  spawn(npm, ['run', 'api'], {
    env: { ...process.env, AGENT_IM_API_PORT: '8791' },
    stdio: 'inherit'
  }),
  spawn(npm, ['run', 'dev'], {
    stdio: 'inherit'
  })
];

function shutdown() {
  for (const child of processes) {
    child.kill('SIGTERM');
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

for (const child of processes) {
  child.on('exit', (code) => {
    if (code && code !== 0) {
      shutdown();
      process.exit(code);
    }
  });
}
