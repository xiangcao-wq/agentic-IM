import type { DemoState, FileItem, FileTextChunk } from '../domain/types';

const chunkSize = 1200;
const chunkOverlap = 100;
const maxChunkResults = 6;

export interface FileTextChunkSearchInput {
  agentId: string;
  roomId: string;
  query: string;
  limit?: number;
}

export interface FileTextChunkSearchResult {
  chunk: FileTextChunk;
  file: FileItem;
  score: number;
}

export function isTextIndexable(contentType: string | undefined, filename = ''): boolean {
  const normalizedType = (contentType ?? '').toLowerCase().split(';')[0].trim();
  const normalizedName = filename.toLowerCase();
  return (
    normalizedType.startsWith('text/') ||
    normalizedType === 'application/json' ||
    normalizedType === 'application/x-ndjson' ||
    normalizedName.endsWith('.txt') ||
    normalizedName.endsWith('.md') ||
    normalizedName.endsWith('.markdown') ||
    normalizedName.endsWith('.json') ||
    normalizedName.endsWith('.csv')
  );
}

export function extractTextChunks(file: FileItem, bytes: Uint8Array): FileTextChunk[] {
  if (!isTextIndexable(file.contentType, file.name) || bytes.byteLength === 0) {
    return [];
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\u0000/g, '').trim();
  if (!text) {
    return [];
  }

  const chunks: FileTextChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    const chunkText = text.slice(start, end).trim();
    if (chunkText) {
      chunks.push({
        id: `${file.id}-chunk-${index}`,
        fileId: file.id,
        roomId: file.roomId,
        uploaderId: file.uploaderId,
        index,
        text: chunkText,
        createdAt: file.updatedAt
      });
    }
    if (end >= text.length) {
      break;
    }
    start = Math.max(0, end - chunkOverlap);
    index += 1;
  }
  return chunks;
}

export function searchFileTextChunks(
  state: DemoState,
  input: FileTextChunkSearchInput
): FileTextChunkSearchResult[] {
  const agent = state.agents.find((candidate) => candidate.id === input.agentId);
  if (!agent || !agent.allowedRoomIds.includes(input.roomId)) {
    return [];
  }

  const terms = tokenize(input.query);
  const filesById = new Map(state.files.map((file) => [file.id, file]));
  return (state.fileTextChunks ?? [])
    .flatMap((chunk) => {
      const file = filesById.get(chunk.fileId);
      if (!file || !canAgentReadFile(agent.ownerId, input.roomId, file)) {
        return [];
      }
      const score = scoreText(chunk.text, terms);
      return score > 0 ? [{ chunk, file, score }] : [];
    })
    .sort((left, right) => right.score - left.score || left.chunk.index - right.chunk.index)
    .slice(0, input.limit ?? maxChunkResults);
}

export function tokenize(value: string): string[] {
  const lowered = value.toLowerCase();
  const ascii = lowered.match(/[a-z0-9_+-]{2,}/g) ?? [];
  const cjk = lowered.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const cjkPairs = cjk.flatMap((segment) => {
    const pairs: string[] = [];
    for (let index = 0; index < segment.length - 1; index += 1) {
      pairs.push(segment.slice(index, index + 2));
    }
    return pairs;
  });
  return [...new Set([...ascii, ...cjk, ...cjkPairs])].slice(0, 24);
}

function canAgentReadFile(ownerId: string, roomId: string, file: FileItem): boolean {
  if (file.roomId !== roomId) {
    return false;
  }
  if (file.visibility === 'owner' && file.uploaderId !== ownerId) {
    return false;
  }
  return true;
}

function scoreText(text: string, terms: string[]): number {
  if (terms.length === 0) {
    return 0;
  }
  const haystack = text.toLowerCase();
  return terms.reduce((score, term) => (haystack.includes(term) ? score + Math.max(1, term.length) : score), 0);
}
