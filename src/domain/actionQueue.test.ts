import { describe, expect, it } from 'vitest';
import { createDemoState } from './demoState';
import {
  blockAgentAction,
  completeAgentAction,
  enqueueAgentAction,
  rejectAgentAction,
  requireActionConfirmation
} from './actionQueue';

const lowRisk = {
  level: 'low' as const,
  score: 0.1,
  reason: 'read-only action',
  model: 'risk-mini-v1'
};

const highRisk = {
  level: 'high' as const,
  score: 0.86,
  reason: 'changes shared calendar',
  model: 'risk-mini-v1'
};

describe('agent action queue', () => {
  it('enqueues a pending Agent action request', () => {
    const state = createDemoState();

    const result = enqueueAgentAction(state, {
      id: 'action-share-file',
      agentId: 'agent-lin',
      roomId: 'room-team',
      kind: 'share_file',
      input: {
        fileId: 'file-slides-v3',
        requesterId: 'user-chen'
      },
      createdAt: '2026-05-04T08:00:00.000Z'
    });

    expect(result.request).toMatchObject({
      id: 'action-share-file',
      agentId: 'agent-lin',
      roomId: 'room-team',
      kind: 'share_file',
      status: 'pending',
      requiresHuman: false,
      createdAt: '2026-05-04T08:00:00.000Z',
      updatedAt: '2026-05-04T08:00:00.000Z'
    });
    expect(result.state.actionRequests[0]).toBe(result.request);
    expect(state.actionRequests).toHaveLength(0);
  });

  it('marks high-risk actions as needing human confirmation', () => {
    const queued = enqueueAgentAction(createDemoState(), {
      id: 'action-calendar-change',
      agentId: 'agent-lin',
      roomId: 'room-team',
      kind: 'coordinate',
      input: { proposal: 'move review time' },
      createdAt: '2026-05-04T08:00:00.000Z'
    });

    const result = requireActionConfirmation(queued.state, 'action-calendar-change', highRisk, {
      updatedAt: '2026-05-04T08:01:00.000Z'
    });

    expect(result.request.status).toBe('needs_confirmation');
    expect(result.request.requiresHuman).toBe(true);
    expect(result.request.risk).toBe(highRisk);
    expect(result.request.updatedAt).toBe('2026-05-04T08:01:00.000Z');
  });

  it('marks executed actions with an audit log link', () => {
    const queued = enqueueAgentAction(createDemoState(), {
      id: 'action-summary',
      agentId: 'agent-lin',
      roomId: 'room-class',
      kind: 'summary',
      input: { question: 'summarize room' },
      createdAt: '2026-05-04T08:00:00.000Z'
    });

    const result = completeAgentAction(queued.state, 'action-summary', {
      logId: 'log-summary',
      risk: lowRisk,
      updatedAt: '2026-05-04T08:02:00.000Z'
    });

    expect(result.request).toMatchObject({
      status: 'executed',
      requiresHuman: false,
      logId: 'log-summary',
      risk: lowRisk,
      updatedAt: '2026-05-04T08:02:00.000Z'
    });
  });

  it('marks blocked actions with risk and log context', () => {
    const queued = enqueueAgentAction(createDemoState(), {
      id: 'action-private-file',
      agentId: 'agent-lin',
      roomId: 'room-team',
      kind: 'share_file',
      input: { fileId: 'file-private-notes' },
      createdAt: '2026-05-04T08:00:00.000Z'
    });

    const result = blockAgentAction(queued.state, 'action-private-file', {
      risk: highRisk,
      logId: 'log-blocked',
      updatedAt: '2026-05-04T08:03:00.000Z'
    });

    expect(result.request.status).toBe('blocked');
    expect(result.request.requiresHuman).toBe(true);
    expect(result.request.logId).toBe('log-blocked');
    expect(result.request.risk).toBe(highRisk);
  });

  it('marks rejected actions as no longer requiring human input', () => {
    const queued = enqueueAgentAction(createDemoState(), {
      id: 'action-reject-me',
      agentId: 'agent-lin',
      roomId: 'room-team',
      kind: 'share_file',
      input: { fileId: 'file-slides-v3' },
      createdAt: '2026-05-04T08:00:00.000Z'
    });

    const result = rejectAgentAction(queued.state, 'action-reject-me', {
      logId: 'log-rejected',
      updatedAt: '2026-05-04T08:04:00.000Z'
    });

    expect(result.request).toMatchObject({
      status: 'rejected',
      requiresHuman: false,
      logId: 'log-rejected',
      updatedAt: '2026-05-04T08:04:00.000Z'
    });
  });
});
