import { describe, expect, it } from 'vitest';
import { createDemoState } from '../../domain/demoState';
import { executeCoreTool } from './toolExecutor';

describe('agent core tool executor', () => {
  it('executes an allowed message.send tool call', () => {
    const state = createDemoState();
    const agent = state.agents.find((candidate) => candidate.id === 'agent-lin');
    if (!agent) throw new Error('missing test agent');

    const result = executeCoreTool(state, {
      toolName: 'message.send',
      agent,
      sourceRoomId: 'room-team',
      input: {
        targetRoomId: 'room-team',
        targetUserId: 'user-chen',
        messageBody: ' Please review the latest notes. '
      }
    });

    expect(result.status).toBe('ok');
    expect(result.risk?.model).toBe('policy-engine-v1');
    expect(result.data?.messageBody).toBe('Please review the latest notes.');
    expect(result.data?.message).toMatchObject({
      roomId: 'room-team',
      senderId: 'user-lin',
      type: 'agent',
      sourceAgentId: 'agent-lin'
    });
    expect(result.toolCalls).toContain('message.send');
    expect(result.toolCalls).toContain('matrix.send_event');
    expect(result.evidenceIds).toEqual(['room-team', 'user-chen']);
  });

  it('denies unauthorized message.send tool calls before side effects', () => {
    const state = createDemoState();
    const agent = state.agents.find((candidate) => candidate.id === 'agent-chen');
    if (!agent) throw new Error('missing test agent');

    const result = executeCoreTool(state, {
      toolName: 'message.send',
      agent,
      sourceRoomId: 'room-team',
      input: {
        targetRoomId: 'room-class',
        targetUserId: 'user-teacher',
        messageBody: 'Please post this for me.'
      }
    });

    expect(result.status).toBe('denied');
    expect(result.risk?.level).toBe('high');
    expect(result.policyReasons).toContain('target_room_not_authorized');
    expect(result.data?.message).toBeUndefined();
    expect(result.toolCalls).toEqual(['tool_executor.message.send', 'message.send']);
  });

  it('fails message.send when input does not match the tool schema', () => {
    const state = createDemoState();
    const agent = state.agents.find((candidate) => candidate.id === 'agent-lin');
    if (!agent) throw new Error('missing test agent');

    const result = executeCoreTool(state, {
      toolName: 'message.send',
      agent,
      sourceRoomId: 'room-team',
      input: {
        targetRoomId: 'room-team',
        messageBody: '   '
      }
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('messageBody must be a non-empty string');
    expect(result.toolCalls).toEqual(['tool_executor.message.send', 'message.send.validation_failed']);
  });

  it('executes an allowed file.share tool call', () => {
    const state = createDemoState();
    const agent = state.agents.find((candidate) => candidate.id === 'agent-lin');
    const file = state.files.find((candidate) => candidate.id === 'file-slides-v3');
    if (!agent || !file) throw new Error('missing test data');

    const result = executeCoreTool(state, {
      toolName: 'file.share',
      agent,
      sourceRoomId: 'room-team',
      input: {
        targetRoomId: 'room-team',
        requesterId: 'user-chen',
        requestText: 'please send the latest slides',
        file: {
          ...file,
          mxcUri: 'mxc://localhost/slides-v3',
          contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          size: 4096
        }
      }
    });
    const data = result.data as { file?: { id: string }; message?: { fileId?: string } } | undefined;

    expect(result.status).toBe('ok');
    expect(result.risk?.model).toBe('policy-engine-v1');
    expect(data?.file?.id).toBe('file-slides-v3');
    expect(data?.message?.fileId).toBe('file-slides-v3');
    expect(result.toolCalls).toContain('tool_executor.file.share');
    expect(result.toolCalls).toContain('matrix.send_event');
    expect(result.evidenceIds).toEqual(['room-team', 'user-chen', 'file-slides-v3']);
  });

  it('requires confirmation for metadata-only file.share tool calls', () => {
    const state = createDemoState();
    const agent = state.agents.find((candidate) => candidate.id === 'agent-lin');
    const file = state.files.find((candidate) => candidate.id === 'file-slides-v3');
    if (!agent || !file) throw new Error('missing test data');

    const result = executeCoreTool(state, {
      toolName: 'file.share',
      agent,
      sourceRoomId: 'room-team',
      input: {
        targetRoomId: 'room-team',
        requesterId: 'user-chen',
        requestText: 'please send the latest slides',
        file: {
          ...file,
          mxcUri: undefined,
          localPath: undefined
        }
      }
    });

    expect(result.status).toBe('needs_confirmation');
    expect(result.policyReasons).toContain('missing_downloadable_file_backing');
    expect((result.data as { message?: unknown } | undefined)?.message).toBeUndefined();
    expect(result.toolCalls).toEqual(['tool_executor.file.share', 'file.share']);
  });

  it('denies file.share tool calls outside the owner boundary', () => {
    const state = createDemoState();
    const agent = state.agents.find((candidate) => candidate.id === 'agent-lin');
    const file = state.files.find((candidate) => candidate.id === 'file-slides-v3');
    if (!agent || !file) throw new Error('missing test data');

    const result = executeCoreTool(state, {
      toolName: 'file.share',
      agent,
      sourceRoomId: 'room-team',
      input: {
        targetRoomId: 'room-team',
        requesterId: 'user-chen',
        requestText: 'please send chen notes',
        file: {
          ...file,
          id: 'file-chen-notes',
          uploaderId: 'user-chen',
          mxcUri: 'mxc://localhost/chen-notes',
          contentType: 'application/pdf',
          size: 1024
        }
      }
    });

    expect(result.status).toBe('denied');
    expect(result.policyReasons).toContain('file_outside_agent_owner_boundary');
    expect((result.data as { message?: unknown } | undefined)?.message).toBeUndefined();
    expect(result.toolCalls).toEqual(['tool_executor.file.share', 'file.share']);
  });
});
