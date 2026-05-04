// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoAssets } from './demoAssets';

describe('demo assets', () => {
  it('creates real openable text, pdf, and png files in memory', () => {
    const assets = createDemoAssets();

    expect(assets.map((asset) => asset.contentType)).toEqual([
      'text/plain; charset=utf-8',
      'application/pdf',
      'image/png'
    ]);
    expect(Buffer.from(assets[0].bytes).toString('utf8')).toContain('校园服务数字化调研');
    const pdf = Buffer.from(assets[1].bytes).toString('latin1');
    expect(pdf.slice(0, 8)).toBe('%PDF-1.4');
    expect(pdf).toContain('xref');
    expect(pdf).toContain('startxref');
    expect(pdf).toContain('%%EOF');
    expect([...assets[2].bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(Buffer.from(assets[2].bytes).toString('latin1')).toContain('IEND');
  });
});
