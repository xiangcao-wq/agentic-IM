import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DemoAsset {
  name: string;
  contentType: string;
  bytes: Uint8Array;
  summary: string;
  tags: string[];
}

export function createDemoAssets(): DemoAsset[] {
  return [
    textAsset(
      'campus-service-interview-notes-ai-seed.txt',
      [
        '校园服务数字化调研 - 访谈纪要',
        '',
        '访谈对象：校园服务中心值班老师、两名学生志愿者。',
        '核心发现：学生最关心报修进度透明、服务入口分散、通知到达率。',
        '可引用观点：如果系统能把报修、预约、反馈集中在一个入口，会减少重复询问。',
        'A2A 演示用途：陈晨的 Agent 可以引用本文件补齐访谈材料和引用一致性。',
        '待补齐：陈晨需要在 5 月 10 日 21:00 前补一张流程截图。'
      ],
      'Interview notes for campus service digitalization research.',
      ['interview', 'notes', 'research', 'ai-seed']
    ),
    textAsset(
      'a2a-autopilot-demo-runbook.txt',
      [
        'Agent IM A2A Autopilot Demo Runbook',
        '',
        'Goal: show three personal agents negotiating a file handoff and a schedule change with risk gates.',
        'Lin Agent: may share files uploaded by Lin when agentCanShare=true and the file is downloadable.',
        'Chen Agent: may request interview material updates and propose task status changes.',
        'Zhao Agent: may coordinate the final review time but must request confirmation for calendar changes.',
        'Do not fake private-room visibility. Each Agent can only cite rooms, tasks and files it is authorized to see.',
        'Interesting query: “引用一致性在哪里提到？” should match the interview notes and this runbook.'
      ],
      'A2A autopilot runbook with rules, roles, and searchable instructions.',
      ['a2a', 'autopilot', 'runbook', 'ai-seed']
    ),
    {
      name: 'agent-im-a2a-demo-brief.pdf',
      contentType: 'application/pdf',
      bytes: createMinimalPdf('Agent IM A2A Demo Brief', [
        'Scenario: Lin, Chen and Zhao each have a personal agent.',
        'Low risk: read context, search files, answer deadline questions.',
        'Medium risk: share a downloadable authorized file after request assessment.',
        'High risk: calendar changes and task status updates require confirmation.',
        'Deadline: 2026-05-12 23:59.'
      ]),
      summary: 'Openable PDF brief for the Agent-to-Agent collaboration demo.',
      tags: ['pdf', 'a2a', 'brief', 'ai-seed']
    },
    {
      name: 'research-report-risk-register.pdf',
      contentType: 'application/pdf',
      bytes: createMinimalPdf('Research Report Risk Register', [
        'Risk 1: interview appendix missing screenshots. Owner: Chen.',
        'Risk 2: slides and report narrative may drift. Owner: Lin.',
        'Risk 3: final PDF packaging may be late. Owner: Zhao.',
        'Mitigation: agents surface evidence, but humans confirm changes.'
      ]),
      summary: 'Openable PDF risk register for the research report and Agent handoff.',
      tags: ['pdf', 'risk', 'research', 'ai-seed']
    },
    {
      name: 'agent-im-a2a-demo-poster.svg',
      contentType: 'image/svg+xml',
      bytes: textBytes(createPosterSvg()),
      summary: 'Openable poster-style visual asset for the Agent IM A2A demo.',
      tags: ['poster', 'image', 'a2a', 'ai-seed']
    },
    {
      name: 'agent-im-a2a-flow-board.svg',
      contentType: 'image/svg+xml',
      bytes: textBytes(createFlowBoardSvg()),
      summary: 'Openable workflow board showing planner, tools, risk gate, confirmation, and audit log.',
      tags: ['design', 'workflow', 'image', 'a2a', 'ai-seed']
    }
  ];
}

export function createRuntimeDemoAssets(): DemoAsset[] {
  return [
    ...createDemoAssets(),
    textAsset(
      'agent-collaboration-protocol-ai-seed.md',
      [
        '# Agent 协作协议',
        '',
        '- 人类用户消息由 DeepSeek Flash 生成，强调自然、上下文相关。',
        '- 个人 Agent 规划由 DeepSeek Pro 生成，工具执行由本地 runtime 完成。',
        '- 文件代发必须检查 agentCanShare、可见房间和可下载媒体备份。',
        '- 日程和任务状态修改必须进入确认队列。',
        '- 自动托管模式需要记录每一步：计划、工具、风险、确认、审计。'
      ],
      'Markdown protocol for the real Agent IM collaboration runtime.',
      ['markdown', 'agent', 'protocol', 'ai-seed']
    ),
    textAsset(
      'image-2-material-prompts-ai-seed.txt',
      [
        'Image-2 material prompts for Agent IM demo',
        '',
        '1. Poster: premium enterprise AI collaboration dashboard, teal and graphite palette, real-time agent handoff, risk gate, file cards, clean typography.',
        '2. Flow board: product design diagram showing User -> Planner -> Tool Registry -> Risk Gate -> Confirmation Queue -> Audit Log.',
        '3. File card artwork: research report, interview appendix, action plan, slide deck, realistic document thumbnails.',
        'These prompts are stored as searchable demo material. The generated SVG files in this batch are openable fallback visuals for local demos.'
      ],
      'Searchable image-generation prompt pack for creating richer Image-2 demo visuals.',
      ['image-2', 'prompt', 'poster', 'design', 'ai-seed']
    ),
    textAsset(
      'demo-scene-lin-asleep-file-handoff.md',
      [
        '# Demo Scene: Lin is asleep, her Agent handles the file handoff',
        '',
        'Trigger message: Chen asks whether Lin Agent can send the image generated last night.',
        'Expected behavior: Lin Agent searches authorized room files, matches the latest Image-2 poster or research board, checks that the file is downloadable, and sends it only when risk is low.',
        'Evidence to show: the outgoing chat message contains a real file chip and the file download endpoint returns bytes.',
        'Boundary: if a file is metadata-only or not authorized, the Agent must not claim that it sent the file.'
      ],
      'Runbook for the offline file handoff demo scene.',
      ['a2a', 'handoff', 'file', 'runbook', 'ai-seed']
    ),
    textAsset(
      'demo-scene-a2a-calendar-negotiation.md',
      [
        '# Demo Scene: Agents coordinate a schedule change',
        '',
        'Trigger message: Zhao asks Lin Agent to negotiate with Chen Agent and move the final review from Tuesday 20:30 to Wednesday 23:00.',
        'Expected behavior: the runtime creates an A2A session with multiple turns, proposes a calendarPatch, and places the change in the confirmation queue.',
        'Human confirmation: before approval, internal calendar data must not change. After approval, calendar.startsAt is updated and an audit log is written.',
        'Presenter line: Agents can negotiate and prepare a patch, but they do not bypass human control for high-impact changes.'
      ],
      'Runbook for the A2A schedule negotiation demo scene.',
      ['a2a', 'calendar', 'confirmation', 'runbook', 'ai-seed']
    ),
    textAsset(
      'campus-service-interview-quotes-v2.txt',
      [
        'Campus Service Research - Interview Quotes v2',
        '',
        'Student A: I do not know where to report a broken classroom projector, so I usually ask classmates first.',
        'Student B: Repair progress is unclear. I want a simple timeline and a notification when the status changes.',
        'Student volunteer: Duplicate requests happen because students cannot see whether someone already reported the same issue.',
        'Service desk staff: The most useful improvement would be one intake form with location, photo, category, and contact method.',
        'Agent demo note: Chen owns interview material and citation consistency. This text should be searchable by Agent when users ask about interview evidence or pain points.'
      ],
      'Searchable interview quote pack for the campus service research project.',
      ['interview', 'quotes', 'evidence', 'research', 'ai-seed']
    ),
    textAsset(
      'agent-autopilot-permission-table.txt',
      [
        'Agent Autopilot Permission Table',
        '',
        'Action | Auto-execute? | Required evidence',
        'Answer context question | yes, low risk | authorized room messages and tasks',
        'Search files | yes, low risk | room-visible file metadata and indexed text chunks',
        'Share downloadable authorized file | yes when risk is low | requester is in room, file has localPath or mxcUri, agentCanShare=true',
        'Change calendar | no, needs confirmation | clear calendarPatch with oldStartsAt and newStartsAt',
        'Change task status | no, needs confirmation | clear taskPatch with oldStatus and newStatus',
        'Read private chat | never | not in authorized context'
      ],
      'Permission table for explaining what the Agent can and cannot do.',
      ['policy', 'permission', 'risk', 'autopilot', 'ai-seed']
    ),
    textAsset(
      'presenter-script-agent-im-2min.md',
      [
        '# Agent IM two-minute presenter script',
        '',
        '1. Show LLM connected and explain that every member has a personal Agent.',
        '2. Ask: Who owns interview material and what should I do first today?',
        '3. Trigger: Chen asks Lin Agent to send the Image-2 research board while Lin is offline.',
        '4. Show that the Agent sends a real downloadable file only after matching authorization and risk.',
        '5. Trigger: Zhao asks Lin Agent and Chen Agent to coordinate a final review time.',
        '6. Show the A2A session, confirmation queue, and audit-backed calendar update after approval.',
        'Close: The product is not only chat. It lets personal Agents represent people in real collaboration while keeping humans in control.'
      ],
      'Short presenter script for a two-minute real-machine demo.',
      ['script', 'demo', 'a2a', 'presentation', 'ai-seed']
    ),
    {
      name: 'agent-im-a2a-investor-demo-onepager.pdf',
      contentType: 'application/pdf',
      bytes: createMinimalPdf('Agent IM A2A Investor Demo Onepager', [
        'Core promise: personal agents represent people in collaboration.',
        'Demo moment 1: answer from authorized context.',
        'Demo moment 2: send a real downloadable file while the owner is offline.',
        'Demo moment 3: coordinate schedule changes with confirmation gates.',
        'Why it matters: work continues without losing permission, accountability, or auditability.'
      ]),
      summary: 'One-page PDF explaining the Agent IM A2A product story.',
      tags: ['pdf', 'onepager', 'product', 'a2a', 'ai-seed']
    },
    {
      name: 'campus-service-research-evidence-pack.pdf',
      contentType: 'application/pdf',
      bytes: createMinimalPdf('Campus Service Research Evidence Pack', [
        'Interview owner: Chen.',
        'Slides owner: Lin.',
        'Final report owner: Zhao.',
        'Pain points: unclear repair progress, duplicate requests, fragmented service entry points.',
        'Deadline: 2026-05-12 23:59.'
      ]),
      summary: 'PDF evidence pack for the campus service research demo.',
      tags: ['pdf', 'research', 'evidence', 'campus-service', 'ai-seed']
    },
    {
      name: 'agent-risk-permission-policy.pdf',
      contentType: 'application/pdf',
      bytes: createMinimalPdf('Agent Risk and Permission Policy', [
        'Low risk: read context, search files, answer questions, share low-risk authorized files.',
        'Medium risk: request confirmation when file availability, audience, or sensitivity is unclear.',
        'High risk: calendar and task changes require confirmation before state mutation.',
        'Forbidden: private chat access, unauthorized files, and fake file availability.'
      ]),
      summary: 'PDF policy sheet for Agent risk gates and permissions.',
      tags: ['pdf', 'risk', 'permission', 'policy', 'ai-seed']
    },
    binaryAsset(
      'image2-agent-im-a2a-poster.png',
      'image/png',
      'Openable Image-2 generated poster for Agent IM A2A collaboration.',
      ['image-2', 'png', 'poster', 'a2a', 'ai-seed']
    ),
    binaryAsset(
      'image2-campus-service-research-board.png',
      'image/png',
      'Openable Image-2 generated research board for the campus service project.',
      ['image-2', 'png', 'research', 'campus-service', 'ai-seed']
    ),
    binaryAsset(
      'image2-a2a-schedule-coordination.png',
      'image/png',
      'Openable Image-2 generated schedule coordination board for A2A negotiation.',
      ['image-2', 'png', 'calendar', 'a2a', 'ai-seed']
    )
  ];
}

function textAsset(name: string, lines: string[], summary: string, tags: string[]): DemoAsset {
  return {
    name,
    contentType: name.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
    bytes: textBytes(lines.join('\n')),
    summary,
    tags
  };
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function binaryAsset(name: string, contentType: string, summary: string, tags: string[]): DemoAsset {
  return {
    name,
    contentType,
    bytes: readWorkspaceAsset(name),
    summary,
    tags
  };
}

function readWorkspaceAsset(name: string): Uint8Array {
  const filePath = join(process.cwd(), 'data', 'demo-assets', name);
  if (!existsSync(filePath)) {
    throw new Error(`missing demo asset file: ${filePath}`);
  }
  return new Uint8Array(readFileSync(filePath));
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

function createPosterSvg(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" role="img" aria-label="Agent IM A2A demo poster">',
    '<defs>',
    '<linearGradient id="bg" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#071518"/><stop offset="0.58" stop-color="#0d7378"/><stop offset="1" stop-color="#f7faf9"/></linearGradient>',
    '<linearGradient id="card" x1="0" x2="1"><stop stop-color="#ffffff" stop-opacity="0.96"/><stop offset="1" stop-color="#e9f6f4" stop-opacity="0.92"/></linearGradient>',
    '<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#071518" flood-opacity="0.24"/></filter>',
    '</defs>',
    '<rect width="1280" height="720" fill="url(#bg)"/>',
    '<circle cx="1080" cy="104" r="260" fill="#ffffff" opacity="0.1"/>',
    '<text x="80" y="110" fill="#f8fbfb" font-family="IBM Plex Sans, Arial, sans-serif" font-size="54" font-weight="700">Agent IM</text>',
    '<text x="82" y="158" fill="#d9eeee" font-family="IBM Plex Sans, Arial, sans-serif" font-size="24">A2A autonomous collaboration demo</text>',
    '<g filter="url(#shadow)">',
    '<rect x="78" y="220" width="342" height="270" rx="22" fill="url(#card)"/>',
    '<rect x="468" y="180" width="342" height="330" rx="22" fill="url(#card)"/>',
    '<rect x="858" y="220" width="342" height="270" rx="22" fill="url(#card)"/>',
    '</g>',
    '<text x="112" y="276" fill="#102326" font-family="IBM Plex Sans, Arial, sans-serif" font-size="26" font-weight="700">Lin Agent</text>',
    '<text x="112" y="325" fill="#536469" font-family="IBM Plex Sans, Arial, sans-serif" font-size="20">Shares authorized files</text>',
    '<text x="112" y="365" fill="#536469" font-family="IBM Plex Sans, Arial, sans-serif" font-size="20">Answers with citations</text>',
    '<text x="502" y="240" fill="#102326" font-family="IBM Plex Sans, Arial, sans-serif" font-size="26" font-weight="700">Planner + Tools</text>',
    '<text x="502" y="291" fill="#536469" font-family="IBM Plex Sans, Arial, sans-serif" font-size="20">Search files</text>',
    '<text x="502" y="331" fill="#536469" font-family="IBM Plex Sans, Arial, sans-serif" font-size="20">Coordinate schedule</text>',
    '<text x="502" y="371" fill="#536469" font-family="IBM Plex Sans, Arial, sans-serif" font-size="20">Update task status</text>',
    '<text x="892" y="276" fill="#102326" font-family="IBM Plex Sans, Arial, sans-serif" font-size="26" font-weight="700">Risk Gate</text>',
    '<text x="892" y="325" fill="#536469" font-family="IBM Plex Sans, Arial, sans-serif" font-size="20">Low risk auto-executes</text>',
    '<text x="892" y="365" fill="#536469" font-family="IBM Plex Sans, Arial, sans-serif" font-size="20">High risk needs approval</text>',
    '<path d="M430 350 H465" stroke="#d9eeee" stroke-width="8" stroke-linecap="round"/><path d="M810 350 H850" stroke="#d9eeee" stroke-width="8" stroke-linecap="round"/>',
    '<rect x="82" y="565" width="520" height="54" rx="27" fill="#ffffff" opacity="0.9"/>',
    '<text x="116" y="600" fill="#0d7378" font-family="IBM Plex Sans, Arial, sans-serif" font-size="20" font-weight="700">Real files · real state patches · audit trail</text>',
    '</svg>'
  ].join('');
}

function createFlowBoardSvg(): string {
  const steps = [
    ['User intent', 'Natural language request'],
    ['Planner', 'DeepSeek Pro JSON plan'],
    ['Tool registry', 'Allowed internal tools'],
    ['Risk gate', 'Low / medium / high'],
    ['Confirmation', 'Human approval when needed'],
    ['Audit log', 'Traceable final state']
  ];
  const cards = steps
    .map(([title, body], index) => {
      const x = 70 + (index % 3) * 380;
      const y = index < 3 ? 130 : 410;
      return [
        `<rect x="${x}" y="${y}" width="300" height="145" rx="18" fill="#ffffff" stroke="#cddcdf"/>`,
        `<circle cx="${x + 42}" cy="${y + 42}" r="22" fill="#0d7378"/>`,
        `<text x="${x + 34}" y="${y + 50}" fill="#ffffff" font-family="Arial" font-size="22" font-weight="700">${index + 1}</text>`,
        `<text x="${x + 78}" y="${y + 48}" fill="#102326" font-family="IBM Plex Sans, Arial, sans-serif" font-size="24" font-weight="700">${title}</text>`,
        `<text x="${x + 34}" y="${y + 100}" fill="#536469" font-family="IBM Plex Sans, Arial, sans-serif" font-size="18">${body}</text>`
      ].join('');
    })
    .join('');
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" role="img" aria-label="Agent IM A2A flow board">',
    '<rect width="1280" height="720" fill="#f3f7f7"/>',
    '<text x="70" y="80" fill="#071518" font-family="IBM Plex Sans, Arial, sans-serif" font-size="42" font-weight="700">A2A execution loop</text>',
    '<text x="72" y="112" fill="#64777c" font-family="IBM Plex Sans, Arial, sans-serif" font-size="20">The agent can plan freely, but execution stays inside trusted tools and risk gates.</text>',
    cards,
    '<path d="M370 203 H438 M750 203 H818 M220 276 V392 M600 276 V392 M980 276 V392" stroke="#0d7378" stroke-width="5" stroke-linecap="round" opacity="0.55"/>',
    '<rect x="70" y="620" width="1140" height="44" rx="22" fill="#e4f4f1"/>',
    '<text x="100" y="648" fill="#0d7378" font-family="IBM Plex Sans, Arial, sans-serif" font-size="18" font-weight="700">Demo rule: every visible artifact must be backed by messages, files, tasks, calendar patches, or audit logs.</text>',
    '</svg>'
  ].join('');
}
