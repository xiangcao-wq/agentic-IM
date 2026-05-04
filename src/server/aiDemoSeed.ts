import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AiProvider } from './aiProvider';
import { OpenAiChatCompletionsProvider, RoleRoutedAiProvider } from './aiProvider';
import { runAiDemoScenario, type DemoMatrixGateway } from './aiDemoScenario';
import { loadLocalEnvFile } from './env';
import { MatrixStore } from './matrixClient';
import { JsonStateStore, type StateStore } from './stateStore';

interface AiDemoSeedEnv {
  [key: string]: string | undefined;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_HUMAN_MODEL?: string;
  DEEPSEEK_AGENT_MODEL?: string;
  DEEPSEEK_HUMAN_THINKING?: string;
  DEEPSEEK_AGENT_THINKING?: string;
  DEEPSEEK_HUMAN_REASONING_EFFORT?: string;
  DEEPSEEK_AGENT_REASONING_EFFORT?: string;
  AGENT_IM_DB_PATH?: string;
  MATRIX_BOOTSTRAP_PATH?: string;
}

interface AiDemoSeedInput {
  env: AiDemoSeedEnv;
  stateStore: StateStore;
  matrixGateway: DemoMatrixGateway | null;
  aiProvider: AiProvider;
  now?: string;
}

export interface AiDemoSeedSummary {
  matrixEvents: number;
  generatedFiles: number;
  agentActionRequests: number;
  agentActionLogs: number;
}

export async function runAiDemoSeed(input: AiDemoSeedInput): Promise<AiDemoSeedSummary> {
  assertProviderKeys(input.env);
  if (!input.matrixGateway) {
    throw new Error('Matrix bootstrap is required for real AI demo seed. Run npm run matrix:up first.');
  }

  await preflightAiProviders(input.aiProvider);
  await input.stateStore.init();
  const baseState = await input.stateStore.read();
  const result = await runAiDemoScenario({
    state: baseState,
    aiProvider: input.aiProvider,
    matrixGateway: input.matrixGateway,
    now: input.now
  });

  await input.stateStore.write(result.state);

  return {
    matrixEvents: result.transcript.length,
    generatedFiles: result.state.files.filter(
      (file) => file.tags.includes('ai-seed') && !baseState.files.some((existing) => existing.id === file.id)
    ).length,
    agentActionRequests: Math.max(0, result.state.actionRequests.length - baseState.actionRequests.length),
    agentActionLogs: Math.max(0, result.state.actionLogs.length - baseState.actionLogs.length)
  };
}

async function preflightAiProviders(aiProvider: AiProvider): Promise<void> {
  await aiProvider.generateText({
    actorRole: 'human_user',
    actorId: 'preflight-human',
    instructions: '你是 AI demo 的模型连通性检查。只回复 ok。',
    input: '请回复 ok。',
    maxOutputTokens: 8
  });
  await aiProvider.generateText({
    actorRole: 'personal_agent',
    actorId: 'preflight-agent',
    instructions: '你是 AI demo 的 Agent 模型连通性检查。只回复 ok。',
    input: '请回复 ok。',
    maxOutputTokens: 8
  });
}

export async function runAiDemoSeedFromEnv(env: AiDemoSeedEnv = process.env): Promise<AiDemoSeedSummary> {
  assertProviderKeys(env);
  const dbPath = env.AGENT_IM_DB_PATH ?? join(process.cwd(), 'data', 'agent-im-db.json');
  const matrixBootstrapPath = env.MATRIX_BOOTSTRAP_PATH ?? join(process.cwd(), 'data', 'matrix-bootstrap.json');
  const matrixGateway = await MatrixStore.fromFile(matrixBootstrapPath);
  if (!matrixGateway) {
    throw new Error(`Matrix bootstrap is required at ${matrixBootstrapPath}. Run npm run matrix:up first.`);
  }

  return runAiDemoSeed({
    env,
    stateStore: new JsonStateStore(dbPath),
    matrixGateway,
    aiProvider: createAiDemoSeedProvider(env)
  });
}

export function createAiDemoSeedProvider(env: AiDemoSeedEnv, fetcher: typeof fetch = fetch): AiProvider {
  const baseUrl = env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
  const apiKey = env.DEEPSEEK_API_KEY;
  return new RoleRoutedAiProvider({
    humanProvider: new OpenAiChatCompletionsProvider({
      providerName: 'DeepSeek Flash',
      apiKey,
      baseUrl,
      model: env.DEEPSEEK_HUMAN_MODEL?.trim() || 'deepseek-v4-flash',
      fetcher,
      extraBody: deepSeekExtraBody(env.DEEPSEEK_HUMAN_THINKING, env.DEEPSEEK_HUMAN_REASONING_EFFORT)
    }),
    agentProvider: new OpenAiChatCompletionsProvider({
      providerName: 'DeepSeek Pro',
      apiKey,
      baseUrl,
      model: env.DEEPSEEK_AGENT_MODEL?.trim() || 'deepseek-v4-pro',
      fetcher,
      extraBody: deepSeekExtraBody(
        env.DEEPSEEK_AGENT_THINKING?.trim() || 'enabled',
        env.DEEPSEEK_AGENT_REASONING_EFFORT?.trim() || 'high'
      )
    })
  });
}

function deepSeekExtraBody(thinking: string | undefined, reasoningEffort?: string): Record<string, unknown> | undefined {
  const body: Record<string, unknown> = {};
  if (thinking === 'enabled' || thinking === 'disabled') {
    body.thinking = { type: thinking };
  }
  if (thinking === 'enabled' && isReasoningEffort(reasoningEffort)) {
    body.reasoning_effort = reasoningEffort;
  }
  return Object.keys(body).length > 0 ? body : undefined;
}

function isReasoningEffort(value: string | undefined): value is 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high';
}

function assertProviderKeys(env: AiDemoSeedEnv): void {
  if (!env.DEEPSEEK_API_KEY?.trim()) {
    throw new Error('DEEPSEEK_API_KEY is required for real AI demo seed.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await loadLocalEnvFile(join(process.cwd(), '.env.local'));
  runAiDemoSeedFromEnv()
    .then((summary) => {
      console.log(
        [
          'AI demo seed completed.',
          `Matrix events: ${summary.matrixEvents}`,
          `Generated files: ${summary.generatedFiles}`,
          `Agent action requests: ${summary.agentActionRequests}`,
          `Agent action logs: ${summary.agentActionLogs}`
        ].join('\n')
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
