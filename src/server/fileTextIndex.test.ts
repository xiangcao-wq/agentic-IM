// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoState } from '../domain/demoState';
import type { FileItem } from '../domain/types';
import { extractTextChunks, isTextIndexable, searchFileTextChunks } from './fileTextIndex';

describe('file text index', () => {
  it('indexes only text-like files into overlapping searchable chunks', () => {
    const file: FileItem = {
      id: 'file-notes',
      name: 'team-notes.md',
      uploaderId: 'user-lin',
      version: 1,
      roomId: 'room-team',
      updatedAt: '2026-05-04T08:00:00.000Z',
      visibility: 'room',
      agentCanShare: true,
      tags: ['notes'],
      summary: 'Team notes',
      contentType: 'text/markdown; charset=utf-8',
      size: 0
    };
    const text = `${'a'.repeat(1150)}引用一致性需要陈晨核对。${'b'.repeat(1150)}`;

    expect(isTextIndexable('text/markdown; charset=utf-8', 'team-notes.md')).toBe(true);
    expect(isTextIndexable('application/pdf', 'report.pdf')).toBe(false);

    const chunks = extractTextChunks(file, Buffer.from(text, 'utf8'));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatchObject({
      fileId: 'file-notes',
      roomId: 'room-team',
      uploaderId: 'user-lin',
      index: 0
    });
    expect(chunks.some((chunk) => chunk.text.includes('引用一致性'))).toBe(true);
  });

  it('searches only authorized chunks visible to the agent room', () => {
    const state = createDemoState();
    const chunks = [
      {
        id: 'chunk-visible',
        fileId: 'file-visible',
        roomId: 'room-team',
        uploaderId: 'user-lin',
        index: 0,
        text: '引用一致性需要陈晨核对，行动计划和访谈纪要要对齐。',
        createdAt: '2026-05-04T08:00:00.000Z'
      },
      {
        id: 'chunk-hidden',
        fileId: 'file-hidden',
        roomId: 'room-private',
        uploaderId: 'user-chen',
        index: 0,
        text: 'hidden private content about 引用一致性',
        createdAt: '2026-05-04T08:00:00.000Z'
      }
    ];
    const indexedState = {
      ...state,
      files: [
        {
          id: 'file-visible',
          name: 'visible-notes.txt',
          uploaderId: 'user-lin',
          version: 1,
          roomId: 'room-team',
          updatedAt: '2026-05-04T08:00:00.000Z',
          visibility: 'room' as const,
          agentCanShare: true,
          tags: ['notes'],
          summary: 'Visible notes',
          contentType: 'text/plain',
          size: 32
        },
        {
          id: 'file-hidden',
          name: 'hidden-notes.txt',
          uploaderId: 'user-chen',
          version: 1,
          roomId: 'room-private',
          updatedAt: '2026-05-04T08:00:00.000Z',
          visibility: 'room' as const,
          agentCanShare: true,
          tags: ['private'],
          summary: 'Hidden notes',
          contentType: 'text/plain',
          size: 32
        },
        ...state.files
      ],
      fileTextChunks: chunks
    };

    const results = searchFileTextChunks(indexedState, {
      agentId: 'agent-lin',
      roomId: 'room-team',
      query: '引用一致性'
    });

    expect(results.map((result) => result.chunk.id)).toEqual(['chunk-visible']);
  });
});
