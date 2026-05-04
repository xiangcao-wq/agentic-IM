export type AiActorRole = 'human_user' | 'personal_agent';

export interface AiTextPrompt {
  actorRole?: AiActorRole;
  actorId?: string;
  instructions: string;
  input: string;
  maxOutputTokens?: number;
}

export interface AiProvider {
  generateText(prompt: AiTextPrompt): Promise<string>;
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
    };
  }>;
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

export class OpenAiChatCompletionsProvider implements AiProvider {
  private readonly providerName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetcher: typeof fetch;
  private readonly extraHeaders: Record<string, string>;
  private readonly extraBody: Record<string, unknown>;

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

    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        ...this.extraHeaders
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: prompt.instructions },
          { role: 'user', content: prompt.input }
        ],
        max_tokens: prompt.maxOutputTokens ?? 220,
        stream: false,
        ...this.extraBody
      })
    });

    if (!response.ok) {
      throw new Error(`${this.providerName} chat completions failed ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as ChatCompletionsApiBody;
    const text = extractChatCompletionText(body).trim();
    if (!text) {
      throw new Error(`${this.providerName} chat completions returned no text output`);
    }
    return text;
  }
}

export class RoleRoutedAiProvider implements AiProvider {
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
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
  }
  return '';
}
