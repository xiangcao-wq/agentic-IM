import { chromium } from 'playwright';

const baseUrl = process.env.AGENT_IM_WEB_URL ?? 'http://127.0.0.1:5175';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
const consoleErrors = [];

page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text());
  }
});

async function waitForWorkbenchReady() {
  await page.locator('.chat-panel').waitFor({ timeout: 120_000 });
  await page.locator('.agent-workbench').waitFor({ timeout: 120_000 });
  await page.locator('.agent-dock .action-grid').waitFor({ timeout: 120_000 });
  await page.locator('.chat-panel > .composer input[aria-label="chat composer"]').waitFor({ timeout: 120_000 });
  await page.locator('#agent-prompt').waitFor({ timeout: 120_000 });
}

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitForWorkbenchReady();

  const [policyPatchResponse] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/api/agent/autopilot-policy') && response.request().method() === 'PATCH',
      { timeout: 120_000 }
    ),
    page.getByRole('button', { name: /开启托管|关闭托管/ }).click()
  ]);
  if (!policyPatchResponse.ok()) {
    throw new Error(`Autopilot policy toggle failed with HTTP ${policyPatchResponse.status()}`);
  }
  const restorePolicy = await page.request.patch(`${baseUrl}/api/agent/autopilot-policy`, {
    data: {
      agentId: 'agent-lin',
      enabled: true,
      roomId: 'room-team',
      roomEnabled: true
    }
  });
  if (!restorePolicy.ok()) {
    throw new Error(`Autopilot policy restore failed with HTTP ${restorePolicy.status()}`);
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitForWorkbenchReady();

  const [sweepResponse] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/api/agent/autopilot/worker/run') && response.request().method() === 'POST',
      { timeout: 120_000 }
    ),
    page.locator('.autopilot-sweep-button').click()
  ]);
  if (!sweepResponse.ok()) {
    throw new Error(`Autopilot pending sweep failed with HTTP ${sweepResponse.status()}`);
  }
  const sweepPayload = await sweepResponse.json();

  const [agentRunResponse] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/api/agent/run') && response.request().method() === 'POST',
      { timeout: 120_000 }
    ),
    (async () => {
      await page.locator('#agent-prompt').fill('谁负责访谈材料？');
      await page.getByRole('button', { name: 'send agent prompt' }).click();
    })()
  ]);
  const agentRunPayload = await agentRunResponse.json();
  if (agentRunPayload.intent !== 'chat') {
    throw new Error(`Expected Agent chat intent, received ${agentRunPayload.intent}`);
  }
  await page.locator('.result-panel').waitFor({ timeout: 120_000 });

  const a2aResponse = await page.request.post(`${baseUrl}/api/messages`, {
    data: {
      roomId: 'room-team',
      senderId: 'user-chen',
      body: 'Lin is offline. Can her Agent send the latest slides to Chen?'
    }
  });
  if (!a2aResponse.ok()) {
    throw new Error(`A2A trigger failed with HTTP ${a2aResponse.status()}`);
  }
  const a2aPayload = await a2aResponse.json();
  if (!Array.isArray(a2aPayload.autopilotSessions) || a2aPayload.autopilotSessions.length === 0) {
    throw new Error('Expected /api/messages to return an autopilot A2A session.');
  }

  const a2aChatResponse = await page.request.post(`${baseUrl}/api/messages`, {
    data: {
      roomId: 'room-team',
      senderId: 'user-chen',
      body: 'Lin Agent, who is responsible for interview materials?'
    }
  });
  if (!a2aChatResponse.ok()) {
    throw new Error(`A2A chat trigger failed with HTTP ${a2aChatResponse.status()}`);
  }
  const a2aChatPayload = await a2aChatResponse.json();
  if (!Array.isArray(a2aChatPayload.autopilotMessages) || a2aChatPayload.autopilotMessages.length === 0) {
    throw new Error('Expected explicit Agent mention to return an autopilot chat message.');
  }

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitForWorkbenchReady();
  await page.locator('[data-testid="a2a-session-panel"]').waitFor({ timeout: 120_000 });

  await page.screenshot({ path: 'tmp/agent-im-browser-smoke.png', fullPage: true });
  console.log(
    JSON.stringify({
      ok: true,
      url: baseUrl,
      screenshot: 'tmp/agent-im-browser-smoke.png',
      agentIntent: agentRunPayload.intent,
      a2aSessions: a2aPayload.autopilotSessions.length,
      a2aChatMessages: a2aChatPayload.autopilotMessages.length,
      autopilotToggle: 'ok',
      autopilotSweep: {
        processed: sweepPayload.processedMessageIds?.length ?? 0,
        skipped: sweepPayload.skippedMessageIds?.length ?? 0
      },
      pageErrors,
      consoleErrors
    })
  );
} finally {
  await browser.close();
}
