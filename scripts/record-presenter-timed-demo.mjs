import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const apiPort = Number(process.env.AGENT_IM_DEMO_API_PORT ?? 8794);
const webPort = Number(process.env.AGENT_IM_DEMO_WEB_PORT ?? 5186);
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}/?presenter=1`;
const outputDir = resolve(root, 'demo-output');
const rawDir = resolve(outputDir, 'raw-presenter-timed');
const outputWebm = resolve(outputDir, 'agentbridge-presenter-timed-demo.webm');
const outputMp4 = resolve(outputDir, 'agentbridge-presenter-timed-demo.mp4');

const totalMs = Number(process.env.DEMO_TOTAL_MS ?? 180_000);
const initialMs = Number(process.env.DEMO_INITIAL_MS ?? 30_000);
const stepMs = Number(process.env.DEMO_STEP_MS ?? 15_000);
const stepCount = Number(process.env.DEMO_STEP_COUNT ?? 8);
const viewport = { width: 1920, height: 1080 };

async function main() {
  await execFilePromise('npm', ['run', 'demo:prepare']);
  await waitForHttp(`${apiBaseUrl}/api/state`, 30_000);
  await waitForHttp(webUrl, 30_000);
  await mkdir(rawDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    recordVideo: {
      dir: rawDir,
      size: viewport
    }
  });
  const page = await context.newPage();
  let video;

  try {
    await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.locator('.chat-panel').waitFor({ timeout: 90_000 });
    await page.locator('.agent-workbench').waitFor({ timeout: 90_000 });

    if (await page.locator('.demo-script-bar').count()) {
      throw new Error('Presenter URL unexpectedly shows explicit script controls.');
    }

    const startedAt = Date.now();
    for (let index = 0; index < stepCount; index += 1) {
      await sleepUntil(startedAt + initialMs + index * stepMs);
      await page.locator('.message-list').click({ position: { x: 24, y: 24 }, timeout: 15_000 });
    }
    await sleepUntil(startedAt + totalMs);

    video = page.video();
    if (!video) {
      throw new Error('Playwright did not create a video artifact.');
    }
    await page.close();
    await video.saveAs(outputWebm);
  } finally {
    await context.close();
    await browser.close();
  }

  await convertToMp4(outputWebm, outputMp4);
  const state = await getJson(`${apiBaseUrl}/api/state`);
  console.log(JSON.stringify({
    ok: true,
    timing: {
      totalSeconds: totalMs / 1000,
      firstAdvanceAtSeconds: initialMs / 1000,
      advanceEverySeconds: stepMs / 1000,
      steps: stepCount
    },
    state: {
      messages: state.messages?.length,
      a2aSessions: state.a2aSessions?.length,
      actionRequests: state.actionRequests?.length
    },
    outputWebm,
    outputMp4
  }, null, 2));
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
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

async function getJson(url) {
  const response = await fetch(url);
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
    String(totalMs / 1000),
    '-vf',
    `scale=${viewport.width}:${viewport.height}`,
    '-r',
    '30',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-an',
    '-movflags',
    '+faststart',
    output
  ]);
}

function execFilePromise(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { cwd: root, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(`${command} ${args.join(' ')} failed: ${stderr || error.message}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function sleepUntil(targetTime) {
  const delay = targetTime - Date.now();
  if (delay > 0) {
    await sleep(delay);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
