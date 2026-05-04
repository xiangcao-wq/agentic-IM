export interface AgentEvalCliConfig {
  useRealProvider: boolean;
}

type AgentEvalCliEnv = Record<string, string | undefined> & {
  DEEPSEEK_API_KEY?: string | undefined;
};

export function resolveAgentEvalCliConfig(
  argv: string[],
  env: AgentEvalCliEnv
): AgentEvalCliConfig {
  const useRealProvider = argv.includes('--real');
  if (useRealProvider && !env.DEEPSEEK_API_KEY?.trim()) {
    throw new Error('DEEPSEEK_API_KEY is required for npm run eval:agent:real');
  }
  return { useRealProvider };
}
