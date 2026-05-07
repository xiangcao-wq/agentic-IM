import { describe, expect, it } from 'vitest';
import { createDemoState } from '../../domain/demoState';
import { assessFileSharePolicy, assessMessageSendPolicy } from './policyEngine';

describe('agent core policy engine', () => {
  it('allows a short delegated message to an authorized room', () => {
    const state = createDemoState();
    const agent = state.agents.find((candidate) => candidate.id === 'agent-lin');
    if (!agent) throw new Error('missing test agent');

    const decision = assessMessageSendPolicy(state, {
      agent,
      targetRoomId: 'room-team',
      targetUserId: 'user-chen',
      messageBody: 'Please check the latest notes when you are available.'
    });

    expect(decision.outcome).toBe('allow');
    expect(decision.risk.level).toBe('low');
    expect(decision.reasons).toContain('target_room_authorized');
    expect(decision.reasons).toContain('ordinary_collaboration_message');
  });

  it('denies a delegated message to a room outside the agent authorization scope', () => {
    const state = createDemoState();
    const agent = state.agents.find((candidate) => candidate.id === 'agent-chen');
    if (!agent) throw new Error('missing test agent');

    const decision = assessMessageSendPolicy(state, {
      agent,
      targetRoomId: 'room-class',
      messageBody: 'Please post this to the class room.'
    });

    expect(decision.outcome).toBe('deny');
    expect(decision.risk.level).toBe('high');
    expect(decision.reasons).toContain('target_room_not_authorized');
  });

  it('denies a delegated message when the agent owner cannot be verified', () => {
    const state = createDemoState();
    const agent = state.agents.find((candidate) => candidate.id === 'agent-lin');
    if (!agent) throw new Error('missing test agent');

    const decision = assessMessageSendPolicy(
      {
        ...state,
        users: state.users.filter((user) => user.id !== agent.ownerId)
      },
      {
        agent,
        targetRoomId: 'room-team',
        messageBody: 'Please check the latest notes.'
      }
    );

    expect(decision.outcome).toBe('deny');
    expect(decision.risk.level).toBe('high');
    expect(decision.reasons).toContain('owner_not_found');
  });

  it('requires confirmation for sensitive delegated message content', () => {
    const state = createDemoState();
    const agent = state.agents.find((candidate) => candidate.id === 'agent-lin');
    if (!agent) throw new Error('missing test agent');

    const decision = assessMessageSendPolicy(state, {
      agent,
      targetRoomId: 'room-team',
      targetUserId: 'user-chen',
      messageBody: 'Tell everyone the token is secret-demo-value.'
    });

    expect(decision.outcome).toBe('require_confirmation');
    expect(decision.risk.level).toBe('medium');
    expect(decision.reasons).toContain('sensitive_or_long_content');
    expect(decision.requiredReviewerIds).toEqual(['user-lin']);
  });

  it('allows an authorized downloadable file share in the source room', () => {
    const state = createDemoState();
    const agent = state.agents.find((candidate) => candidate.id === 'agent-lin');
    const baseFile = state.files.find((file) => file.id === 'file-slides-v3');
    if (!agent || !baseFile) throw new Error('missing test data');

    const decision = assessFileSharePolicy(state, {
      agent,
      sourceRoomId: 'room-team',
      targetRoomId: 'room-team',
      requesterId: 'user-chen',
      requestText: 'please send the latest slides',
      file: {
        ...baseFile,
        mxcUri: 'mxc://localhost/slides-v3',
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: 4096
      }
    });

    expect(decision.outcome).toBe('allow');
    expect(decision.risk.level).toBe('low');
    expect(decision.reasons).toContain('file_authorized_for_agent');
    expect(decision.reasons).toContain('downloadable_file_backing');
  });

  it('requires confirmation for metadata-only file shares', () => {
    const state = createDemoState();
    const agent = state.agents.find((candidate) => candidate.id === 'agent-lin');
    const file = state.files.find((candidate) => candidate.id === 'file-slides-v3');
    if (!agent || !file) throw new Error('missing test data');

    const decision = assessFileSharePolicy(state, {
      agent,
      sourceRoomId: 'room-team',
      targetRoomId: 'room-team',
      requesterId: 'user-chen',
      requestText: 'please send the latest slides',
      file: {
        ...file,
        mxcUri: undefined,
        localPath: undefined
      }
    });

    expect(decision.outcome).toBe('require_confirmation');
    expect(decision.risk.level).toBe('medium');
    expect(decision.reasons).toContain('missing_downloadable_file_backing');
    expect(decision.requiredReviewerIds).toEqual(['user-lin']);
  });

  it('requires confirmation when a file request does not clearly ask to send or share', () => {
    const state = createDemoState();
    const agent = state.agents.find((candidate) => candidate.id === 'agent-lin');
    const file = state.files.find((candidate) => candidate.id === 'file-slides-v3');
    if (!agent || !file) throw new Error('missing test data');

    const decision = assessFileSharePolicy(state, {
      agent,
      sourceRoomId: 'room-team',
      targetRoomId: 'room-team',
      requesterId: 'user-chen',
      requestText: 'process the pptx',
      file: {
        ...file,
        mxcUri: 'mxc://localhost/slides-v3',
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: 4096
      }
    });

    expect(decision.outcome).toBe('require_confirmation');
    expect(decision.risk.level).toBe('medium');
    expect(decision.reasons).toContain('ambiguous_file_share_intent');
  });

  it('denies file shares outside the agent owner boundary', () => {
    const state = createDemoState();
    const agent = state.agents.find((candidate) => candidate.id === 'agent-lin');
    const file = state.files.find((candidate) => candidate.id === 'file-slides-v3');
    if (!agent || !file) throw new Error('missing test data');

    const decision = assessFileSharePolicy(state, {
      agent,
      sourceRoomId: 'room-team',
      targetRoomId: 'room-team',
      requesterId: 'user-chen',
      requestText: 'please send chen notes',
      file: {
        ...file,
        id: 'file-chen-private-notes',
        uploaderId: 'user-chen',
        mxcUri: 'mxc://localhost/chen-private-notes',
        contentType: 'application/pdf',
        size: 1024
      }
    });

    expect(decision.outcome).toBe('deny');
    expect(decision.risk.level).toBe('high');
    expect(decision.reasons).toContain('file_outside_agent_owner_boundary');
  });
});
