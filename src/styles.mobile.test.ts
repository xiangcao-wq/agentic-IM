import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

function expectMobileRule(selector: string, declarations: string[]) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(
    `\\/\\* Mobile IM layout hardening \\*\\/[\\s\\S]*@media \\(max-width: 760px\\)[\\s\\S]*${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`,
    'm'
  ).exec(styles)?.[1];
  expect(rule, `Missing mobile hardening rule for ${selector}`).toBeTruthy();
  for (const declaration of declarations) {
    expect(rule).toContain(declaration);
  }
}

describe('mobile IM layout styles', () => {
  it('keeps the IM surface single-column and horizontally contained on small screens', () => {
    expectMobileRule('.app-shell-im', ['grid-template-columns: 1fr', 'grid-template-rows: auto minmax(0, 1fr)', 'overflow-x: clip']);
    expectMobileRule('.sidebar', ['grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)', 'overflow: hidden']);
    expectMobileRule('.room-list', ['grid-auto-flow: column', 'overflow-x: auto']);
    expectMobileRule('.chat-panel', ['min-height: 0', 'grid-template-rows: auto auto auto minmax(0, 1fr) auto']);
    expectMobileRule('.composer', ['position: sticky', 'bottom: 0']);
  });

  it('keeps the Agent Console vertically stacked and prevents room list overflow on small screens', () => {
    expect(styles).toContain('grid-template-areas:');
    expect(styles).toContain('"rooms"');
    expect(styles).toContain('"inspector"');
    expect(styles).toContain('.agent-console .console-room-list');
    expect(styles).toContain('grid-auto-flow: row');
    expect(styles).toContain('overflow-x: hidden');
  });
});
