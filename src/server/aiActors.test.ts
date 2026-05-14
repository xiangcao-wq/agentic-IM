// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import { buildHumanReplyInstructions, getAiActorProfile } from './aiActors';
import { buildActorInstructions, demoActors } from './aiDemoActors';

describe('AI actor identity prompts', () => {
  it('keeps simulated human replies in the named user persona without Agent narration', () => {
    const state = createDemoState();
    const profile = getAiActorProfile(state, 'user-chen', 'room-team');
    const instructions = buildHumanReplyInstructions(state, profile);

    expect(instructions).toContain('陈晨');
    expect(instructions).toContain('必须始终以这个用户的身份直接说话');
    expect(instructions).toContain('不要出现“作为某某”');
    expect(instructions).toContain('你不是 Agent');
    expect(instructions).toContain('通常不超过 80 个中文字');
  });

  it('separates demo human actors from personal Agent actors', () => {
    const humanInstructions = buildActorInstructions(demoActors['user-chen']);
    const agentInstructions = buildActorInstructions(demoActors['agent-lin']);

    expect(humanInstructions).toContain('真实用户身份直接说话');
    expect(humanInstructions).toContain('不要写旁白');
    expect(agentInstructions).toContain('保持个人助手身份');
    expect(agentInstructions).toContain('不要冒充真人用户');
  });
});
