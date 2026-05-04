// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoAssets, createRuntimeDemoAssets } from './demoAssets';

describe('demo assets', () => {
  it('creates real openable text, pdf, and visual files in memory', () => {
    const assets = createDemoAssets();

    expect(assets.map((asset) => asset.contentType)).toEqual([
      'text/plain; charset=utf-8',
      'text/plain; charset=utf-8',
      'application/pdf',
      'application/pdf',
      'image/svg+xml',
      'image/svg+xml'
    ]);
    expect(Buffer.from(assets[0].bytes).toString('utf8')).toContain('校园服务数字化调研');
    expect(Buffer.from(assets[1].bytes).toString('utf8')).toContain('Agent IM A2A Autopilot Demo Runbook');
    const pdf = Buffer.from(assets[2].bytes).toString('latin1');
    expect(pdf.slice(0, 8)).toBe('%PDF-1.4');
    expect(pdf).toContain('xref');
    expect(pdf).toContain('startxref');
    expect(pdf).toContain('%%EOF');
    expect(Buffer.from(assets[4].bytes).toString('utf8')).toContain('<svg');
    expect(Buffer.from(assets[5].bytes).toString('utf8')).toContain('A2A execution loop');
  });

  it('adds searchable prompt and protocol material for runtime demos', () => {
    const assets = createRuntimeDemoAssets();

    expect(assets).toHaveLength(8);
    expect(assets.some((asset) => asset.name.includes('image-2-material-prompts'))).toBe(true);
    expect(assets.some((asset) => asset.contentType.startsWith('text/markdown'))).toBe(true);
  });
});
