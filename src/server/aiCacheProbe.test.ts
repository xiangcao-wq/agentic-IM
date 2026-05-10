// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AiUsageSnapshot } from './aiProvider';
import {
  diffCacheStats,
  formatCacheProbeReport,
  summarizeCacheProbeRows,
  type CacheProbeRow
} from './aiCacheProbe';

describe('AI cache probe metrics', () => {
  it('diffs prompt cache usage without leaking unrelated usage fields', () => {
    const before = usageSnapshot({
      requestCount: 3,
      promptCacheHitTokens: 120,
      promptCacheMissTokens: 880
    });
    const after = usageSnapshot({
      requestCount: 5,
      promptCacheHitTokens: 820,
      promptCacheMissTokens: 1080
    });

    expect(diffCacheStats(before, after)).toEqual({
      requestCount: 2,
      promptCacheHitTokens: 700,
      promptCacheMissTokens: 200,
      promptCacheTotalTokens: 900,
      promptCacheHitRate: 700 / 900
    });
  });

  it('summarizes route-level cache hit rates', () => {
    const rows: CacheProbeRow[] = [
      {
        round: 1,
        route: 'deadline',
        requestCount: 1,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 1000,
        promptCacheTotalTokens: 1000,
        promptCacheHitRate: 0
      },
      {
        round: 2,
        route: 'deadline',
        requestCount: 1,
        promptCacheHitTokens: 800,
        promptCacheMissTokens: 200,
        promptCacheTotalTokens: 1000,
        promptCacheHitRate: 0.8
      },
      {
        round: 2,
        route: 'human_reply',
        requestCount: 1,
        promptCacheHitTokens: 300,
        promptCacheMissTokens: 300,
        promptCacheTotalTokens: 600,
        promptCacheHitRate: 0.5
      }
    ];

    expect(summarizeCacheProbeRows(rows)).toEqual({
      requestCount: 3,
      promptCacheHitTokens: 1100,
      promptCacheMissTokens: 1500,
      promptCacheTotalTokens: 2600,
      promptCacheHitRate: 1100 / 2600,
      routes: [
        {
          route: 'deadline',
          requestCount: 2,
          promptCacheHitTokens: 800,
          promptCacheMissTokens: 1200,
          promptCacheTotalTokens: 2000,
          promptCacheHitRate: 0.4
        },
        {
          route: 'human_reply',
          requestCount: 1,
          promptCacheHitTokens: 300,
          promptCacheMissTokens: 300,
          promptCacheTotalTokens: 600,
          promptCacheHitRate: 0.5
        }
      ]
    });
  });

  it('formats a human report without exposing secrets', () => {
    const report = formatCacheProbeReport({
      generatedAt: '2026-05-10T00:00:00.000Z',
      rounds: 2,
      delayMs: 0,
      rows: [
        {
          round: 1,
          route: 'deadline',
          requestCount: 1,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 1000,
          promptCacheTotalTokens: 1000,
          promptCacheHitRate: 0
        },
        {
          round: 2,
          route: 'deadline',
          requestCount: 1,
          promptCacheHitTokens: 900,
          promptCacheMissTokens: 100,
          promptCacheTotalTokens: 1000,
          promptCacheHitRate: 0.9
        }
      ],
      totals: {
        requestCount: 2,
        promptCacheHitTokens: 900,
        promptCacheMissTokens: 1100,
        promptCacheTotalTokens: 2000,
        promptCacheHitRate: 0.45,
        routes: [
          {
            route: 'deadline',
            requestCount: 2,
            promptCacheHitTokens: 900,
            promptCacheMissTokens: 1100,
            promptCacheTotalTokens: 2000,
            promptCacheHitRate: 0.45
          }
        ]
      }
    });

    expect(report).toContain('AI Cache Probe');
    expect(report).toContain('deadline');
    expect(report).toContain('45.0%');
    expect(report).not.toMatch(/sk-|api[_-]?key|DEEPSEEK/i);
  });
});

function usageSnapshot(partial: Partial<AiUsageSnapshot>): AiUsageSnapshot {
  return {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    promptCacheHitRate: 0,
    ...partial
  };
}
