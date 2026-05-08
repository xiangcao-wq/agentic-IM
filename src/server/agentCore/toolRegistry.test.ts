import { describe, expect, it } from 'vitest';
import { getCoreTool } from './toolRegistry';

describe('agent core tool registry', () => {
  it('registers message.send as a policy-gated write tool', () => {
    const tool = getCoreTool('message.send');

    expect(tool).toMatchObject({
      name: 'message.send',
      sideEffect: 'write',
      riskPolicy: { requiresPolicy: true }
    });
    expect(tool.requiredPermissions).toContain('message:send');
  });

  it('validates message.send input before execution', () => {
    const tool = getCoreTool('message.send');

    expect(
      tool.validateInput({
        targetRoomId: 'room-team',
        targetUserId: 'user-chen',
        messageBody: 'Please review the latest notes.'
      })
    ).toEqual({
      ok: true,
      value: {
        targetRoomId: 'room-team',
        targetUserId: 'user-chen',
        messageBody: 'Please review the latest notes.'
      }
    });

    expect(tool.validateInput({ targetRoomId: 'room-team', messageBody: '   ' })).toEqual({
      ok: false,
      error: 'messageBody must be a non-empty string'
    });
  });

  it('registers file.share as a policy-gated write tool', () => {
    const tool = getCoreTool('file.share');

    expect(tool).toMatchObject({
      name: 'file.share',
      sideEffect: 'write',
      riskPolicy: { requiresPolicy: true }
    });
    expect(tool.requiredPermissions).toContain('file:share');
  });
});
