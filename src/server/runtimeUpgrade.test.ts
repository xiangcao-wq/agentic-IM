// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { DemoState } from '../domain/types';
import type { AiProvider } from './aiProvider';
import { createAppServer } from './appServer';
import { createRuntimeDemoAssets } from './demoAssets';

const servers: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runtime upgrade APIs', () => {
  it('generates a real-time AI human reply and writes it through Matrix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const bootstrapPath = join(dir, 'matrix-bootstrap.json');
    const matrix = await createMatrixStub();
    servers.push(matrix);
    await writeBootstrap(bootstrapPath, matrix.url);
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const aiProvider = createFakeAiProvider('陈晨：我刚看了行动计划，今晚可以先补访谈截图。');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: bootstrapPath, aiProvider });
    servers.push(app);

    const reply = await requestJson(`${app.url}/api/ai/human-reply`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        userId: 'user-chen',
        prompt: '请基于当前小组任务自然回复一句。'
      })
    });
    const state = await requestJson(`${app.url}/api/state`);

    expect(reply.message.body).toContain('访谈截图');
    expect(reply.log.toolCalls).toContain('deepseek.flash.chat.completions');
    expect(aiProvider.calls[0]).toMatchObject({ actorRole: 'human_user', actorId: 'user-chen' });
    expect(aiProvider.calls[0].messages).toEqual([
      expect.objectContaining({ role: 'system' }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('# Authorized Agent Context') }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('## Human Reply Request') })
    ]);
    expect(String((aiProvider.calls[0].messages as Array<{ content: string }>)[1].content)).toContain('## Members');
    expect(String((aiProvider.calls[0].messages as Array<{ content: string }>)[1].content)).not.toContain('## Recent messages');
    expect(state.messages.some((message: { id: string; body: string }) => message.id.startsWith('$') && message.body.includes('访谈截图'))).toBe(true);
  });

  it('runs unified Agent intents, writes memory, and enforces cross-room authorization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createStateWithShareablePlan(), null, 2), 'utf8');
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      aiProvider: createFakeAiProvider('Agent 计划：先检索任务和文件，再执行低风险动作。')
    });
    servers.push(app);

    const summary = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'summary',
        userText: '总结小组和班级上下文'
      })
    });
    const memories = await requestJson(`${app.url}/api/memories?agentId=agent-lin`);
    const deadline = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'deadline',
        userText: '这次作业什么时候截止？'
      })
    });
    const share = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'share_file',
        userText: '把最新行动计划发一下'
      })
    });
    const denied = await fetch(`${app.url}/api/agent/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-chen',
        roomId: 'room-class',
        intent: 'deadline',
        userText: '读取班级群截止日期'
      })
    });

    expect(summary.memory.kind).toBe('summary');
    expect(memories.memories.some((memory: { id: string }) => memory.id === summary.memory.id)).toBe(true);
    expect(deadline.result.answer).toContain('5月12日 23:59');
    expect(deadline.memory.sourceIds.length).toBeGreaterThan(0);
    expect(share.result.status).toBe('executed');
    expect(share.result.file).toMatchObject({
      name: '第4组-校园服务数字化调研-行动计划.pdf',
      mxcUri: 'mxc://localhost/plan'
    });
    expect(share.result.message).toMatchObject({
      senderName: '林雯',
      agentLabel: '个人助手代发',
      mxcUri: 'mxc://localhost/plan',
      contentType: 'application/pdf',
      size: 708
    });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('cannot read room-class');
  });

  it('defaults /api/agent/run to an LLM-directed chat response when intent is omitted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const aiProvider = createSequenceAiProvider([
      JSON.stringify({
        intent: 'chat',
        plan: 'Answer directly from the structured room context.',
        answer: 'The current team room is focused on assignment planning and file handoff.'
      })
    ]);
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: 'What is this room about?'
      })
    });

    expect(response.intent).toBe('chat');
    expect(response.plan).toBe('Answer directly from the structured room context.');
    expect(response.result.reply).toContain('assignment planning');
    expect(aiProvider.calls).toHaveLength(2);
    expect(String(aiProvider.calls[1].instructions)).toContain('用户回复指引');
    expect(String(aiProvider.calls[1].input)).not.toContain('## Recent agent logs');
  });

  it('treats tell-me phrasing as a direct Agent answer instead of delegated message sending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const aiProvider = createSequenceAiProvider([
      JSON.stringify({
        mode: 'execute',
        intent: 'send_message',
        userVisiblePlan: 'Incorrectly treat the phrase as message sending.',
        toolCalls: [{ tool: 'message.send', args: { targetRoomId: 'room-team', messageBody: '下一步' } }],
        risk: { level: 'low', score: 0.1, reason: 'misclassified direct answer', model: 'test-planner' }
      }),
      '下一步先确认报告 PDF 和演示稿版本，再处理需要人工确认的文件代发。'
    ]);
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: '请告诉我下一步需要做什么'
      })
    });

    expect(response.intent).toBe('chat');
    expect(response.result.reply).toContain('下一步先确认');
    expect(response.message).toBeUndefined();
    expect(response.log.toolCalls).not.toContain('message.send');
  });

  it('answers next-step fallback questions from current room tasks before file excerpts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: '请告诉我下一步需要做什么'
      })
    });

    expect(response.intent).toBe('chat');
    expect(response.result.reply).toContain('下一步先处理');
    expect(response.result.reply).toContain('截止时间');
    expect(response.result.reply).not.toContain('agent-collaboration-protocol');
  });

  it('keeps local Agent run results when Matrix delivery is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const bootstrapPath = join(dir, 'matrix-bootstrap.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    await writeBootstrap(bootstrapPath, 'http://127.0.0.1:1');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: bootstrapPath, aiProvider: null });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'send_message',
        targetRoomId: 'room-team',
        messageBody: '我稍后加入讨论',
        userText: '帮我发消息：我稍后加入讨论'
      })
    });

    expect(response.intent).toBe('send_message');
    expect(response.message).toMatchObject({
      roomId: 'room-team',
      body: '我稍后加入讨论'
    });
    expect(response.log.toolCalls).toContain('message.send');
  });

  it('sanitizes LLM-directed chat responses before returning them to the UI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const aiProvider = createSequenceAiProvider([
      JSON.stringify({
        intent: 'chat',
        plan: 'Answer directly.',
        answer: '**Chen owns the interview notes.**\nTool trace: deepseek.pro.chat.completions -> room_search -> memory.search\nReasoning: inspected room context first.',
        citations: ['msg-05']
      })
    ]);
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: 'Who owns the interview notes?'
      })
    });

    expect(response.intent).toBe('chat');
    expect(response.result.reply).toContain('Chen owns the interview notes');
    expect(response.result.reply).not.toContain('**');
    expect(response.result.reply).not.toContain('Tool trace');
    expect(response.result.reply).not.toContain('deepseek.pro');
    expect(response.result.reply).not.toContain('Reasoning');
  });

  it('uses the LLM decision intent instead of the legacy request intent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const aiProvider = createSequenceAiProvider([
      JSON.stringify({
        intent: 'summary',
        plan: 'The user asked for a recap, so run the room summarizer.',
        confidence: 0.93
      }),
      JSON.stringify({
        headline: 'LLM selected summary result',
        deadlines: ['2026-05-12 23:59'],
        todos: ['Prepare the final report'],
        sources: ['msg-01']
      })
    ]);
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'deadline',
        userText: 'Please summarize this room instead.'
      })
    });

    expect(response.intent).toBe('summary');
    expect(response.plan).toBe('The user asked for a recap, so run the room summarizer.');
    expect(response.result.headline).toBe('LLM selected summary result');
    expect(aiProvider.calls).toHaveLength(2);
  });

  it('answers deadline variants with contextual LLM responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const aiProvider = createSequenceAiProvider([
      JSON.stringify({ intent: 'deadline', plan: 'Check task deadlines for a casual Chinese phrasing.' }),
      JSON.stringify({ answer: '要在 5月12日 23:59 前提交。', sources: ['msg-02'] }),
      JSON.stringify({ intent: 'deadline', plan: 'Map the English deadline wording to the assignment due date.' }),
      JSON.stringify({ answer: 'The deadline is May 12 at 23:59.', sources: ['msg-02'] }),
      JSON.stringify({ intent: 'deadline', plan: 'Compare the due date with the current context and answer remaining time.' }),
      JSON.stringify({ answer: '距离截止还有大约 8 天，需要优先完成报告和演示稿。', sources: ['msg-02', 'task-report'] })
    ]);
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider });
    servers.push(app);

    const casual = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'deadline',
        userText: '什么时候交？'
      })
    });
    const english = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'deadline',
        userText: 'deadline 是？'
      })
    });
    const remaining = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'deadline',
        userText: '还有几天？'
      })
    });

    expect(casual.result.answer).toContain('5月12日 23:59');
    expect(english.result.answer).toContain('May 12');
    expect(remaining.result.answer).toContain('大约 8 天');
    expect(casual.plan).toContain('casual Chinese');
    expect(english.plan).toContain('English deadline');
    expect(remaining.plan).toContain('remaining time');
    expect(aiProvider.calls).toHaveLength(6);
  });

  it('computes remaining days in fallback deadline answers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: '这次作业还有几天截止？'
      })
    });

    expect(response.intent).toBe('deadline');
    expect(response.result.answer).toContain('还有大约');
    expect(response.result.answer).toContain('5月12日 23:59');
  });

  it('uses the LLM file-share assessment to pick a file and risk level', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createStateWithShareablePlan(), null, 2), 'utf8');
    const aiProvider = createSequenceAiProvider([
      JSON.stringify({
        intent: 'share_file',
        plan: 'Match the request to the latest authorized action plan and evaluate sharing risk.'
      }),
      JSON.stringify({
        matchedFileId: 'file-plan-latest',
        risk: {
          level: 'low',
          score: 0.16,
          reason: 'The requester is in the room and the file is explicitly shareable.'
        },
        reasoning: 'The action-plan wording matches the PDF title and tags.'
      })
    ]);
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'share_file',
        userText: 'please send the latest action plan',
        targetUserId: 'user-chen'
      })
    });

    expect(response.intent).toBe('share_file');
    expect(response.plan).toContain('latest authorized action plan');
    expect(response.result.file.id).toBe('file-plan-latest');
    expect(response.result.risk).toMatchObject({
      level: 'low',
      score: 0.16,
      model: 'policy-engine-v1'
    });
    expect(response.result.status).toBe('executed');
  });

  it('finds latest slides from mixed-language queries without duplicate display rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const state = createDemoState();
    const latestSlides = state.files.find((file) => file.id === 'file-slides-v3');
    expect(latestSlides).toBeTruthy();
    await writeFile(
      dbPath,
      JSON.stringify(
        {
          ...state,
          files: latestSlides
            ? [
                {
                  id: 'file-plan-decoy',
                  name: 'decoy action plan.pdf',
                  uploaderId: 'user-lin',
                  version: 20,
                  roomId: 'room-team',
                  updatedAt: '2026-05-04T11:00:00.000Z',
                  visibility: 'room',
                  agentCanShare: true,
                  tags: ['plan', 'pdf', 'slides'],
                  summary: 'Action plan PDF that is related but is not the slide deck.',
                  mxcUri: 'mxc://localhost/decoy-plan',
                  contentType: 'application/pdf',
                  size: 512
                },
                {
                  ...latestSlides,
                  id: 'file-slides-v3-older-copy',
                  version: 2,
                  updatedAt: '2026-05-03T10:00:00.000Z'
                },
                ...state.files
              ]
            : state.files
        },
        null,
        2
      ),
      'utf8'
    );
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'find_file',
        userText: 'latest slides'
      })
    });

    expect(response.files[0].id).toBe('file-slides-v3');
    expect(response.files.map((file: { id: string }) => file.id)).toContain('file-slides-v3');
    expect(new Set(response.files.map((file: { name: string }) => file.name)).size).toBe(response.files.length);
  });

  it('finds authorized files from approximate fuzzy wording', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'find_file',
        userText: 'intervew material'
      })
    });

    expect(response.files[0].id).toBe('file-interview-notes-txt');
    expect(response.files[0].name).toContain('访谈纪要');
  });

  it('surfaces metadata-only shareable files instead of saying no file was found', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'share_file',
        userText: '把最新演示稿发给陈晨',
        targetUserId: 'user-chen'
      })
    });

    expect(response.result.status).toBe('needs_confirmation');
    expect(response.result.file.id).toBe('file-slides-v3');
    expect(response.result.risk.reason).not.toContain('无法确认');
  });

  it('keeps responsibility questions as chat even when they mention materials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider: null });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: '现在谁在负责访谈材料？'
      })
    });

    expect(response.intent).toBe('chat');
    expect(response.result.reply).toContain('陈晨');
    expect(response.log.toolCalls).toContain('fallback.local_context');
  });

  it('guards LLM coordinate decisions for plain responsibility and priority questions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const aiProvider = createSequenceAiProvider([
      JSON.stringify({
        intent: 'coordinate',
        plan: 'The model over-classified this as coordination because it mentioned today priorities.',
        targetUserId: 'user-chen'
      }),
      '陈晨负责访谈材料；你今天先确认她补的食堂预约段，再准备周二 20:30 合稿检查。'
    ]);
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: null, aiProvider });
    servers.push(app);

    const response = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: '这个群现在谁负责访谈材料？我今天应该先做什么？'
      })
    });

    expect(response.intent).toBe('chat');
    expect(response.result.reply).toContain('陈晨');
    expect(response.result.reply).toContain('访谈纪要');
    expect(response.log.toolCalls).not.toContain('agent_to_agent.negotiate');
    expect(aiProvider.calls).toHaveLength(1);
  });

  it('falls back when the LLM provider fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      aiProvider: createFailingAiProvider()
    });
    servers.push(app);

    const deadline = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'deadline',
        userText: 'deadline?'
      })
    });
    const chat = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        userText: 'who can you act for?'
      })
    });

    expect(deadline.intent).toBe('deadline');
    expect(deadline.result.answer).toContain('5月12日 23:59');
    expect(deadline.plan).toBeTruthy();
    expect(chat.intent).toBe('chat');
    expect(chat.result.reply).toContain('林雯');
    expect(chat.result.reply).not.toContain('当前 AI 服务不可用');
    expect(chat.log.toolCalls).toContain('fallback.local_context');
    expect(chat.requiresHuman).toBe(false);
  });

  it('generates openable demo assets and uploads them to Matrix media', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const bootstrapPath = join(dir, 'matrix-bootstrap.json');
    const matrix = await createMatrixStub();
    servers.push(matrix);
    await writeBootstrap(bootstrapPath, matrix.url);
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: bootstrapPath });
    servers.push(app);

    const generated = await requestJson(`${app.url}/api/demo/assets/generate`, {
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-team',
        senderId: 'user-lin'
      })
    });

    const runtimeAssets = createRuntimeDemoAssets();
    expect(generated.files).toHaveLength(runtimeAssets.length);
    expect(generated.files.map((file: { contentType: string }) => file.contentType)).toEqual(
      runtimeAssets.map((asset) => asset.contentType)
    );
    expect(generated.files.every((file: { mxcUri?: string }) => file.mxcUri?.startsWith('mxc://localhost/'))).toBe(true);
  });

  it('queues unified Agent coordination instead of writing high-risk changes directly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const bootstrapPath = join(dir, 'matrix-bootstrap.json');
    const matrix = await createMatrixStub();
    servers.push(matrix);
    await writeBootstrap(bootstrapPath, matrix.url);
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: bootstrapPath,
      aiProvider: createFakeAiProvider('Agent 计划：先检查日程影响，再向对方 Agent 提出可审计安排。')
    });
    servers.push(app);

    const coordination = await requestJson(`${app.url}/api/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-lin',
        roomId: 'room-team',
        intent: 'coordinate',
        targetUserId: 'user-chen',
        userText: '把周二 20:30 的合稿检查改到周三 23:00，请和陈晨的个人助手协调。'
      })
    });
    const state = await requestJson(`${app.url}/api/state`);

    expect(coordination.message).toBeUndefined();
    expect(state.messages.some((message: { id: string; roomId: string; agentLabel?: string }) =>
      message.id.startsWith('$') &&
      message.roomId === 'room-agent' &&
      message.agentLabel === '个人助手协商'
    )).toBe(false);
    expect(coordination.actionRequest).toMatchObject({
      kind: 'coordinate',
      status: 'needs_confirmation',
      requiresHuman: true
    });
    expect(state.actionRequests.some((request: { id: string; kind: string; status: string }) =>
      request.id === coordination.actionRequest.id &&
      request.kind === 'coordinate' &&
      request.status === 'needs_confirmation'
    )).toBe(true);
  });

  it('syncs Matrix events once, persists checkpoints, and avoids duplicates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const bootstrapPath = join(dir, 'matrix-bootstrap.json');
    const matrix = await createMatrixStub({
      roomEvents: {
        '!team:localhost': [
          {
            event_id: '$external-1',
            sender: '@chen:localhost',
            origin_server_ts: Date.now(),
            type: 'm.room.message',
            content: {
              msgtype: 'm.text',
              body: '外部 Matrix 客户端发来的真实消息'
            }
          }
        ]
      }
    });
    servers.push(matrix);
    await writeBootstrap(bootstrapPath, matrix.url);
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: bootstrapPath });
    servers.push(app);

    const first = await requestJson(`${app.url}/api/matrix/sync-once`, { method: 'POST' });
    const second = await requestJson(`${app.url}/api/matrix/sync-once`, { method: 'POST' });
    const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as DemoState;

    expect(first.messagesAdded).toBe(1);
    expect(second.messagesAdded).toBe(0);
    expect(persisted.messages.filter((message) => message.id === '$external-1')).toHaveLength(1);
    expect(persisted.matrixObserverCheckpoints).toContainEqual({
      roomId: 'room-team',
      lastEventId: '$external-1'
    });
  });

  it('does not inject Matrix room history into plain state reads before explicit sync', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-runtime-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const bootstrapPath = join(dir, 'matrix-bootstrap.json');
    const matrix = await createMatrixStub({
      roomEvents: {
        '!team:localhost': [
          {
            event_id: '$history-noise',
            sender: '@chen:localhost',
            origin_server_ts: Date.now(),
            type: 'm.room.message',
            content: {
              msgtype: 'm.text',
              body: '联调测试消息不应在普通 state read 中自动污染 demo'
            }
          }
        ]
      }
    });
    servers.push(matrix);
    await writeBootstrap(bootstrapPath, matrix.url);
    await writeFile(dbPath, JSON.stringify(createDemoState(), null, 2), 'utf8');
    const app = await createAppServer({ dbPath, port: 0, matrixBootstrapPath: bootstrapPath });
    servers.push(app);

    const beforeSync = await requestJson(`${app.url}/api/state`);
    const sync = await requestJson(`${app.url}/api/matrix/sync-once`, { method: 'POST' });
    const afterSync = await requestJson(`${app.url}/api/state`);

    expect(beforeSync.messages.some((message: { id: string }) => message.id === '$history-noise')).toBe(false);
    expect(sync.messagesAdded).toBe(1);
    expect(afterSync.messages.some((message: { id: string }) => message.id === '$history-noise')).toBe(true);
  });
});

function createFakeAiProvider(text: string): AiProvider & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async generateText(prompt) {
      calls.push(prompt as unknown as Record<string, unknown>);
      return text;
    }
  };
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

function createFailingAiProvider(): AiProvider {
  return {
    async generateText() {
      throw new Error('LLM unavailable');
    }
  };
}

function createStateWithShareablePlan(): DemoState {
  const state = createDemoState();
  return {
    ...state,
    files: [
      {
        id: 'file-plan-latest',
        name: '第4组-校园服务数字化调研-行动计划.pdf',
        uploaderId: 'user-lin',
        version: 9,
        roomId: 'room-team',
        updatedAt: '2026-05-04T09:00:00.000Z',
        visibility: 'room',
        agentCanShare: true,
        tags: ['plan', 'pdf', 'slides'],
        summary: '行动计划，截止时间 5月12日 23:59，可由 Agent 代发。',
        mxcUri: 'mxc://localhost/plan',
        contentType: 'application/pdf',
        size: 708
      },
      ...state.files
    ]
  };
}

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  expect(response.ok).toBe(true);
  return response.json();
}

async function writeBootstrap(path: string, homeserverUrl: string): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      homeserverUrl,
      users: {
        'user-lin': { matrixUserId: '@lin:localhost', accessToken: 'token-lin' },
        'user-chen': { matrixUserId: '@chen:localhost', accessToken: 'token-chen' },
        'user-zhao': { matrixUserId: '@zhao:localhost', accessToken: 'token-zhao' },
        'user-teacher': { matrixUserId: '@teacher:localhost', accessToken: 'token-teacher' }
      },
      rooms: {
        'room-class': '!class:localhost',
        'room-team': '!team:localhost',
        'room-agent': '!agent:localhost'
      }
    }),
    'utf8'
  );
}

interface MatrixStubEvent {
  event_id: string;
  sender: string;
  origin_server_ts: number;
  type: string;
  content?: Record<string, unknown>;
}

async function createMatrixStub(input: { roomEvents?: Record<string, MatrixStubEvent[]> } = {}) {
  const roomEvents: Record<string, MatrixStubEvent[]> = {
    '!class:localhost': [],
    '!team:localhost': [],
    '!agent:localhost': [],
    ...(input.roomEvents ?? {})
  };
  const tokenToSender: Record<string, string> = {
    'Bearer token-lin': '@lin:localhost',
    'Bearer token-chen': '@chen:localhost',
    'Bearer token-zhao': '@zhao:localhost',
    'Bearer token-teacher': '@teacher:localhost'
  };
  let counter = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const sendMatch = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/m\.room\.message\//);
      if (request.method === 'PUT' && sendMatch) {
        const roomId = decodeURIComponent(sendMatch[1]);
        const content = JSON.parse(await readBody(request)) as Record<string, unknown>;
        const event = {
          event_id: `$runtime-${++counter}`,
          sender: tokenToSender[request.headers.authorization ?? ''] ?? '@unknown:localhost',
          origin_server_ts: Date.now(),
          type: 'm.room.message',
          content
        };
        roomEvents[roomId] = [...(roomEvents[roomId] ?? []), event];
        sendJson(response, { event_id: event.event_id });
        return;
      }

      const messagesMatch = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/messages$/);
      if (request.method === 'GET' && messagesMatch) {
        const roomId = decodeURIComponent(messagesMatch[1]);
        sendJson(response, { chunk: [...(roomEvents[roomId] ?? [])].reverse() });
        return;
      }

      if (request.method === 'POST' && path === '/_matrix/media/v3/upload') {
        sendJson(response, { content_uri: `mxc://localhost/upload-${++counter}` });
        return;
      }

      sendJson(response, { ok: true });
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : 'unknown error');
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
