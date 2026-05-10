export interface CacheFriendlyMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function buildCacheFriendlyMessages(
  systemPrompt: string,
  context: string,
  requestTail: string
): CacheFriendlyMessage[] {
  const { stable, volatile } = splitContextForPrefixCache(context);
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: stable },
    { role: 'user', content: [volatile, requestTail].filter(Boolean).join('\n\n') }
  ];
}

function splitContextForPrefixCache(context: string): { stable: string; volatile: string } {
  const blocks = context.split(/\n(?=## )/);
  if (blocks.length <= 1) {
    return { stable: context, volatile: '' };
  }

  const stableSections = [blocks[0]];
  const rankedStableSections: Array<{ rank: number; block: string }> = [];
  const volatileSections: string[] = [];

  for (const block of blocks.slice(1)) {
    const title = block.match(/^## ([^\n]+)/)?.[1]?.trim();
    const rank = title ? stableSectionRanks.get(title) : undefined;
    if (rank !== undefined) {
      rankedStableSections.push({ rank, block });
    } else {
      volatileSections.push(block);
    }
  }
  rankedStableSections
    .sort((left, right) => left.rank - right.rank)
    .forEach((section) => stableSections.push(section.block));

  return {
    stable: stableSections.filter(Boolean).join('\n\n'),
    volatile: volatileSections.filter(Boolean).join('\n\n')
  };
}

const stableSectionRanks = new Map<string, number>([
  ['Members', 10],
  ['Files', 20],
  ['Tasks', 30],
  ['Calendar availability', 40]
]);
