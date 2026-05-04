export type AiActorRole = 'human_user' | 'personal_agent';

export interface AiTextPrompt {
  actorRole?: AiActorRole;
  actorId?: string;
  instructions: string;
  input: string;
  messages?: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  maxOutputTokens?: number;
  responseFormat?: 'text' | 'json_object';
  thinking?: { type: 'enabled' | 'disabled' };
}

export interface AiProvider {
  generateText(prompt: AiTextPrompt): Promise<string>;
}

export interface AiUsageSnapshot {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  promptCacheHitRate: number;
  lastUpdatedAt?: string;
  routes?: Array<{
    role: AiActorRole;
    provider: string;
    requestCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    promptCacheHitTokens: number;
    promptCacheMissTokens: number;
    promptCacheHitRate: number;
    lastUpdatedAt?: string;
  }>;
}

export interface AiUsageInspectable {
  getUsageSnapshot(): AiUsageSnapshot;
}

interface OpenAiResponsesProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetcher?: typeof fetch;
}

interface OpenAiChatCompletionsProviderOptions {
  providerName: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
  fetcher?: typeof fetch;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

interface ResponsesApiBody {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}

interface ChatCompletionsApiBody {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

export class OpenAiResponsesProvider implements AiProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetcher: typeof fetch;

  constructor(options: OpenAiResponsesProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, '');
    this.model = options.model ?? process.env.AGENT_IM_AI_MODEL ?? 'gpt-5.2';
    this.fetcher = options.fetcher ?? fetch;
  }

  async generateText(prompt: AiTextPrompt): Promise<string> {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is required for real AI demo generation');
    }

    const response = await this.fetcher(`${this.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        instructions: prompt.instructions,
        input: prompt.input,
        max_output_tokens: prompt.maxOutputTokens ?? 220
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI Responses API failed ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as ResponsesApiBody;
    const text = extractResponseText(body).trim();
    if (!text) {
      throw new Error('OpenAI Responses API returned no text output');
    }
    return text;
  }
}

export class OpenAiChatCompletionsProvider implements AiProvider, AiUsageInspectable {
  private readonly providerName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetcher: typeof fetch;
  private readonly extraHeaders: Record<string, string>;
  private readonly extraBody: Record<string, unknown>;
  private readonly usage: AiUsageSnapshot = createEmptyUsageSnapshot();

  constructor(options: OpenAiChatCompletionsProviderOptions) {
    this.providerName = options.providerName;
    this.apiKey = options.apiKey ?? '';
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.fetcher = options.fetcher ?? fetch;
    this.extraHeaders = options.extraHeaders ?? {};
    this.extraBody = options.extraBody ?? {};
  }

  async generateText(prompt: AiTextPrompt): Promise<string> {
    if (!this.apiKey) {
      throw new Error(`${this.providerName} API key is required for real AI demo generation`);
    }

    const requestBody = {
      model: this.model,
      messages: prompt.messages ?? [
        { role: 'system', content: prompt.instructions },
        { role: 'user', content: prompt.input }
      ],
      max_tokens: prompt.maxOutputTokens ?? 220,
      stream: false,
      ...(prompt.responseFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
      ...this.extraBody,
      ...(prompt.thinking ? { thinking: prompt.thinking } : {})
    };

    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        ...this.extraHeaders
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`${this.providerName} chat completions failed ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as ChatCompletionsApiBody;
    updateUsageSnapshot(this.usage, body.usage);
    const text = extractChatCompletionText(body).trim();
    if (!text) {
      throw new Error(`${this.providerName} chat completions returned no text output`);
    }
    return text;
  }

  getUsageSnapshot(): AiUsageSnapshot {
    return cloneUsageSnapshot(this.usage);
  }
}

export class RoleRoutedAiProvider implements AiProvider, AiUsageInspectable {
  constructor(private readonly providers: { humanProvider: AiProvider; agentProvider: AiProvider }) {}

  async generateText(prompt: AiTextPrompt): Promise<string> {
    if (prompt.actorRole === 'human_user') {
      return this.providers.humanProvider.generateText(prompt);
    }
    if (prompt.actorRole === 'personal_agent') {
      return this.providers.agentProvider.generateText(prompt);
    }
    throw new Error('actorRole is required to route AI generation between DeepSeek and MiMo');
  }

  getUsageSnapshot(): AiUsageSnapshot {
    const routes = [
      usageRoute('human_user', 'human', this.providers.humanProvider),
      usageRoute('personal_agent', 'agent', this.providers.agentProvider)
    ].filter((route): route is NonNullable<typeof route> => Boolean(route));
    const aggregate = aggregateUsageSnapshots(routes);
    return {
      ...aggregate,
      routes
    };
  }
}

export function getAiUsageSnapshot(provider?: AiProvider): AiUsageSnapshot | undefined {
  if (!provider || !isUsageInspectable(provider)) {
    return undefined;
  }
  return provider.getUsageSnapshot();
}

function extractResponseText(body: ResponsesApiBody): string {
  if (typeof body.output_text === 'string') {
    return body.output_text;
  }

  return (
    body.output
      ?.flatMap((item) => item.content ?? [])
      .filter((content) => content.type === 'output_text' && typeof content.text === 'string')
      .map((content) => content.text)
      .join('\n') ?? ''
  );
}

function extractChatCompletionText(body: ChatCompletionsApiBody): string {
  const message = body.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === 'string') {
    return content || message?.reasoning_content || '';
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
    return text || message?.reasoning_content || '';
  }
  return message?.reasoning_content || '';
}

function isUsageInspectable(provider: AiProvider): provider is AiProvider & AiUsageInspectable {
  return typeof (provider as Partial<AiUsageInspectable>).getUsageSnapshot === 'function';
}

function createEmptyUsageSnapshot(): AiUsageSnapshot {
  return {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    promptCacheHitRate: 0
  };
}

function updateUsageSnapshot(
  snapshot: AiUsageSnapshot,
  usage: ChatCompletionsApiBody['usage'] | undefined
): void {
  snapshot.requestCount += 1;
  snapshot.promptTokens += usage?.prompt_tokens ?? 0;
  snapshot.completionTokens += usage?.completion_tokens ?? 0;
  snapshot.totalTokens += usage?.total_tokens ?? 0;
  snapshot.promptCacheHitTokens += usage?.prompt_cache_hit_tokens ?? 0;
  snapshot.promptCacheMissTokens += usage?.prompt_cache_miss_tokens ?? 0;
  snapshot.promptCacheHitRate = calculateCacheHitRate(snapshot);
  snapshot.lastUpdatedAt = new Date().toISOString();
}

function cloneUsageSnapshot(snapshot: AiUsageSnapshot): AiUsageSnapshot {
  return {
    ...snapshot,
    routes: snapshot.routes?.map((route) => ({ ...route }))
  };
}

function usageRoute(
  role: AiActorRole,
  providerName: string,
  provider: AiProvider
): NonNullable<AiUsageSnapshot['routes']>[number] | undefined {
  const snapshot = getAiUsageSnapshot(provider);
  if (!snapshot) {
    return undefined;
  }
  return {
    role,
    provider: providerName,
    requestCount: snapshot.requestCount,
    promptTokens: snapshot.promptTokens,
    completionTokens: snapshot.completionTokens,
    totalTokens: snapshot.totalTokens,
    promptCacheHitTokens: snapshot.promptCacheHitTokens,
    promptCacheMissTokens: snapshot.promptCacheMissTokens,
    promptCacheHitRate: snapshot.promptCacheHitRate,
    lastUpdatedAt: snapshot.lastUpdatedAt
  };
}

function aggregateUsageSnapshots(
  snapshots: Array<Omit<NonNullable<AiUsageSnapshot['routes']>[number], 'role' | 'provider'>>
): AiUsageSnapshot {
  const aggregate = snapshots.reduce((next, snapshot) => {
    next.requestCount += snapshot.requestCount;
    next.promptTokens += snapshot.promptTokens;
    next.completionTokens += snapshot.completionTokens;
    next.totalTokens += snapshot.totalTokens;
    next.promptCacheHitTokens += snapshot.promptCacheHitTokens;
    next.promptCacheMissTokens += snapshot.promptCacheMissTokens;
    if (!next.lastUpdatedAt || (snapshot.lastUpdatedAt && snapshot.lastUpdatedAt > next.lastUpdatedAt)) {
      next.lastUpdatedAt = snapshot.lastUpdatedAt;
    }
    return next;
  }, createEmptyUsageSnapshot());
  aggregate.promptCacheHitRate = calculateCacheHitRate(aggregate);
  return aggregate;
}

function calculateCacheHitRate(snapshot: Pick<AiUsageSnapshot, 'promptCacheHitTokens' | 'promptCacheMissTokens'>): number {
  const total = snapshot.promptCacheHitTokens + snapshot.promptCacheMissTokens;
  return total > 0 ? snapshot.promptCacheHitTokens / total : 0;
}
