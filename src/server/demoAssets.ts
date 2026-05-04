export interface DemoAsset {
  name: string;
  contentType: string;
  bytes: Uint8Array;
  summary: string;
  tags: string[];
}

export function createDemoAssets(): DemoAsset[] {
  return [
    {
      name: '第4组-访谈纪要-ai-seed.txt',
      contentType: 'text/plain; charset=utf-8',
      bytes: textBytes(
        [
          '校园服务数字化调研 - 访谈纪要',
          '',
          '访谈对象：校园服务中心值班老师、两名学生志愿者',
          '核心发现：学生最关心报修进度透明、服务入口分散、通知到达率。',
          '可引用观点：如果系统能把报修、预约、反馈集中在一个入口，会减少重复询问。',
          '待补充：陈晨需要在 5 月 10 日前补一张流程截图。'
        ].join('\n')
      ),
      summary: 'AI demo generated interview notes for campus service digitalization research.',
      tags: ['interview', 'notes', 'ai-seed']
    },
    {
      name: '第4组-校园服务数字化调研-行动计划.pdf',
      contentType: 'application/pdf',
      bytes: createMinimalPdf('第4组校园服务数字化调研行动计划', [
        'Deadline: 2026-05-12 23:59',
        'Owner: Zhao Yiming submits final report.',
        'Lin Wen owns slides and demo narrative.',
        'Chen Chen owns interview appendix.'
      ]),
      summary: 'Openable PDF action plan for the group assignment and Agent demo.',
      tags: ['plan', 'pdf', 'slides', 'ai-seed']
    },
    {
      name: '校园服务流程图-ai-seed.png',
      contentType: 'image/png',
      bytes: createSeedPng(),
      summary: 'Openable PNG image used as a workflow illustration in the AI demo.',
      tags: ['workflow', 'image', 'ai-seed']
    }
  ];
}

export function createRuntimeDemoAssets(): DemoAsset[] {
  const [notes, pdf, png] = createDemoAssets();
  return [
    notes,
    {
      name: '第4组-Agent协作说明-ai-seed.md',
      contentType: 'text/markdown; charset=utf-8',
      bytes: textBytes(
        [
          '# Agent 协作说明',
          '',
          '- AI 人类用户使用 DeepSeek Flash 生成真实聊天回复。',
          '- 个人 Agent 使用 DeepSeek Pro 生成计划，但工具执行由本地 runtime 完成。',
          '- 文件代发必须检查 agentCanShare 和房间权限。',
          '- 所有动作必须写入审计日志。'
        ].join('\n')
      ),
      summary: 'Markdown explanation of the real Agent IM demo runtime.',
      tags: ['markdown', 'agent', 'ai-seed']
    },
    pdf,
    png
  ];
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function createMinimalPdf(title: string, lines: string[]): Uint8Array {
  const escapedTitle = pdfEscape(title);
  const text = [escapedTitle, ...lines.map(pdfEscape)]
    .map((line, index) => `BT /F1 12 Tf 72 ${740 - index * 22} Td (${line}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${byteLength(text)} >>\nstream\n${text}\nendstream`
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n`;
  output += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return textBytes(output);
}

function pdfEscape(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '?').replace(/[()\\]/g, (match) => `\\${match}`);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function createSeedPng(): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAVElEQVR4nO3PQQ0AIBDAMMC/5+ONAvZoFSzZnpmZ3QX8pQK1ArUCtQK1ArUCtQK1ArUCtQK1ArUCtQK1ArUCtQK1ArUCtQK1ArUCtQK1ArUCtQK1AhsfXwJ/WNvz+wAAAABJRU5ErkJggg==',
      'base64'
    )
  );
}
