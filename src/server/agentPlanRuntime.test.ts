// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { AiProvider } from './aiProvider';
import { createAppServer } from './appServer';

const servers: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('agent plan runtime', () => {
  it('executes LLM AgentPlan tool calls and exposes the user-visible plan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-plan-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const aiProvider = createSequenceAiProvider([
      JSON.stringify({
        mode: 'execute',
        intent: 'deadline',
        userVisiblePlan: 'Use the deadline tool against room tasks and deadline messages.',
        toolCalls: [{ tool: 'deadline.answer', args: { question: 'deadline?' } }],
        risk: { level: 'low', score: 0.1, reason: 'Read-only deadline answer.', model: 'planner-test' },
        citations: ['msg-02']
      }),
      JSON.stringify({ answer: 'The assignment deadline is May 12 at 23:59.', sources: ['msg-02'] })
    ]);
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: 'deadline?'
      })
    });

    expect(response.intent).toBe('deadline');
    expect(response.plan).toBe('Use the deadline tool against room tasks and deadline messages.');
    expect(response.result.answer).toContain('May 12');
    expect(response.log.toolCalls).toContain('deadline.answer');
    const plannerInput = String(aiProvider.calls[0].input);
    expect(plannerInput.indexOf('# Authorized Agent Context')).toBeGreaterThanOrEqual(0);
    expect(plannerInput.indexOf('## Current User Request')).toBeGreaterThan(
      plannerInput.indexOf('# Authorized Agent Context')
    );
    expect(plannerInput.lastIndexOf('deadline?')).toBeGreaterThan(plannerInput.indexOf('## Current User Request'));
    expect(aiProvider.calls[0].messages).toEqual([
      expect.objectContaining({ role: 'system' }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('# Authorized Agent Context') }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('## Current User Request') })
    ]);
    expect(String(aiProvider.calls[0].instructions)).toContain('Default internal context scope is the current room/chat only');
    expect(String(aiProvider.calls[0].instructions)).toContain('DeepSeek search');
    expect(String((aiProvider.calls[0].messages as Array<{ content: string }>)[1].content)).not.toContain('## Agent memory');
  });

  it('does not auto-send metadata-only files even when the LLM plan and file assessment are low risk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-plan-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const aiProvider = createSequenceAiProvider([
      JSON.stringify({
        mode: 'execute',
        intent: 'share_file',
        userVisiblePlan: 'Share the latest slides if the file is real and authorized.',
        toolCalls: [{ tool: 'file.share', args: { requesterId: 'user-chen' } }],
        risk: { level: 'low', score: 0.12, reason: 'Same room and authorized.', model: 'planner-test' },
        citations: ['file-slides-v3']
      }),
      JSON.stringify({
        matchedFileId: 'file-slides-v3',
        risk: { level: 'low', score: 0.12, reason: 'Same room and authorized.' },
        reasoning: 'The request matches the newest slide deck.'
      })
    ]);
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: '把最新演示稿发给陈晨',
        targetUserId: 'user-chen'
      })
    });

    expect(response.intent).toBe('share_file');
    expect(response.result.file.id).toBe('file-slides-v3');
    expect(response.result.status).toBe('needs_confirmation');
    expect(response.result.message).toBeUndefined();
    expect(response.actionRequest.status).toBe('needs_confirmation');
  });

  it('falls back with fallback.local_rules when the LLM plan JSON is invalid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-plan-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      aiProvider: createSequenceAiProvider(['not json'])
    });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: 'who can you act for?'
      })
    });

    expect(response.intent).toBe('chat');
    expect(response.log.toolCalls).toContain('fallback.local_rules');
  });

  it('answers fallback chat questions from authorized text file chunks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-plan-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const state = createDemoState();
    state.files.unshift({
      id: 'file-text-evidence',
      name: 'browser-context-notes.txt',
      uploaderId: 'user-lin',
      version: 1,
      roomId: 'room-team',
      updatedAt: '2026-05-04T12:00:00+08:00',
      visibility: 'room',
      agentCanShare: true,
      tags: ['notes'],
      summary: 'Text notes uploaded by the user.',
      mxcUri: 'mxc://demo/browser-context-notes.txt',
      contentType: 'text/plain',
      size: 132
    });
    state.fileTextChunks.unshift({
      id: 'file-text-evidence-chunk-0',
      fileId: 'file-text-evidence',
      roomId: 'room-team',
      uploaderId: 'user-lin',
      index: 0,
      text: '引用一致性需要陈晨核对，行动计划和访谈纪要要对齐。',
      createdAt: '2026-05-04T12:00:00+08:00'
    });
    await writeFile(dbPath, JSON.stringify(state, null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: '引用一致性在哪里提到？'
      })
    });

    expect(response.intent).toBe('chat');
    expect(response.result.reply).toContain('browser-context-notes.txt');
    expect(response.result.reply).toContain('引用一致性');
    expect(response.log.contextIds).toContain('file-text-evidence-chunk-0');
  });

  it('does not trust LLM chat answers about internal facts when citations are missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-plan-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(
      dbPath,
      JSON.stringify(
        {
          ...createDemoState(),
          messages: [],
          files: [],
          fileTextChunks: [],
          tasks: []
        },
        null,
        2
      ),
      'utf8'
    );
    const aiProvider = createSequenceAiProvider([
      JSON.stringify({
        mode: 'answer',
        intent: 'chat',
        userVisiblePlan: 'Answer from project context.',
        answer: '访谈材料由陈晨负责。',
        toolCalls: [{ tool: 'chat.answer', args: {} }],
        risk: { level: 'low', score: 0.1, reason: 'Read-only answer.', model: 'planner-test' },
        citations: []
      })
    ]);
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: '访谈材料现在谁负责？'
      })
    });

    expect(response.intent).toBe('chat');
    expect(response.result.reply).toContain('没有找到');
    expect(response.result.reply).not.toContain('陈晨负责');
    expect(response.log.contextIds).not.toContain('msg-made-up');
  });

  it('blocks unauthorized delegated messages through the policy engine', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-plan-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const aiProvider = createSequenceAiProvider([
      JSON.stringify({
        mode: 'execute',
        intent: 'send_message',
        userVisiblePlan: 'Send the delegated message only if policy allows it.',
        toolCalls: [
          {
            tool: 'message.send',
            args: {
              targetRoomId: 'room-class',
              targetUserId: 'user-teacher',
              messageBody: 'Please post this on my behalf.'
            }
          }
        ],
        risk: { level: 'low', score: 0.1, reason: 'Planner only proposes the action.', model: 'planner-test' },
        citations: []
      })
    ]);
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-chen',
        roomId: 'room-team',
        userText: 'send message to the class room.'
      })
    });

    expect(response.intent).toBe('send_message');
    expect(response.requiresHuman).toBe(false);
    expect(response.actionRequest).toBeUndefined();
    expect(response.message).toBeUndefined();
    expect(response.result.status).toBe('blocked');
    expect(response.result.message).toBeUndefined();
    expect(response.result.risk.model).toBe('policy-engine-v1');
    expect(response.log.status).toBe('blocked');
    expect(response.log.toolCalls).toContain('tool_executor.message.send');
    expect(response.log.toolCalls).toContain('message.send');
    expect(response.log.toolCalls).not.toContain('matrix.send_event');
  });

  it('includes request-matched file text excerpts in the LLM planner prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-plan-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const state = createDemoState();
    const file = {
      id: 'file-many-chunks',
      name: 'many-context-notes.txt',
      uploaderId: 'user-lin',
      version: 1,
      roomId: 'room-team',
      updatedAt: '2026-05-04T12:00:00+08:00',
      visibility: 'room' as const,
      agentCanShare: true,
      tags: ['notes'],
      summary: 'Long notes with one relevant excerpt.',
      mxcUri: 'mxc://demo/many-context-notes.txt',
      contentType: 'text/plain',
      size: 512
    };
    await writeFile(
      dbPath,
      JSON.stringify(
        {
          ...state,
          files: [file, ...state.files],
          fileTextChunks: [
            ...Array.from({ length: 6 }, (_, index) => ({
              id: `many-context-generic-${index}`,
              fileId: file.id,
              roomId: 'room-team',
              uploaderId: 'user-lin',
              index,
              text: `generic context filler ${index}`,
              createdAt: '2026-05-04T12:00:00+08:00'
            })),
            {
              id: 'many-context-target',
              fileId: file.id,
              roomId: 'room-team',
              uploaderId: 'user-lin',
              index: 99,
              text: 'rare retrieval marker: sodium-router migration owner is Lin.',
              createdAt: '2026-05-04T12:00:00+08:00'
            }
          ]
        },
        null,
        2
      ),
      'utf8'
    );
    const aiProvider = createSequenceAiProvider([
      JSON.stringify({
        mode: 'answer',
        intent: 'chat',
        userVisiblePlan: 'Answer from the matched file excerpt.',
        answer: 'Lin owns the sodium-router migration.',
        toolCalls: [{ tool: 'chat.answer', args: {} }],
        risk: { level: 'low', score: 0.1, reason: 'Read-only answer.', model: 'planner-test' },
        citations: ['many-context-target']
      })
    ]);
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider });
    servers.push(app);

    await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: 'Who owns the sodium-router migration?'
      })
    });

    expect(String(aiProvider.calls[0].input)).toContain('many-context-target');
    expect(String(aiProvider.calls[0].input)).toContain('sodium-router migration owner is Lin');
  });

  it('queues medium or high risk coordination instead of sending it directly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-plan-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: '把周二合稿检查改到周三 23:00，请和陈晨的 Agent 协调。'
      })
    });

    expect(response.intent).toBe('coordinate');
    expect(response.requiresHuman).toBe(true);
    expect(response.message).toBeUndefined();
    expect(response.actionRequest).toMatchObject({
      kind: 'coordinate',
      status: 'needs_confirmation',
      requiresHuman: true,
      input: {
        calendarPatch: {
          itemId: 'cal-review',
          oldStartsAt: '2026-05-05T20:30:00+08:00',
          newStartsAt: '2026-05-06T23:00:00+08:00'
        }
      }
    });
    expect(response.log.toolCalls).toContain('agent.coordinate');
  });

  it('queues task update suggestions for confirmation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-plan-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: '建议把访谈材料任务标记为进行中'
      })
    });

    expect(response.intent).toBe('task_update_suggest');
    expect(response.requiresHuman).toBe(true);
    expect(response.actionRequest).toMatchObject({
      kind: 'task_update_suggest',
      status: 'needs_confirmation',
      requiresHuman: true
    });
    expect(response.log.toolCalls).toContain('task.suggest_update');
  });

  it('uses external web search when the plan requests online information', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-plan-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const aiProvider = createSequenceAiProvider([
      JSON.stringify({
        mode: 'execute',
        intent: 'web_search',
        userVisiblePlan: 'Search the web, then answer with cited public sources.',
        toolCalls: [{ tool: 'web.search', args: { query: 'DeepSeek API current model' } }],
        risk: { level: 'low', score: 0.08, reason: 'Read-only external search.', model: 'planner-test' },
        citations: []
      }),
      'DeepSeek current API docs mention deepseek-chat. [1]'
    ]);
    const webSearchProvider = {
      async search(query: string) {
        expect(query).toBe('DeepSeek API current model');
        return [
          {
            title: 'DeepSeek API Docs',
            url: 'https://api-docs.deepseek.com/',
            snippet: 'The current chat model is deepseek-chat.'
          }
        ];
      }
    };
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider, webSearchProvider });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: '帮我网上搜一下 DeepSeek API 当前模型'
      })
    });

    expect(response.intent).toBe('web_search');
    expect(response.result.answer).toContain('deepseek-chat');
    expect(response.result.results[0]).toMatchObject({
      title: 'DeepSeek API Docs',
      url: 'https://api-docs.deepseek.com/'
    });
    expect(response.result.citations).toContain('https://api-docs.deepseek.com/');
    expect(response.log.toolCalls).toContain('web.search');
    expect(response.log.toolCalls).toContain('deepseek.pro.chat.completions');
  });

  it('does not pretend web search succeeded when no search provider is available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-plan-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const aiProvider = createSequenceAiProvider([
      JSON.stringify({
        mode: 'execute',
        intent: 'web_search',
        userVisiblePlan: 'Try web search before answering.',
        toolCalls: [{ tool: 'web.search', args: { query: 'latest policy' } }],
        risk: { level: 'low', score: 0.08, reason: 'Read-only external search.', model: 'planner-test' },
        citations: []
      })
    ]);
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      aiProvider,
      webSearchProvider: null
    });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: '查一下最新政策'
      })
    });

    expect(response.intent).toBe('web_search');
    expect(response.result.answer).toContain('外部搜索工具不可用');
    expect(response.result.results).toEqual([]);
    expect(response.log.toolCalls).toContain('web.search.unavailable');
  });
});

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  expect(response.ok).toBe(true);
  return response.json();
}

function createSequenceAiProvider(texts: string[]): AiProvider & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  let index = 0;
  return {
    calls,
    async generateText(prompt) {
      calls.push(prompt as unknown as Record<string, unknown>);
      const next = texts[index] ?? texts[texts.length - 1];
      index += 1;
      return next;
    }
  };
}
