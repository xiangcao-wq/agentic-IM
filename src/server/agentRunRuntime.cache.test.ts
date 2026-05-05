// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildCacheFriendlyMessages } from './agentRunRuntime';

describe('agent run prompt cache layout', () => {
  it('keeps volatile chat history out of the reusable DeepSeek prefix', () => {
    const context = [
      '# Authorized Agent Context',
      'Boundary: only authorized room data is visible.',
      'Room: Team room (room-team, team)',
      'Agent: Lin Agent (agent-lin); allowedRooms=room-team',
      '',
      '## Recent messages',
      '- [2026-05-04T10:00:00.000Z] Chen (member) msg-1: new message that changes every run',
      '',
      '## Relevant older messages',
      '- msg-0: older but query-dependent message',
      '',
      '## Tasks',
      '- task-1: finish report; deadline=2026-05-12T23:59:00+08:00; owners=user-lin; status=in_progress',
      '',
      '## Files',
      '- file-1: report.md; downloadable=true; summary=stable file metadata',
      '',
      '## File text excerpts',
      '- chunk-1: query-dependent text',
      '',
      '## Members',
      '- user-lin: Lin; role=editor; status=offline; agent=agent-lin',
      '',
      '## Agent memory',
      '- mem-1: prior note',
      '',
      '## Recent agent logs',
      '- log-1: previous run'
    ].join('\n');

    const messages = buildCacheFriendlyMessages('stable system prompt', context, '## Current User Request\nUser input: hello');

    expect(messages).toHaveLength(3);
    expect(messages?.[1].content).toContain('# Authorized Agent Context');
    expect(messages?.[1].content).toContain('## Tasks');
    expect(messages?.[1].content).toContain('## Files');
    expect(messages?.[1].content).toContain('## Members');
    expect(messages?.[1].content).not.toContain('## Recent messages');
    expect(messages?.[1].content).not.toContain('new message that changes every run');

    expect(messages?.[2].content).toContain('## Recent messages');
    expect(messages?.[2].content).toContain('## File text excerpts');
    expect(messages?.[2].content).toContain('## Agent memory');
    expect(messages?.[2].content).toContain('## Current User Request');
  });
});
