import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createDemoState } from '../src/domain/demoState.ts';

const root = process.cwd();
const apiPort = Number(process.env.AGENT_IM_DEMO_API_PORT ?? 8794);
const webPort = Number(process.env.AGENT_IM_DEMO_WEB_PORT ?? 5176);
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const workDir = resolve(root, 'tmp', 'demo-video');
const videoDir = join(workDir, 'raw-video');
const dbPath = join(workDir, 'agent-im-demo-db.json');
const viteConfigPath = join(workDir, 'vite.demo.config.mjs');
const outputDir = resolve(root, 'demo-output');
const outputWebm = join(outputDir, 'agent-im-a2a-deepseek-demo.webm');
const outputMp4 = join(outputDir, 'agent-im-a2a-deepseek-demo.mp4');

const children = [];

async function main() {
  await prepareDemoState();
  await mkdir(videoDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const api = startProcess('api', localBin('tsx'), ['src/server/start.ts'], {
    AGENT_IM_API_PORT: String(apiPort),
    AGENT_IM_DB_PATH: dbPath,
    MATRIX_BOOTSTRAP_PATH: 'none',
    AGENT_IM_AUTOPILOT_WORKER: 'true',
    AGENT_IM_AUTOPILOT_WORKER_RUN_ON_START: 'false',
    AGENT_IM_AUTOPILOT_WORKER_ROOM_IDS: 'room-team',
    AGENT_IM_AUTOPILOT_WORKER_LIMIT: '20',
    AGENT_IM_AUTOPILOT_WORKER_INTERVAL_MS: '600000',
    AGENT_IM_ALLOWED_ORIGINS: `${webUrl},http://localhost:${webPort}`
  });
  children.push(api);
  await waitForHttp(`${apiBaseUrl}/api/state`, 60_000);

  const web = startProcess('web', localBin('vite'), ['--config', viteConfigPath, '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {});
  children.push(web);
  await waitForHttp(webUrl, 60_000);

  const status = await postJson(`${apiBaseUrl}/api/ai/status/check`, {});
  if (status.aiStatus?.provider !== 'deepseek' || status.aiStatus?.health !== 'connected') {
    throw new Error(`DeepSeek is not connected: ${JSON.stringify(status.aiStatus)}`);
  }
  await postJson(`${apiBaseUrl}/api/demo/assets/generate`, {
    roomId: 'room-team',
    senderId: 'user-lin'
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    recordVideo: {
      dir: videoDir,
      size: { width: 1440, height: 900 }
    }
  });
  const page = await context.newPage();

  try {
    await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.locator('.chat-panel').waitFor({ timeout: 90_000 });
    await page.locator('.agent-workbench').waitFor({ timeout: 90_000 });
    await installOverlay(page);

    await caption(page, 'AgentBridge 实机演示', '真实浏览器、真实本地数据、DeepSeek 已连接。下面展示聊天分身如何读上下文、代发文件、协商日程并托管跟进任务。');
    await sleep(8_000);

    await caption(page, '1. DeepSeek 在线', '右侧显示 LLM connected。Agent 的自然语言理解由 DeepSeek 驱动，动作仍由本地白名单工具和风险门控执行。');
    await sleep(8_000);

    await caption(page, '2. 自由向 Agent 提问', '用户不用点固定按钮，直接问：谁负责访谈材料？今天先做什么？Agent 会读取群聊、任务和文件上下文后回答。');
    await runAgentPrompt(page, '谁负责访谈材料？我今天先做什么？');
    await sleep(14_000);

    await caption(page, '3. 离线代发真实文件', '陈晨在群里请求：林雯不在电脑前，她的个人助手能否发送昨晚生成的图片？系统会匹配真实可下载文件并低风险自动代发。');
    const handoff = await postJson(`${apiBaseUrl}/api/messages`, {
      roomId: 'room-team',
      senderId: 'user-chen',
      body: '林雯现在不在电脑前，她的个人助手能把昨晚生成的图片发给陈晨吗？'
    });
    if (!handoff.autopilotSessions?.length) {
      throw new Error('Expected delegated file handoff to create an A2A session.');
    }
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.locator('.agent-workbench').waitFor({ timeout: 90_000 });
    await installOverlay(page);
    await caption(page, '3. 离线代发真实文件', '消息已经进入群聊，个人助手代发的是有 localPath/mxcUri 的真实文件，不是只显示一个文件名。');
    await sleep(16_000);

    await caption(page, '4. 聊天分身协商日程', '赵一鸣提出改期，林雯和陈晨的聊天分身会形成 A2A 协商记录；中高风险日程变更进入确认队列，确认前不会改内部日程。');
    const negotiation = await postJson(`${apiBaseUrl}/api/messages`, {
      roomId: 'room-team',
      senderId: 'user-zhao',
      body: '帮我和陈晨商量一下，把合稿检查改到周三 23:00。'
    });
    if (!negotiation.autopilotSessions?.some((session) => session.status === 'needs_confirmation')) {
      throw new Error('Expected schedule negotiation to require confirmation.');
    }
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.locator('[data-testid="a2a-session-panel"]').waitFor({ timeout: 90_000 });
    await installOverlay(page);
    await caption(page, '4. 聊天分身协商日程', '右侧展示协作过程和待确认动作。这里的关键点是：聊天分身能提出 patch，但不能绕过人类确认。');
    await sleep(17_000);

    await caption(page, '5. 托管模式自动跟进任务', '后台 worker 会巡检待处理任务。发现临近截止且还没开始的任务，会生成 A2A 跟进和任务更新确认请求。');
    const [workerResponse] = await Promise.all([
      page.waitForResponse(
        (response) => response.url().endsWith('/api/agent/autopilot/worker/run') && response.request().method() === 'POST',
        { timeout: 90_000 }
      ),
      page.locator('.autopilot-sweep-button').click()
    ]);
    const workerPayload = await workerResponse.json();
    if (!workerPayload.processedTaskIds?.includes('task-video-follow-up')) {
      throw new Error(`Expected worker to process task-video-follow-up: ${JSON.stringify(workerPayload)}`);
    }
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.locator('.confirmation-section').waitFor({ timeout: 90_000 });
    await installOverlay(page);
    await caption(page, '5. 托管模式自动跟进任务', '任务状态仍然没有被擅自修改；更新动作被放进确认队列，用户可以批准或拒绝。');
    await sleep(17_000);

    await caption(page, '当前真实水平', '已经打通：DeepSeek 理解 + 工具执行 + A2A 协作 + 文件代发 + 日程风险门控 + 托管跟进。还未完成：图片内容视觉理解、外部日历接入、长期多轮主动项目经理。');
    await sleep(28_000);
  } finally {
    const video = page.video();
    if (!video) {
      await context.close();
      await browser.close();
      throw new Error('Playwright did not create a video artifact.');
    }
    await page.close();
    await video.saveAs(outputWebm);
    await context.close();
    await browser.close();
  }

  await convertToMp4(outputWebm, outputMp4);
  console.log(JSON.stringify({
    ok: true,
    webUrl,
    apiBaseUrl,
    outputWebm,
    outputMp4,
    deepseek: 'connected'
  }, null, 2));
}

async function prepareDemoState() {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const state = createDemoState();
  const chen = state.users.find((user) => user.id === 'user-chen');
  const sourceMessage = {
    id: 'msg-video-task-source',
    roomId: 'room-team',
    senderId: 'user-zhao',
    senderName: '赵一鸣',
    body: '陈晨负责访谈附录截图，明天 18:00 前需要开始处理。',
    sentAt: '2026-05-05T09:00:00+08:00',
    type: 'text'
  };
  const nextState = {
    ...state,
    messages: [...state.messages, sourceMessage],
    tasks: [
      ...state.tasks.map((task) => ({ ...task, status: task.status === 'pending' ? 'done' : task.status })),
      {
        id: 'task-video-follow-up',
        title: '访谈附录截图补齐',
        deadline: '5月6日 18:00',
        owners: [chen?.name ?? '陈晨'],
        status: 'pending',
        sourceMessageId: sourceMessage.id
      }
    ],
    agentAutopilotPolicies: state.agentAutopilotPolicies.map((policy) =>
      ['agent-lin', 'agent-chen', 'agent-zhao'].includes(policy.agentId)
        ? {
            ...policy,
            enabled: true,
            allowedRoomIds: Array.from(new Set([...policy.allowedRoomIds, 'room-team'])),
            allowedActions: Array.from(new Set([
              ...policy.allowedActions,
              'reply',
              'search_files',
              'share_low_risk_files',
              'suggest_task_updates',
              'coordinate_schedule',
              'a2a_negotiate'
            ]))
          }
        : policy
    )
  };
  await writeFile(dbPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
  await writeFile(
    viteConfigPath,
    [
      "import { defineConfig } from 'vite';",
      "import react from '@vitejs/plugin-react';",
      '',
      'export default defineConfig({',
      '  plugins: [react()],',
      '  server: {',
      '    proxy: {',
      `      '/api': '${apiBaseUrl}'`,
      '    }',
      '  }',
      '});',
      ''
    ].join('\n'),
    'utf8'
  );
}

async function runAgentPrompt(page, text) {
  await page.locator('#agent-prompt').fill(text);
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/api/agent/run') && response.request().method() === 'POST',
      { timeout: 120_000 }
    ),
    page.getByRole('button', { name: 'send agent prompt' }).click()
  ]);
  await page.locator('.result-panel').waitFor({ timeout: 90_000 });
}

async function installOverlay(page) {
  await page.addStyleTag({
    content: `
      #demo-video-caption {
        position: fixed;
        left: 32px;
        right: 32px;
        bottom: 28px;
        z-index: 99999;
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 18px;
        align-items: center;
        padding: 18px 22px;
        border: 1px solid rgba(13, 115, 120, 0.28);
        border-radius: 18px;
        background: rgba(247, 251, 251, 0.94);
        box-shadow: 0 18px 60px rgba(7, 21, 24, 0.22);
        font-family: "IBM Plex Sans", Arial, sans-serif;
        color: #102326;
        backdrop-filter: blur(14px);
        pointer-events: none;
      }
      #demo-video-caption .demo-mark {
        width: 46px;
        height: 46px;
        border-radius: 13px;
        display: grid;
        place-items: center;
        background: #0d7378;
        color: #fff;
        font-weight: 800;
        font-size: 22px;
      }
      #demo-video-caption strong {
        display: block;
        font-size: 23px;
        line-height: 1.2;
        margin-bottom: 5px;
      }
      #demo-video-caption span {
        display: block;
        font-size: 17px;
        line-height: 1.55;
        color: #3b5559;
      }
    `
  });
  await page.evaluate(() => {
    let caption = document.querySelector('#demo-video-caption');
    if (!caption) {
      caption = document.createElement('div');
      caption.id = 'demo-video-caption';
      caption.innerHTML = '<div class="demo-mark">A</div><div><strong></strong><span></span></div>';
      document.body.appendChild(caption);
    }
  });
}

async function caption(page, title, body) {
  await page.evaluate(({ title, body }) => {
    const root = document.querySelector('#demo-video-caption');
    if (!root) return;
    root.querySelector('strong').textContent = title;
    root.querySelector('span').textContent = body;
  }, { title, body });
}

function startProcess(label, command, args, env) {
  const logPath = join(workDir, `${label}.log`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: process.platform === 'win32'
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`${label} exited with code ${code}; see ${logPath}`);
    }
  });
  return child;
}

function localBin(name) {
  return resolve(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`${url} failed ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function convertToMp4(input, output) {
  await execFilePromise('ffmpeg', [
    '-y',
    '-i',
    input,
    '-t',
    '120',
    '-vf',
    'tpad=stop_mode=clone:stop_duration=120,scale=1440:900',
    '-r',
    '30',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output
  ]);
  const stat = await readFile(output);
  if (stat.byteLength === 0) {
    throw new Error(`ffmpeg produced empty file: ${output}`);
  }
}

function execFilePromise(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { cwd: root }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(`${command} failed: ${stderr || stdout || error.message}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function cleanup() {
  await Promise.all(children.map((child) => stopProcessTree(child)));
}

function stopProcessTree(child) {
  return new Promise((resolvePromise) => {
    if (!child.pid || child.exitCode !== null) {
      resolvePromise();
      return;
    }
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolvePromise());
      return;
    }
    child.once('exit', () => resolvePromise());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, 2_000).unref();
  });
}

main()
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(cleanup);
