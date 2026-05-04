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

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.getByText('让陈晨回复').waitFor({ timeout: 60_000 });
  await page.getByText('Agent 找文件').waitFor({ timeout: 60_000 });
  await page.getByRole('heading', { name: '结构化记忆' }).waitFor({ timeout: 60_000 });
  await page.getByRole('heading', { name: '自动聊天' }).waitFor({ timeout: 60_000 });

  const [autoReplyHttpResponse] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/api/messages') && response.request().method() === 'POST',
      { timeout: 120_000 }
    ),
    (async () => {
      await page.getByRole('textbox', { name: 'message' }).fill('@陈晨 浏览器 smoke：请同步一下访谈材料进度。');
      await page.getByRole('button', { name: 'send message' }).click();
    })()
  ]);
  const autoReplyPayload = await autoReplyHttpResponse.json();
  if (!Array.isArray(autoReplyPayload.autoReplies) || autoReplyPayload.autoReplies.length === 0) {
    throw new Error('Expected /api/messages to return at least one automatic AI reply.');
  }

  await page.getByRole('button', { name: /让陈晨回复/ }).click();
  await page.getByText('AI 角色已发言').waitFor({ timeout: 120_000 });

  await page.locator('#agent-prompt').fill('please send the action plan');
  await page.getByRole('button', { name: /Agent 找文件/ }).click();
  await page.getByText('Agent 找文件').waitFor({ timeout: 120_000 });

  await page.getByRole('button', { name: /离线代发/ }).click();
  await page.getByText('Agent 代发文件').waitFor({ timeout: 120_000 });

  await page.getByRole('button', { name: /生成真实文件/ }).click();
  await page.getByText('真实文件已生成').waitFor({ timeout: 120_000 });

  await page.getByRole('button', { name: /同步 Matrix/ }).click();
  await page.getByText('Matrix 同步').waitFor({ timeout: 120_000 });

  await page.screenshot({ path: 'tmp/agent-im-browser-smoke.png', fullPage: true });
  console.log(JSON.stringify({
    ok: true,
    url: baseUrl,
    screenshot: 'tmp/agent-im-browser-smoke.png',
    pageErrors,
    consoleErrors
  }));
} finally {
  await browser.close();
}
