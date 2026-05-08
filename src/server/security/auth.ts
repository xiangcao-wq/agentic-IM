import type { IncomingHttpHeaders } from 'node:http';

export interface AuthEnvironment {
  NODE_ENV?: string;
  AGENT_IM_API_TOKEN?: string;
  AGENT_IM_PUBLIC_MODE?: string;
  AGENT_IM_ALLOW_NO_AUTH?: string;
  AGENT_IM_ALLOW_QUERY_TOKEN?: string;
  AGENT_IM_ALLOWED_ORIGINS?: string;
}

export interface AuthConfig {
  apiToken?: string;
  requireAuth: boolean;
  allowQueryToken: boolean;
  mode: 'local-demo' | 'local-token' | 'public' | 'production' | 'production-open';
}

export interface CorsConfig {
  allowedOrigins: string[];
  allowOriginlessRequests: boolean;
}

type HeaderValue = string | string[] | undefined;

interface RequestLike {
  method?: string;
  headers: IncomingHttpHeaders | Record<string, HeaderValue>;
}

export const defaultLocalAllowedOrigins = [5175, 5176, 5177, 5178, 5179].flatMap((port) => [
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`
]);

export function resolveAuthConfig(env: AuthEnvironment = process.env): AuthConfig {
  const apiToken = normalizeToken(env.AGENT_IM_API_TOKEN);
  const publicMode = isTrueLike(env.AGENT_IM_PUBLIC_MODE);
  const productionMode = env.NODE_ENV === 'production';
  const productionOpen = productionMode && isTrueLike(env.AGENT_IM_ALLOW_NO_AUTH);
  const requireAuth = Boolean(apiToken) || publicMode || (productionMode && !productionOpen);

  if (requireAuth && !apiToken) {
    throw new Error('AGENT_IM_API_TOKEN is required when auth is required');
  }

  return {
    apiToken,
    requireAuth,
    allowQueryToken: resolveAllowQueryToken(env, publicMode, productionMode),
    mode: resolveAuthMode({ apiToken, publicMode, productionMode, requireAuth })
  };
}

export function resolveCorsConfig(
  env: AuthEnvironment = process.env,
  options?: { allowedOrigins?: string[] }
): CorsConfig {
  const allowedOrigins =
    options?.allowedOrigins === undefined
      ? parseAllowedOrigins(env.AGENT_IM_ALLOWED_ORIGINS)
      : options.allowedOrigins.map((origin) => origin.trim()).filter(Boolean);

  if (isProductMode(env) && allowedOrigins.length === 0) {
    throw new Error('AGENT_IM_ALLOWED_ORIGINS is required in product mode');
  }

  return {
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : [...defaultLocalAllowedOrigins],
    allowOriginlessRequests: true
  };
}

export function isProductMode(env: AuthEnvironment = process.env): boolean {
  return isTrueLike(env.AGENT_IM_PUBLIC_MODE) || env.NODE_ENV === 'production';
}

export function authorizeRequest(request: RequestLike, url: URL, config: AuthConfig): boolean {
  if (!config.requireAuth || request.method === 'OPTIONS') {
    return true;
  }

  const token = extractRequestToken(request, url, config);
  return Boolean(config.apiToken) && token === config.apiToken;
}

export function extractRequestToken(request: RequestLike, url: URL, config: AuthConfig): string | undefined {
  return (
    normalizeToken(getHeaderValue(request.headers['x-agent-im-token'])) ??
    parseBearerToken(getHeaderValue(request.headers.authorization)) ??
    (config.allowQueryToken ? normalizeToken(url.searchParams.get('agent_im_token') ?? undefined) : undefined)
  );
}

export function isCorsOriginAllowed(origin: string | undefined, config: CorsConfig): boolean {
  if (!origin) {
    return config.allowOriginlessRequests;
  }
  return config.allowedOrigins.includes(origin);
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }

  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function resolveAllowQueryToken(
  env: AuthEnvironment,
  publicMode: boolean,
  productionMode: boolean
): boolean {
  if (publicMode || productionMode) {
    return false;
  }

  return env.AGENT_IM_ALLOW_QUERY_TOKEN === undefined || !isFalseLike(env.AGENT_IM_ALLOW_QUERY_TOKEN);
}

function resolveAuthMode(input: {
  apiToken?: string;
  publicMode: boolean;
  productionMode: boolean;
  requireAuth: boolean;
}): AuthConfig['mode'] {
  if (input.publicMode) {
    return 'public';
  }
  if (input.productionMode) {
    return input.requireAuth ? 'production' : 'production-open';
  }
  return input.apiToken ? 'local-token' : 'local-demo';
}

function parseBearerToken(authorization: string | undefined): string | undefined {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return normalizeToken(match?.[1]);
}

function normalizeToken(value: string | string[] | undefined): string | undefined {
  const token = Array.isArray(value) ? value[0] : value;
  const normalized = token?.trim();
  return normalized ? normalized : undefined;
}

function getHeaderValue(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isTrueLike(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function isFalseLike(value: string | undefined): boolean {
  return ['', '0', 'false', 'no', 'off'].includes(value?.trim().toLowerCase() ?? '');
}
