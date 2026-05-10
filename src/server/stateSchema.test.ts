// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import {
  STATE_COLLECTION_KEYS,
  getStateCollections,
  validateDemoStateShape
} from './stateSchema';

describe('state schema helpers', () => {
  it('normalizes DemoState into stable database-ready collections', () => {
    const state = createDemoState();
    const collections = getStateCollections(state);

    expect(Object.keys(collections)).toEqual(STATE_COLLECTION_KEYS);
    expect(collections.users).toHaveLength(state.users.length);
    expect(collections.agents).toHaveLength(state.agents.length);
    expect(collections.rooms).toHaveLength(state.rooms.length);
    expect(collections.messages).toHaveLength(state.messages.length);
    expect(collections.files).toHaveLength(state.files.length);
    expect(collections.tasks).toHaveLength(state.tasks.length);
    expect(collections.calendar).toHaveLength(state.calendar.length);
    expect(collections.actionLogs).toHaveLength(state.actionLogs.length);
    expect(collections.actionRequests).toHaveLength(state.actionRequests.length);
    expect(collections.agentGoalPlans).toHaveLength(state.agentGoalPlans.length);
  });

  it('accepts a valid DemoState shape', () => {
    const state = createDemoState();

    expect(validateDemoStateShape(state)).toBe(state);
  });

  it('rejects snapshots with missing or non-array collections', () => {
    const state = createDemoState();
    const missingFiles = { ...state };
    delete (missingFiles as Partial<typeof state>).files;

    expect(() => validateDemoStateShape(missingFiles)).toThrow('Invalid DemoState.files: expected array');
    expect(() => validateDemoStateShape({ ...state, actionLogs: 'bad' })).toThrow(
      'Invalid DemoState.actionLogs: expected array'
    );
  });

  it('upgrades older snapshots by adding action queues and default autoreply policies', () => {
    const state = createDemoState();
    const oldSnapshot = { ...state };
    delete (oldSnapshot as Partial<typeof state>).actionRequests;
    delete (oldSnapshot as Partial<typeof state>).fileTextChunks;
    delete (oldSnapshot as Partial<typeof state>).a2aSessions;
    delete (oldSnapshot as Partial<typeof state>).agentAutopilotPolicies;
    delete (oldSnapshot as Partial<typeof state>).agentGoalPlans;
    delete (oldSnapshot as Partial<typeof state>).aiAutoreplyPolicies;
    delete (oldSnapshot as Partial<typeof state>).aiReplyJobs;

    const upgraded = validateDemoStateShape(oldSnapshot);
    expect(upgraded.actionRequests).toEqual([]);
    expect(upgraded.fileTextChunks).toEqual([]);
    expect(upgraded.a2aSessions).toEqual([]);
    expect(upgraded.agentGoalPlans).toEqual([]);
    expect(upgraded.agentAutopilotPolicies).toContainEqual(
      expect.objectContaining({
        agentId: 'agent-lin',
        enabled: true,
        allowedRoomIds: ['room-team'],
        autoExecuteMaxRisk: 'low'
      })
    );
    expect(upgraded.aiReplyJobs).toEqual([]);
    expect(upgraded.aiAutoreplyPolicies).toContainEqual(
      expect.objectContaining({
        userId: 'user-chen',
        enabled: true,
        allowedRoomIds: ['room-team'],
        triggerMode: 'all_messages'
      })
    );
  });

  it('upgrades older user snapshots with collaboration profiles for the demo cast', () => {
    const state = createDemoState();
    const oldSnapshot = {
      ...state,
      users: state.users.map((user) => {
        const { collaborationProfile: _profile, ...legacyUser } = user;
        return legacyUser;
      })
    };

    const upgraded = validateDemoStateShape(oldSnapshot);

    expect(upgraded.users.find((user) => user.id === 'user-lin')?.collaborationProfile).toMatchObject({
      currentFocus: '等陈晨补齐访谈截图后更新演示稿第 5 页和结论页',
      assistantScope: ['查找授权文件', '代发演示稿', '发起日程协商']
    });
    expect(upgraded.users.find((user) => user.id === 'user-chen')?.collaborationProfile?.responsibility).toBe(
      '访谈材料、引用来源和流程截图'
    );
  });

  it('seeds at least one calendar item for every demo user so Agents can inspect availability', () => {
    const state = createDemoState();

    for (const user of state.users) {
      expect(
        state.calendar.some((item) => item.attendees.includes(user.id)),
        `${user.id} should have calendar availability`
      ).toBe(true);
    }
  });

  it('preserves explicit empty policy arrays while upgrading missing policy fields', () => {
    const state = createDemoState();

    const explicitEmptyPolicies = validateDemoStateShape({
      ...state,
      agentAutopilotPolicies: [],
      aiAutoreplyPolicies: []
    });
    expect(explicitEmptyPolicies.agentAutopilotPolicies).toEqual([]);
    expect(explicitEmptyPolicies.aiAutoreplyPolicies).toEqual([]);

    const missingPolicies = { ...state };
    delete (missingPolicies as Partial<typeof state>).agentAutopilotPolicies;
    delete (missingPolicies as Partial<typeof state>).aiAutoreplyPolicies;

    const upgraded = validateDemoStateShape(missingPolicies);
    expect(upgraded.agentAutopilotPolicies.length).toBeGreaterThan(0);
    expect(upgraded.aiAutoreplyPolicies.length).toBeGreaterThan(0);
  });
});
