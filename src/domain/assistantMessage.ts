export type AssistantMessageKind = 'reply' | 'delegated_message' | 'delegated_file' | 'coordination';

export function assistantSenderName(ownerName: string): string {
  return ownerName;
}

export function assistantAgentLabel(kind: AssistantMessageKind): string {
  if (kind === 'coordination') {
    return '个人助手协商';
  }
  if (kind === 'reply') {
    return '个人助手回复';
  }
  return '个人助手代发';
}

export function assistantFileShareBody(input: { ownerName: string; fileName: string; latest?: boolean }): string {
  const versionHint = input.latest ? '最新文件' : '文件';
  return `${input.ownerName}的个人助手发送${versionHint}：${input.fileName}`;
}
