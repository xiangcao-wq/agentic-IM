// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDemoAssets, createRuntimeDemoAssets } from './demoAssets';

describe('demo assets', () => {
  it('creates real openable text, pdf, and visual files in memory', () => {
    const assets = createDemoAssets();

    expect(assets.map((asset) => asset.contentType)).toContain('text/plain; charset=utf-8');
    expect(assets.map((asset) => asset.contentType)).toContain('application/pdf');
    expect(assets.map((asset) => asset.contentType)).toContain('image/svg+xml');
    expect(Buffer.from(assets[0].bytes).toString('utf8')).toContain('校园服务数字化调研');
    expect(Buffer.from(assets[1].bytes).toString('utf8')).toContain('AgentBridge A2A Autopilot Demo Runbook');
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

    expect(assets.length).toBeGreaterThanOrEqual(19);
    expect(assets.some((asset) => asset.name.includes('image-2-material-prompts'))).toBe(true);
    expect(assets.some((asset) => asset.contentType.startsWith('text/markdown'))).toBe(true);
    const image2Assets = assets.filter((asset) => asset.name.startsWith('image2-'));
    expect(image2Assets).toHaveLength(3);
    expect(image2Assets.every((asset) => asset.contentType === 'image/png')).toBe(true);
    expect(image2Assets.every((asset) => asset.bytes.byteLength > 100_000)).toBe(true);
    expect(assets.some((asset) => asset.name === 'agentbridge-a2a-investor-demo-onepager.pdf')).toBe(true);
    expect(assets.some((asset) => asset.name === 'presenter-script-agentbridge-2min.md')).toBe(true);
  });

  it('uses AgentBridge-native asset names and natural Chinese demo triggers', () => {
    const assets = createRuntimeDemoAssets();
    const serialized = JSON.stringify(assets.map((asset) => ({
      name: asset.name,
      summary: asset.summary,
      text: asset.contentType.includes('text') ? Buffer.from(asset.bytes).toString('utf8') : ''
    })));

    expect(assets.every((asset) => !asset.name.includes('agent-im'))).toBe(true);
    expect(serialized).not.toMatch(/Lin Agent|Chen Agent|Agent IM|agent-im/i);
    expect(serialized).toContain('帮我和陈晨商量一下，把合稿检查改到周三 23:00');
    expect(serialized).toContain('她的个人助手能不能把最新演示稿发给陈晨');
  });
});
