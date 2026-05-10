import { answerDeadlineQuestion, summarizeRoom } from '../domain/agentEngine';
import { createDemoState } from '../domain/demoState';
import type { DemoState, Message } from '../domain/types';
import { runAgentIntent } from './agentRunRuntime';
import { runAiAutoreplies } from './aiAutoreply';
import type { AiProvider, AiUsageSnapshot } from './aiProvider';
import { getAiUsageSnapshot } from './aiProvider';

export type CacheProbeRouteName = 'deadline' | 'summary' | 'human_reply' | 'agent_chat';

export interface CacheStats {
  requestCount: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  promptCacheTotalTokens: number;
  promptCacheHitRate: number;
}

export interface CacheProbeRow extends CacheStats {
  round: number;
  route: CacheProbeRouteName;
}

export interface CacheProbeRouteSummary extends CacheStats {
  route: CacheProbeRouteName;
}

export interface CacheProbeTotals extends CacheStats {
  routes: CacheProbeRouteSummary[];
}

export interface CacheProbeReport {
  generatedAt: string;
  rounds: number;
  delayMs: number;
  rows: CacheProbeRow[];
  totals: CacheProbeTotals;
}

export interface RunAiCacheProbeInput {
  aiProvider: AiProvider;
  rounds?: number;
  delayMs?: number;
  routes?: CacheProbeRouteName[];
}

const defaultRoutes: CacheProbeRouteName[] = ['deadline', 'summary', 'human_reply', 'agent_chat'];

export async function runAiCacheProbe(input: RunAiCacheProbeInput): Promise<CacheProbeReport> {
  const rounds = normalizePositiveInteger(input.rounds, 2);
  const delayMs = normalizeNonNegativeInteger(input.delayMs, 2000);
  const routes = input.routes?.length ? uniqueRoutes(input.routes) : defaultRoutes;
  assertUsageInspectable(input.aiProvider);

  const rows: CacheProbeRow[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (const route of routes) {
      const before = getRequiredUsageSnapshot(input.aiProvider);
      await runCacheProbeRoute(route, input.aiProvider);
      const after = getRequiredUsageSnapshot(input.aiProvider);
      rows.push({
        round,
        route,
        ...diffCacheStats(before, after)
      });
    }

    if (delayMs > 0 && round < rounds) {
      await sleep(delayMs);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    rounds,
    delayMs,
    rows,
    totals: summarizeCacheProbeRows(rows)
  };
}

export function diffCacheStats(before: AiUsageSnapshot, after: AiUsageSnapshot): CacheStats {
  const promptCacheHitTokens = Math.max(0, after.promptCacheHitTokens - before.promptCacheHitTokens);
  const promptCacheMissTokens = Math.max(0, after.promptCacheMissTokens - before.promptCacheMissTokens);
  const promptCacheTotalTokens = promptCacheHitTokens + promptCacheMissTokens;
  return {
    requestCount: Math.max(0, after.requestCount - before.requestCount),
    promptCacheHitTokens,
    promptCacheMissTokens,
    promptCacheTotalTokens,
    promptCacheHitRate: promptCacheTotalTokens > 0 ? promptCacheHitTokens / promptCacheTotalTokens : 0
  };
}

export function summarizeCacheProbeRows(rows: CacheProbeRow[]): CacheProbeTotals {
  const totals = sumCacheStats(rows);
  const routeNames = uniqueRoutes(rows.map((row) => row.route));
  return {
    ...totals,
    routes: routeNames.map((route) => ({
      route,
      ...sumCacheStats(rows.filter((row) => row.route === route))
    }))
  };
}

export function formatCacheProbeReport(report: CacheProbeReport): string {
  const lines = [
    'AI Cache Probe',
    `generatedAt: ${report.generatedAt}`,
    `rounds: ${report.rounds}`,
    `delayMs: ${report.delayMs}`,
    '',
    'Totals',
    `requests: ${report.totals.requestCount}`,
    `cache hit tokens: ${report.totals.promptCacheHitTokens}`,
    `cache miss tokens: ${report.totals.promptCacheMissTokens}`,
    `cache hit rate: ${formatPercent(report.totals.promptCacheHitRate)}`,
    '',
    'Routes',
    ...report.totals.routes.map((route) =>
      [
        `- ${route.route}`,
        `requests=${route.requestCount}`,
        `hit=${route.promptCacheHitTokens}`,
        `miss=${route.promptCacheMissTokens}`,
        `rate=${formatPercent(route.promptCacheHitRate)}`
      ].join(' ')
    ),
    '',
    'Rows',
    ...report.rows.map((row) =>
      [
        `- round=${row.round}`,
        `route=${row.route}`,
        `requests=${row.requestCount}`,
        `hit=${row.promptCacheHitTokens}`,
        `miss=${row.promptCacheMissTokens}`,
        `rate=${formatPercent(row.promptCacheHitRate)}`
      ].join(' ')
    )
  ];
  return lines.join('\n');
}

async function runCacheProbeRoute(route: CacheProbeRouteName, aiProvider: AiProvider): Promise<void> {
  const state = createDemoState();
  if (route === 'deadline') {
    await answerDeadlineQuestion(
      state,
      {
        agentId: 'agent-lin',
        roomId: 'room-team',
        question: '这次作业什么时候截止？还有哪些临近时间点？'
      },
      aiProvider
    );
    return;
  }

  if (route === 'summary') {
    await summarizeRoom(state, 'room-team', 'agent-lin', aiProvider);
    return;
  }

  if (route === 'human_reply') {
    await runAiAutoreplies({
      state,
      triggerMessage: createProbeTriggerMessage(),
      aiProvider,
      async sendMessage(_state, input) {
        return createProbeReplyMessage(input.roomId, input.senderId, input.body);
      }
    });
    return;
  }

  await runAgentIntent(
    state,
    {
      agentId: 'agent-lin',
      roomId: 'room-team',
      intent: 'chat',
      userText: '你能帮我判断当前小组下一步应该先做什么吗？'
    },
    aiProvider
  );
}

function createProbeTriggerMessage(): Message {
  return {
    id: 'cache-probe-trigger',
    roomId: 'room-team',
    senderId: 'user-lin',
    senderName: '林雯',
    body: '@陈晨 你帮我看一下访谈引用和行动计划还差什么？',
    sentAt: '2026-05-10T09:00:00+08:00',
    type: 'text'
  };
}

function createProbeReplyMessage(roomId: string, senderId: string, body: string): Message {
  return {
    id: `cache-probe-reply-${senderId}`,
    roomId,
    senderId,
    senderName: senderId,
    body,
    sentAt: '2026-05-10T09:01:00+08:00',
    type: 'text'
  };
}

function assertUsageInspectable(aiProvider: AiProvider): void {
  if (!getAiUsageSnapshot(aiProvider)) {
    throw new Error('AI cache probe requires a provider with usage snapshots.');
  }
}

function getRequiredUsageSnapshot(aiProvider: AiProvider): AiUsageSnapshot {
  const snapshot = getAiUsageSnapshot(aiProvider);
  if (!snapshot) {
    throw new Error('AI usage snapshot is unavailable.');
  }
  return snapshot;
}

function sumCacheStats(rows: CacheStats[]): CacheStats {
  const totals = rows.reduce(
    (next, row) => ({
      requestCount: next.requestCount + row.requestCount,
      promptCacheHitTokens: next.promptCacheHitTokens + row.promptCacheHitTokens,
      promptCacheMissTokens: next.promptCacheMissTokens + row.promptCacheMissTokens,
      promptCacheTotalTokens: next.promptCacheTotalTokens + row.promptCacheTotalTokens,
      promptCacheHitRate: 0
    }),
    {
      requestCount: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      promptCacheTotalTokens: 0,
      promptCacheHitRate: 0
    }
  );
  return {
    ...totals,
    promptCacheHitRate:
      totals.promptCacheTotalTokens > 0 ? totals.promptCacheHitTokens / totals.promptCacheTotalTokens : 0
  };
}

function uniqueRoutes(routes: CacheProbeRouteName[]): CacheProbeRouteName[] {
  return routes.filter((route, index) => routes.indexOf(route) === index);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value && value > 0 ? value : fallback;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 ? value : fallback;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
