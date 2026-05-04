import type { Message } from './types';

export function compareTimestamps(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);

  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
    return left - right;
  }

  return a.localeCompare(b);
}

export function sortMessagesChronologically(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => compareTimestamps(a.sentAt, b.sentAt) || a.id.localeCompare(b.id));
}
