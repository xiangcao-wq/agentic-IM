import { describe, expect, it } from 'vitest';
import { defaultToolCallsForIntent, getAgentTool } from './agentTools';

describe('agent tool registry', () => {
  it('exposes the approved tool whitelist and default intent mapping', () => {
    expect(getAgentTool('chat.answer')).toMatchObject({ sideEffect: 'read' });
    expect(getAgentTool('file.share')).toMatchObject({ sideEffect: 'write', requiresRiskGate: true });
    expect(getAgentTool('message.send')).toMatchObject({ sideEffect: 'write', requiresRiskGate: true });
    expect(getAgentTool('agent.coordinate')).toMatchObject({ sideEffect: 'write', requiresRiskGate: true });

    expect(defaultToolCallsForIntent('deadline')).toEqual([
      { tool: 'deadline.answer', args: {} }
    ]);
    expect(defaultToolCallsForIntent('share_file')).toEqual([
      { tool: 'file.share', args: {} }
    ]);
    expect(defaultToolCallsForIntent('send_message')).toEqual([
      { tool: 'message.send', args: {} }
    ]);
  });
});
