interface NormalizeAgentUserTextOptions {
  maxChars?: number;
  maxSentences?: number;
  fallback?: string;
}

const traceLinePrefixes = [
  /^\s*(tool\s*trace|tool\s*calls?|tools?|execution\s*trace|runtime\s*trace|debug|reasoning|chain\s+of\s+thought|hidden\s+reasoning|analysis|internal\s+notes?)\s*[:：-]/i,
  /^\s*(处理方式|执行步骤|工具调用|运行过程|推理过程|思考过程|内部过程|调试信息)\s*[:：-]/u
];

const traceTokenPattern =
  /\b(?:deepseek\.[\w.-]+|fallback\.[\w.-]+|room_search|file_library\.[\w.-]+|memory\.[\w.-]+|agent_to_agent\.[\w.-]+|agent\.coordinate|calendar\.inspect|deadline\.answer|chat\.answer|llm\.evaluate|tool_[\w.-]+)\b/gi;

export function normalizeAgentUserText(
  raw: string | undefined,
  options: NormalizeAgentUserTextOptions = {}
): string {
  const fallback = options.fallback ?? '';
  if (!raw || !raw.trim()) {
    return fallback;
  }

  const withoutMarkdown = raw
    .replace(/\r\n/g, '\n')
    .replace(/^```(?:json|markdown|md)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1');

  const lines = withoutMarkdown
    .split('\n')
    .map(cleanAgentDisplayLine)
    .filter(Boolean);

  const normalized = lines.join('\n').replace(/[ \t]+/g, ' ').trim();
  const limited = limitAgentUserText(normalized, {
    maxChars: options.maxChars ?? 260,
    maxSentences: options.maxSentences ?? 3
  });
  return limited || fallback;
}

export function normalizeAgentRiskReason(raw: string | undefined): string {
  return normalizeAgentUserText(raw, {
    maxChars: 160,
    maxSentences: 1,
    fallback: 'Needs human confirmation.'
  });
}

function cleanAgentDisplayLine(line: string): string {
  let cleaned = line.trim();
  if (!cleaned) {
    return '';
  }

  if (traceLinePrefixes.some((pattern) => pattern.test(cleaned))) {
    return '';
  }

  cleaned = cleaned
    .replace(/^(?:[\w.-]+(?:\s*->\s*[\w.-]+)+)\s*[;；:：-]?\s*/i, '')
    .replace(traceTokenPattern, '')
    .replace(/\s*->\s*/g, ' ')
    .replace(/\s+([,.;:!?，。；：！？])/g, '$1')
    .replace(/^[,.;:!?，。；：！？\-\s]+/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return cleaned && !/^[,.;:!?，。；：！？\-\s]+$/.test(cleaned) ? cleaned : '';
}

function limitAgentUserText(
  text: string,
  options: { maxChars: number; maxSentences: number }
): string {
  if (!text) {
    return '';
  }

  const sentences = text.match(/[^。！？.!?\n]+[。！？.!?]?/gu) ?? [text];
  const sentenceLimited = sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, options.maxSentences)
    .join(' ')
    .trim();
  const value = sentenceLimited || text;
  return value.length > options.maxChars ? `${value.slice(0, options.maxChars - 3).trimEnd()}...` : value;
}
