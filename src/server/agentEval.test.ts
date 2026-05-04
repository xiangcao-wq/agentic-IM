// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getAgentEvalCases, runAgentEval } from './agentEval';

describe('agent eval harness', () => {
  it('ships at least forty core intelligence scenarios', () => {
    const cases = getAgentEvalCases();
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.map((item) => item.name)).toContain('responsibility_question');
    expect(cases.map((item) => item.name)).toContain('metadata_only_file_share');
    expect(cases.map((item) => item.name)).toContain('private_chat_refusal');
  });

  it('runs deterministic fallback evals and reports thresholds', async () => {
    const report = await runAgentEval();

    expect(report.total).toBeGreaterThanOrEqual(40);
    expect(report.passed / report.total).toBeGreaterThanOrEqual(0.9);
    expect(report.thresholds.noForbiddenToolPassRate).toBe(1);
    expect(report.thresholds.fileAvailabilityPassRate).toBe(1);
    expect(report.thresholds.fallbackPassRate).toBe(1);
  });
});
