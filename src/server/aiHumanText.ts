export function normalizeAiHumanReplyText(raw: string, fallback = '收到，我先按当前进度处理，必要时会在群里同步。'): string {
  const cleaned = raw
    .replace(/\r\n/g, '\n')
    .replace(/^```(?:markdown|md)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .split('\n')
    .map((line) => cleanHumanReplyLine(line))
    .filter(Boolean)
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  const limited = limitHumanReply(cleaned);
  return limited || fallback;
}

function cleanHumanReplyLine(line: string): string {
  let cleaned = line.trim();
  if (!cleaned) {
    return '';
  }

  if (isInternalRoleplayLine(cleaned)) {
    return '';
  }

  cleaned = cleaned
    .replace(/^(?:回复|消息|正文|chat message)\s*[:：-]\s*/i, '')
    .replace(/^[「“"](.+)[」”"]$/u, '$1')
    .trim();

  return isInternalRoleplayLine(cleaned) ? '' : cleaned;
}

function isInternalRoleplayLine(value: string): boolean {
  return [
    /^(?:作为|我现在是|我是).*(?:AI|模型|系统|助手|Agent|扮演|角色|模拟)/iu,
    /(?:不是\s*AI|不是\s*我的\s*Agent|不是\s*agent|不能暴露|不要说自己|以.*身份)/iu,
    /(?:我先|先).*(?:检查|查看|读取|检索|分析).*(?:上下文|聊天|日程|任务|文件|工具)/iu,
    /(?:根据|结合).*(?:上下文|聊天记录|系统提示|任务列表|文件库)/iu,
    /(?:推理过程|思考过程|内部|工具调用|运行日志|fallback|deepseek|prompt|system)/iu
  ].some((pattern) => pattern.test(value));
}

function limitHumanReply(value: string): string {
  if (!value) {
    return '';
  }
  const sentences = value.match(/[^。！？.!?\n]+[。！？.!?]?/gu) ?? [value];
  const limited = sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')
    .trim();
  const text = limited || value;
  return text.length > 120 ? `${text.slice(0, 117).trimEnd()}...` : text;
}
