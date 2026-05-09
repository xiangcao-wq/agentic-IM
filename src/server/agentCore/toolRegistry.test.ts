import { describe, expect, it } from 'vitest';
import { getCoreTool, isCoreToolName, listCoreTools } from './toolRegistry';

describe('agent core tool registry', () => {
  it('registers message.send as a policy-gated write tool', () => {
    const tool = getCoreTool('message.send');

    expect(tool).toMatchObject({
      name: 'message.send',
      version: 1,
      displayName: 'Send message',
      category: 'communication',
      sideEffect: 'write',
      visibility: 'model',
      audit: { level: 'full' },
      permission: {
        mode: 'policy',
        requiredPermissions: ['message:send'],
        requiresApprovalOn: ['ask']
      },
      riskPolicy: { requiresPolicy: true }
    });
    expect(tool.requiredPermissions).toContain('message:send');
  });

  it('registers file.share as a policy-gated file tool', () => {
    const tool = getCoreTool('file.share');

    expect(tool).toMatchObject({
      name: 'file.share',
      version: 1,
      displayName: 'Share file',
      category: 'file',
      sideEffect: 'external',
      visibility: 'model',
      audit: { level: 'full' },
      permission: {
        mode: 'policy',
        requiredPermissions: ['file:share'],
        requiresApprovalOn: ['ask']
      },
      riskPolicy: { requiresPolicy: true }
    });
    expect(tool.requiredPermissions).toContain('file:share');
  });

  it('lists stable core tools without exposing mutable registry state', () => {
    const tools = listCoreTools();

    expect(tools.map((tool) => tool.name)).toEqual(['message.send', 'file.share']);
    tools.pop();
    expect(listCoreTools().map((tool) => tool.name)).toEqual(['message.send', 'file.share']);
  });

  it('identifies supported core tool names', () => {
    expect(isCoreToolName('message.send')).toBe(true);
    expect(isCoreToolName('file.share')).toBe(true);
    expect(isCoreToolName('web.search')).toBe(false);
    expect(isCoreToolName('toString')).toBe(false);
    expect(isCoreToolName(undefined)).toBe(false);
  });

  it('does not persist mutations made through listed tool metadata', () => {
    const tools = listCoreTools();

    tools[0].permission.requiredPermissions.push('bad');

    expect(listCoreTools()[0].permission.requiredPermissions).toEqual(['message:send']);
  });

  it('does not persist mutations made through direct tool metadata', () => {
    const tool = getCoreTool('message.send');

    tool.requiredPermissions.push('bad');

    expect(getCoreTool('message.send').requiredPermissions).toEqual(['message:send']);
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
});
