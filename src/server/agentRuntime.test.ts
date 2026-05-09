// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import { runFileShareAction } from './agentRuntime';

describe('agent runtime', () => {
  it('queues, executes, and audits a low-risk file share action', async () => {
    const baseState = createDemoState();
    const state = {
      ...baseState,
      files: baseState.files.map((file) =>
        file.id === 'file-slides-v3'
          ? {
              ...file,
              mxcUri: 'mxc://localhost/slides-v3',
              contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              size: 4096
            }
          : file
      )
    };

    const result = await runFileShareAction(state, {
      id: 'action-runtime-share',
      createdAt: '2026-05-04T08:10:00.000Z',
      agentId: 'agent-lin',
      roomId: 'room-team',
      requesterId: 'user-chen',
      requestText: '林雯不在线的话，能把最新演示稿发一下吗？'
    });

    expect(result.result.status).toBe('executed');
    expect(result.actionRequest).toMatchObject({
      id: 'action-runtime-share',
      kind: 'share_file',
      status: 'executed',
      requiresHuman: false,
      logId: result.result.log.id
    });
    expect(result.state.actionRequests[0]).toBe(result.actionRequest);
    expect(result.state.actionLogs[0]).toBe(result.result.log);
    expect(result.result.risk.model).toBe('policy-engine-v1');
    expect(result.result.log.toolCalls).toContain('file.share');
    expect(result.actionRequest.status).toBe('executed');
    expect(result.state.actionLogs[0].toolCalls).toContain('tool_executor.file.share');
    expect(result.state.actionLogs[0].toolCalls).toContain('file_library.lookup_latest');
  });

  it('shares an explicitly selected authorized file instead of guessing the newest match', async () => {
    const baseState = createDemoState();
    const state = {
      ...baseState,
      files: baseState.files.map((file) =>
        file.id === 'file-slides-v3'
          ? {
              ...file,
              mxcUri: 'mxc://localhost/slides-v3',
              contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              size: 4096
            }
          : file
      )
    };

    const result = await runFileShareAction(state, {
      agentId: 'agent-lin',
      roomId: 'room-team',
      requesterId: 'user-chen',
      requestText: '请把这个文件发给陈晨',
      fileId: 'file-slides-v3',
      fileVersion: 3
    });

    expect(result.result.status).toBe('executed');
    expect(result.result.file?.id).toBe('file-slides-v3');
    expect(result.result.message?.fileId).toBe('file-slides-v3');
    expect(result.actionRequest.input).toMatchObject({
      fileId: 'file-slides-v3',
      fileVersion: 3
    });
  });

  it('keeps high-risk file share actions in the confirmation queue', async () => {
    const state = createDemoState();

    const result = await runFileShareAction(state, {
      id: 'action-runtime-unknown-requester',
      createdAt: '2026-05-04T08:11:00.000Z',
      agentId: 'agent-lin',
      roomId: 'room-team',
      requesterId: 'user-missing',
      requestText: '把文件发给我'
    });

    expect(result.result.status).toBe('needs_confirmation');
    expect(result.result.requiresHuman).toBe(true);
    expect(result.actionRequest.status).toBe('needs_confirmation');
    expect(result.actionRequest.requiresHuman).toBe(true);
    expect(result.actionRequest.risk?.level).toBe('high');
    expect(result.actionRequest.logId).toBeUndefined();
    expect(result.state.actionLogs[0]).toBe(result.result.log);
    expect(result.result.log.toolCalls).toContain('file.share');
  });
});
