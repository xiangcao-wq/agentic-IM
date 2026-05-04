import { describe, expect, it } from 'vitest';
import { sortMessagesChronologically } from './messages';
import type { Message } from './types';

describe('message ordering', () => {
  it('sorts mixed timezone timestamps by actual instant instead of string shape', () => {
    const userMessage = createMessage('new-user-message', '2026-05-04T13:10:39.971Z', '每天出去玩吗');
    const oldSeedMessage = createMessage('old-seed-message', '2026-05-04T13:20:00+08:00', '今晚先不改结构了');

    expect([userMessage, oldSeedMessage].sort((a, b) => a.sentAt.localeCompare(b.sentAt)).map((m) => m.id)).toEqual([
      'new-user-message',
      'old-seed-message'
    ]);
    expect(sortMessagesChronologically([userMessage, oldSeedMessage]).map((m) => m.id)).toEqual([
      'old-seed-message',
      'new-user-message'
    ]);
  });
});

function createMessage(id: string, sentAt: string, body: string): Message {
  return {
    id,
    roomId: 'room-team',
    senderId: 'user-lin',
    senderName: '林雯',
    body,
    sentAt,
    type: 'text'
  };
}
