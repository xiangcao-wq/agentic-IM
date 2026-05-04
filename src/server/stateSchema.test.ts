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
    delete (oldSnapshot as Partial<typeof state>).aiAutoreplyPolicies;
    delete (oldSnapshot as Partial<typeof state>).aiReplyJobs;

    const upgraded = validateDemoStateShape(oldSnapshot);
    expect(upgraded.actionRequests).toEqual([]);
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
});
