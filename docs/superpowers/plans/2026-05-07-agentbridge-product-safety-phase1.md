# AgentBridge Product Safety Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the frozen `v0.1.0-demo` codebase safe enough for a controlled server deployment by enforcing product-mode authentication, removing token-in-URL transport, hardening downloads, tightening CORS, and adding operational readiness.

**Architecture:** Keep the current Node HTTP server and React/Vite client, but move security policy out of `src/server/appServer.ts` into focused server modules. Product mode is fail-closed: a public or production deployment must have an API token, must not accept query-string tokens, must use an explicit CORS allowlist, and must expose a readiness endpoint that reports auth, storage, worker, connector, and provider status without leaking secrets.

**Tech Stack:** TypeScript, Node HTTP, Vitest, React/Vite browser client, existing `npm run test`, `npm run build`, and `npm run readiness:product -- --local-demo` gates.

---

## Scope

This plan implements Phase 1 from `docs/superpowers/specs/2026-05-07-agentbridge-product-architecture-design.md`.

Included:
- Central auth policy for local demo, public mode, and production mode.
- Product-mode fail-closed API token checks.
- Removal of `agent_im_token` from browser-facing URLs.
- Header-authenticated SSE and file downloads.
- Explicit product-mode CORS allowlist.
- Download response hardening.
- Product-mode SVG upload blocking.
- `/api/readiness` endpoint.
- Documentation and release status updates.

Excluded:
- Postgres, Drizzle, object storage, Redis, and worker queue migration.
- Fastify/Hono migration.
- AgentSession v2.
- Full UI redesign.
- Enterprise login, SSO, sessions, or role-based account system.

## File Structure

- Create `src/server/security/auth.ts`
  - Owns product-mode detection, auth config resolution, CORS config resolution, token extraction, and request authorization.
- Create `src/server/security/auth.test.ts`
  - Tests local demo compatibility, public/production fail-closed behavior, query-token policy, and CORS policy.
- Create `src/server/security/downloadPolicy.ts`
  - Owns download headers and product-mode MIME blocking for uploads.
- Create `src/server/security/downloadPolicy.test.ts`
  - Tests attachment headers, content sniffing protection, cache/referrer policy, and SVG blocking in product mode.
- Create `src/server/readiness/productReadiness.ts`
  - Builds the `/api/readiness` JSON payload from runtime inputs.
- Create `src/server/readiness/productReadiness.test.ts`
  - Tests readiness status calculation without starting the HTTP server.
- Modify `src/server/appServer.ts`
  - Replace inline auth/CORS functions with security modules.
  - Add product startup validation.
  - Add `/api/readiness`.
  - Use hardened download headers.
  - Use product-mode upload MIME policy.
- Modify `src/server/appServer.test.ts`
  - Add end-to-end server tests for product auth, query-token rejection, CORS fail-closed, readiness, and downloads.
- Modify `src/client/apiClient.ts`
  - Replace tokenized EventSource and download URLs with header-authenticated fetch helpers.
- Modify `src/client/apiClient.test.ts`
  - Verify no browser API appends `agent_im_token` and that token headers are used.
- Modify `src/App.tsx`
  - Use authenticated download helper instead of direct tokenized links.
  - Use authenticated SSE helper while preserving the current state-update flow.
- Modify `.env.example`
  - Document product-mode security variables.
- Modify `README.md`
  - Document local demo and controlled server deployment modes.
- Modify `docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md`
  - Add Phase 1 status notes after verification.

---

### Task 1: Central Auth And CORS Policy

**Files:**
- Create: `src/server/security/auth.ts`
- Create: `src/server/security/auth.test.ts`
- Modify: `src/server/appServer.ts`

- [ ] **Step 1: Write failing auth policy tests**

Create `src/server/security/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  authorizeRequest,
  extractRequestToken,
  resolveAuthConfig,
  resolveCorsConfig,
  type AuthEnvironment
} from './auth';

function env(overrides: Partial<AuthEnvironment> = {}): AuthEnvironment {
  return {
    NODE_ENV: 'test',
    AGENT_IM_API_TOKEN: undefined,
    AGENT_IM_PUBLIC_MODE: undefined,
    AGENT_IM_ALLOW_NO_AUTH: undefined,
    AGENT_IM_ALLOW_QUERY_TOKEN: undefined,
    AGENT_IM_ALLOWED_ORIGINS: undefined,
    ...overrides
  };
}

function request(headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request('http://127.0.0.1:4173/api/state', { method, headers });
}

describe('auth security policy', () => {
  it('keeps local demo mode open when no token is configured', () => {
    const config = resolveAuthConfig(env());

    expect(config).toMatchObject({
      apiToken: undefined,
      requireAuth: false,
      allowQueryToken: true,
      mode: 'local-demo'
    });
  });

  it('requires a token in public mode', () => {
    expect(() => resolveAuthConfig(env({ AGENT_IM_PUBLIC_MODE: 'true' }))).toThrow(
      'AGENT_IM_API_TOKEN is required when auth is required'
    );
  });

  it('requires a token in production unless explicitly disabled', () => {
    expect(() => resolveAuthConfig(env({ NODE_ENV: 'production' }))).toThrow(
      'AGENT_IM_API_TOKEN is required when auth is required'
    );

    expect(resolveAuthConfig(env({ NODE_ENV: 'production', AGENT_IM_ALLOW_NO_AUTH: 'true' }))).toMatchObject({
      requireAuth: false,
      mode: 'production-open'
    });
  });

  it('rejects query-string tokens in product mode', () => {
    const config = resolveAuthConfig(
      env({
        AGENT_IM_PUBLIC_MODE: 'true',
        AGENT_IM_API_TOKEN: 'local-secret'
      })
    );
    const url = new URL('http://127.0.0.1:4173/api/events?agent_im_token=local-secret');

    expect(config.allowQueryToken).toBe(false);
    expect(extractRequestToken(request(), url, config)).toBeUndefined();
    expect(authorizeRequest(request(), url, config)).toBe(false);
  });

  it('accepts header and bearer tokens when auth is required', () => {
    const config = resolveAuthConfig(
      env({
        AGENT_IM_PUBLIC_MODE: 'true',
        AGENT_IM_API_TOKEN: 'local-secret'
      })
    );

    expect(authorizeRequest(request({ 'x-agent-im-token': 'local-secret' }), new URL('http://x.test/api'), config)).toBe(
      true
    );
    expect(authorizeRequest(request({ authorization: 'Bearer local-secret' }), new URL('http://x.test/api'), config)).toBe(
      true
    );
    expect(authorizeRequest(request({ 'x-agent-im-token': 'wrong' }), new URL('http://x.test/api'), config)).toBe(false);
  });

  it('allows query-string tokens only when local compatibility is enabled', () => {
    const config = resolveAuthConfig(env({ AGENT_IM_API_TOKEN: 'local-secret' }));
    const url = new URL('http://127.0.0.1:4173/api/events?agent_im_token=local-secret');

    expect(config.requireAuth).toBe(true);
    expect(config.allowQueryToken).toBe(true);
    expect(authorizeRequest(request(), url, config)).toBe(true);
  });

  it('requires explicit CORS origins in product mode', () => {
    expect(() =>
      resolveCorsConfig(
        env({
          AGENT_IM_PUBLIC_MODE: 'true',
          AGENT_IM_API_TOKEN: 'local-secret'
        })
      )
    ).toThrow('AGENT_IM_ALLOWED_ORIGINS is required in product mode');

    expect(
      resolveCorsConfig(
        env({
          AGENT_IM_PUBLIC_MODE: 'true',
          AGENT_IM_API_TOKEN: 'local-secret',
          AGENT_IM_ALLOWED_ORIGINS: 'https://agentbridge.example.com, https://ops.example.com'
        })
      )
    ).toMatchObject({
      allowOriginlessRequests: true,
      allowedOrigins: ['https://agentbridge.example.com', 'https://ops.example.com']
    });
  });
});
```

- [ ] **Step 2: Run auth policy tests to verify they fail**

Run:

```bash
npm run test -- src/server/security/auth.test.ts
```

Expected: FAIL because `src/server/security/auth.ts` does not exist.

- [ ] **Step 3: Implement central auth policy**

Create `src/server/security/auth.ts`:

```ts
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

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

export const defaultLocalAllowedOrigins = [
  'http://127.0.0.1:5175',
  'http://localhost:5175',
  'http://127.0.0.1:5176',
  'http://localhost:5176',
  'http://127.0.0.1:5177',
  'http://localhost:5177',
  'http://127.0.0.1:5178',
  'http://localhost:5178',
  'http://127.0.0.1:5179',
  'http://localhost:5179'
];

export function resolveAuthConfig(env: AuthEnvironment = process.env): AuthConfig {
  const apiToken = trimToUndefined(env.AGENT_IM_API_TOKEN);
  const publicMode = parseBoolean(env.AGENT_IM_PUBLIC_MODE);
  const production = env.NODE_ENV === 'production';
  const allowNoAuth = parseBoolean(env.AGENT_IM_ALLOW_NO_AUTH);
  const requireAuth = Boolean(apiToken) || publicMode || (production && !allowNoAuth);

  if (requireAuth && !apiToken) {
    throw new Error('AGENT_IM_API_TOKEN is required when auth is required');
  }

  const allowQueryToken =
    !publicMode &&
    !production &&
    parseBoolean(env.AGENT_IM_ALLOW_QUERY_TOKEN, {
      defaultValue: true
    });

  return {
    apiToken,
    requireAuth,
    allowQueryToken,
    mode: resolveAuthMode({ apiToken, publicMode, production, allowNoAuth })
  };
}

export function resolveCorsConfig(
  env: AuthEnvironment = process.env,
  options: { allowedOrigins?: string[] } = {}
): CorsConfig {
  const productMode = isProductMode(env);
  const configuredOrigins = options.allowedOrigins ?? parseAllowedOrigins(env.AGENT_IM_ALLOWED_ORIGINS);

  if (productMode && configuredOrigins.length === 0) {
    throw new Error('AGENT_IM_ALLOWED_ORIGINS is required in product mode');
  }

  return {
    allowedOrigins: configuredOrigins.length > 0 ? configuredOrigins : defaultLocalAllowedOrigins,
    allowOriginlessRequests: true
  };
}

export function isProductMode(env: AuthEnvironment = process.env): boolean {
  return parseBoolean(env.AGENT_IM_PUBLIC_MODE) || env.NODE_ENV === 'production';
}

export function authorizeRequest(request: Pick<IncomingMessage, 'method' | 'headers'> | Request, url: URL, config: AuthConfig): boolean {
  if (!config.requireAuth || request.method === 'OPTIONS') {
    return true;
  }
  return extractRequestToken(request, url, config) === config.apiToken;
}

export function extractRequestToken(
  request: Pick<IncomingMessage, 'headers'> | Request,
  url: URL,
  config: Pick<AuthConfig, 'allowQueryToken'>
): string | undefined {
  return (
    getRequestHeader(request, 'x-agent-im-token') ??
    parseBearerToken(getRequestHeader(request, 'authorization')) ??
    (config.allowQueryToken ? (url.searchParams.get('agent_im_token') ?? undefined) : undefined)
  );
}

export function isCorsOriginAllowed(origin: string | undefined, config: CorsConfig): boolean {
  if (!origin) {
    return config.allowOriginlessRequests;
  }
  return config.allowedOrigins.includes(origin);
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function resolveAuthMode(input: {
  apiToken?: string;
  publicMode: boolean;
  production: boolean;
  allowNoAuth: boolean;
}): AuthConfig['mode'] {
  if (input.publicMode) {
    return 'public';
  }
  if (input.production && input.allowNoAuth && !input.apiToken) {
    return 'production-open';
  }
  if (input.production) {
    return 'production';
  }
  return input.apiToken ? 'local-token' : 'local-demo';
}

function parseBoolean(raw: string | undefined, options: { defaultValue?: boolean } = {}): boolean {
  if (raw === undefined || raw.trim() === '') {
    return options.defaultValue ?? false;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function trimToUndefined(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function parseBearerToken(authorization: string | undefined): string | undefined {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function getRequestHeader(request: Pick<IncomingMessage, 'headers'> | Request, name: string): string | undefined {
  if (request instanceof Request) {
    return request.headers.get(name) ?? undefined;
  }
  return getHeaderValue(request.headers[name.toLowerCase()]);
}

function getHeaderValue(value: IncomingHttpHeaders[string]): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
```

- [ ] **Step 4: Run auth policy tests to verify they pass**

Run:

```bash
npm run test -- src/server/security/auth.test.ts
```

Expected: PASS.

- [ ] **Step 5: Integrate auth module into `appServer.ts`**

Modify `src/server/appServer.ts`:

1. Add imports near the other local imports:

```ts
import {
  authorizeRequest,
  isCorsOriginAllowed,
  resolveAuthConfig,
  resolveCorsConfig,
  type AuthConfig,
  type CorsConfig
} from './security/auth';
```

2. Replace the current API token and allowed-origin setup:

```ts
  const authConfig = resolveAuthConfig({
    ...process.env,
    AGENT_IM_API_TOKEN:
      options.apiToken === undefined ? process.env.AGENT_IM_API_TOKEN : (options.apiToken ?? undefined)
  });
  const corsConfig = resolveCorsConfig(process.env, {
    allowedOrigins: options.allowedOrigins
  });
```

3. Replace `applyCorsHeaders(request, response, allowedOrigins)` calls with:

```ts
      if (!applyCorsHeaders(request, response, corsConfig)) {
        return sendJson(response, { error: 'origin not allowed' }, 403);
      }
```

4. Replace authorization checks with:

```ts
      if (!authorizeRequest(request, url, authConfig)) {
        return sendJson(response, { error: 'unauthorized' }, 401);
      }
```

5. Replace the local `parseAllowedOrigins`, `authorizeRequest`, and `parseBearerToken` functions with this CORS helper:

```ts
function applyCorsHeaders(request: IncomingMessage, response: ServerResponse, config: CorsConfig): boolean {
  const origin = getHeaderValue(request.headers.origin);
  if (!isCorsOriginAllowed(origin, config)) {
    return false;
  }

  response.setHeader('access-control-allow-origin', origin ?? '*');
  if (origin) {
    response.setHeader('vary', 'origin');
  }
  return true;
}
```

- [ ] **Step 6: Add app server auth integration tests**

Modify `src/server/appServer.test.ts` by replacing the existing test named `requires the configured API token for protected reads and writes` with:

```ts
  it('keeps local token compatibility for query-authenticated SSE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      apiToken: 'local-secret'
    });
    servers.push(app);

    const allowedSse = await fetch(`${app.url}/api/events?agent_im_token=local-secret`);

    expect(allowedSse.ok).toBe(true);
    await allowedSse.body?.cancel();
  });

  it('requires header auth and rejects query tokens in public mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const previousPublicMode = process.env.AGENT_IM_PUBLIC_MODE;
    const previousAllowedOrigins = process.env.AGENT_IM_ALLOWED_ORIGINS;
    process.env.AGENT_IM_PUBLIC_MODE = 'true';
    process.env.AGENT_IM_ALLOWED_ORIGINS = 'https://agentbridge.example.com';
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      apiToken: 'local-secret'
    });
    servers.push(app);

    try {
      const deniedRead = await fetch(`${app.url}/api/state`);
      const deniedQuery = await fetch(`${app.url}/api/events?agent_im_token=local-secret`);
      const allowedRead = await fetch(`${app.url}/api/state`, {
        headers: { 'x-agent-im-token': 'local-secret' }
      });
      const allowedSse = await fetch(`${app.url}/api/events`, {
        headers: { 'x-agent-im-token': 'local-secret' }
      });

      expect(deniedRead.status).toBe(401);
      expect(deniedQuery.status).toBe(401);
      expect(allowedRead.ok).toBe(true);
      expect(allowedSse.ok).toBe(true);
      await allowedSse.body?.cancel();
    } finally {
      if (previousPublicMode === undefined) {
        delete process.env.AGENT_IM_PUBLIC_MODE;
      } else {
        process.env.AGENT_IM_PUBLIC_MODE = previousPublicMode;
      }
      if (previousAllowedOrigins === undefined) {
        delete process.env.AGENT_IM_ALLOWED_ORIGINS;
      } else {
        process.env.AGENT_IM_ALLOWED_ORIGINS = previousAllowedOrigins;
      }
    }
  });
```

Add this test after the new public-mode test:

```ts
  it('fails startup in public mode when no API token is configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const previousPublicMode = process.env.AGENT_IM_PUBLIC_MODE;
    const previousToken = process.env.AGENT_IM_API_TOKEN;
    const previousAllowedOrigins = process.env.AGENT_IM_ALLOWED_ORIGINS;
    process.env.AGENT_IM_PUBLIC_MODE = 'true';
    process.env.AGENT_IM_ALLOWED_ORIGINS = 'https://agentbridge.example.com';
    delete process.env.AGENT_IM_API_TOKEN;

    try {
      await expect(
        createAppServer({
          dbPath,
          port: 0,
          matrixBootstrapPath: null,
          apiToken: null
        })
      ).rejects.toThrow('AGENT_IM_API_TOKEN is required when auth is required');
    } finally {
      if (previousPublicMode === undefined) {
        delete process.env.AGENT_IM_PUBLIC_MODE;
      } else {
        process.env.AGENT_IM_PUBLIC_MODE = previousPublicMode;
      }
      if (previousToken === undefined) {
        delete process.env.AGENT_IM_API_TOKEN;
      } else {
        process.env.AGENT_IM_API_TOKEN = previousToken;
      }
      if (previousAllowedOrigins === undefined) {
        delete process.env.AGENT_IM_ALLOWED_ORIGINS;
      } else {
        process.env.AGENT_IM_ALLOWED_ORIGINS = previousAllowedOrigins;
      }
    }
  });
```

- [ ] **Step 7: Run focused server auth tests**

Run:

```bash
npm run test -- src/server/security/auth.test.ts src/server/appServer.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit auth policy**

Run:

```bash
git add src/server/security/auth.ts src/server/security/auth.test.ts src/server/appServer.ts src/server/appServer.test.ts
git commit -m "feat: enforce product auth policy"
```

Expected: commit succeeds on branch `product-safety-phase1`.

---

### Task 2: Header-Authenticated Client Streams And Downloads

**Files:**
- Modify: `src/client/apiClient.ts`
- Modify: `src/client/apiClient.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/server/appServer.test.ts`

- [ ] **Step 1: Write failing client tests for URL-token removal**

Modify `src/client/apiClient.test.ts`:

1. Replace the import of `fileDownloadUrl` with `downloadFile`.
2. Replace the existing test named `adds the configured API token to browser-only GET URLs` with:

```ts
  it('uses token headers instead of browser URL query tokens', async () => {
    vi.stubEnv('VITE_AGENT_API_TOKEN', 'local-secret');
    vi.resetModules();
    const { createStateEventSource: createStateEventSourceWithToken, downloadFile: downloadFileWithToken } =
      await import('./apiClient');
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      return new Response('file bytes', {
        headers: {
          'content-disposition': 'attachment; filename="report.txt"',
          'content-type': 'text/plain'
        }
      });
    });

    await downloadFileWithToken('/api-root/', 'file uploaded/report', fetchMock);
    const stream = createStateEventSourceWithToken('/api-root/', fetchMock);
    stream.close();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api-root/api/files/file%20uploaded%2Freport/download',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-agent-im-token': 'local-secret'
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api-root/api/events',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-agent-im-token': 'local-secret'
        })
      })
    );
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('agent_im_token');
    expect(String(fetchMock.mock.calls[1][0])).not.toContain('agent_im_token');

    vi.unstubAllEnvs();
  });
```

3. Replace the existing `builds encoded file download URLs` test with:

```ts
  it('downloads files through authenticated fetch', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('file bytes', {
        headers: {
          'content-disposition': 'attachment; filename="report.txt"',
          'content-type': 'text/plain'
        }
      });
    });

    const file = await downloadFile('/api-root/', 'file uploaded/report', fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api-root/api/files/file%20uploaded%2Freport/download',
      expect.objectContaining({ method: 'GET' })
    );
    expect(file).toMatchObject({
      filename: 'report.txt',
      contentType: 'text/plain'
    });
    expect(await file.blob.text()).toBe('file bytes');
  });
```

4. Add this test below the download test:

```ts
  it('parses fetch-based SSE messages and supports close', async () => {
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: ready\ndata: {"ok":true}\n\n'));
        controller.enqueue(encoder.encode('event: state\ndata: {"rooms":[]}\n\n'));
        controller.close();
      }
    });
    const fetchMock = vi.fn(async () => new Response(streamBody));
    const received: Array<{ type: string; data: string }> = [];

    const stream = createStateEventSource('/api-root', fetchMock);
    stream.addEventListener('ready', (event) => received.push({ type: event.type, data: event.data }));
    stream.addEventListener('state', (event) => received.push({ type: event.type, data: event.data }));
    await stream.ready;
    stream.close();

    expect(received).toEqual([
      { type: 'ready', data: '{"ok":true}' },
      { type: 'state', data: '{"rooms":[]}' }
    ]);
  });
```

- [ ] **Step 2: Run client tests to verify they fail**

Run:

```bash
npm run test -- src/client/apiClient.test.ts
```

Expected: FAIL because `downloadFile` does not exist and `createStateEventSource` still uses native `EventSource` with query tokens.

- [ ] **Step 3: Implement authenticated download and SSE helpers**

Modify `src/client/apiClient.ts`:

1. Replace `fileDownloadUrl` with:

```ts
export interface DownloadedFile {
  blob: Blob;
  filename: string;
  contentType: string;
}

export async function downloadFile(
  baseUrl: string,
  fileId: string,
  fetcher: Fetcher = fetch
): Promise<DownloadedFile> {
  const response = await fetcher(endpoint(baseUrl, `/api/files/${encodeURIComponent(fileId)}/download`), {
    method: 'GET',
    headers: withApiToken({})
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const blob = await response.blob();
  return {
    blob,
    filename: parseDownloadFilename(response.headers.get('content-disposition')) ?? `${fileId}.bin`,
    contentType: response.headers.get('content-type') ?? 'application/octet-stream'
  };
}
```

2. Replace `createStateEventSource` with:

```ts
export interface StateStreamMessageEvent {
  type: string;
  data: string;
}

export interface StateEventStream {
  ready: Promise<void>;
  addEventListener(type: string, listener: (event: StateStreamMessageEvent) => void): void;
  removeEventListener(type: string, listener: (event: StateStreamMessageEvent) => void): void;
  close(): void;
}

export function createStateEventSource(baseUrl = '', fetcher: Fetcher = fetch): StateEventStream {
  return createFetchSseStream(endpoint(baseUrl, '/api/events'), fetcher);
}
```

3. Add this implementation above `post()`:

```ts
function createFetchSseStream(url: string, fetcher: Fetcher): StateEventStream {
  const controller = new AbortController();
  const listeners = new Map<string, Set<(event: StateStreamMessageEvent) => void>>();
  let readyResolve: () => void;
  let readyReject: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  void (async () => {
    try {
      const response = await fetcher(url, {
        method: 'GET',
        headers: withApiToken({
          accept: 'text/event-stream'
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      if (!response.body) {
        throw new Error('Event stream response did not include a body');
      }
      await readSseBody(response.body, (event) => {
        dispatchEvent(listeners, event);
        if (event.type === 'ready') {
          readyResolve();
        }
      });
      readyResolve();
    } catch (error) {
      if (!controller.signal.aborted) {
        readyReject(error);
      } else {
        readyResolve();
      }
    }
  })();

  return {
    ready,
    addEventListener(type, listener) {
      const bucket = listeners.get(type) ?? new Set<(event: StateStreamMessageEvent) => void>();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    close() {
      controller.abort();
      listeners.clear();
    }
  };
}

async function readSseBody(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: StateStreamMessageEvent) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseFrame(frame);
        if (event) {
          onEvent(event);
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string): StateStreamMessageEvent | undefined {
  const lines = frame.split(/\r?\n/);
  let type = 'message';
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) {
      type = line.slice('event:'.length).trim();
    }
    if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart());
    }
  }
  if (data.length === 0) {
    return undefined;
  }
  return { type, data: data.join('\n') };
}

function dispatchEvent(
  listeners: Map<string, Set<(event: StateStreamMessageEvent) => void>>,
  event: StateStreamMessageEvent
): void {
  listeners.get(event.type)?.forEach((listener) => listener(event));
}

function parseDownloadFilename(contentDisposition: string | null): string | undefined {
  const utf8Match = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    return decodeURIComponent(utf8Match[1]);
  }
  const quotedMatch = contentDisposition?.match(/filename="([^"]+)"/i);
  return quotedMatch?.[1];
}
```

4. Delete `withApiTokenQuery`.

- [ ] **Step 4: Update `App.tsx` stream usage**

Find the effect that calls `createStateEventSource`. Replace native `EventSource` handler assignment with:

```tsx
    const events = createStateEventSource(apiBaseUrl);
    const handleState = (event: { data: string }) => {
      setState(JSON.parse(event.data));
    };
    events.addEventListener('state', handleState);
    events.ready.catch((error) => {
      console.error('State stream failed', error);
    });
    return () => {
      events.removeEventListener('state', handleState);
      events.close();
    };
```

Use the existing state setter name from the surrounding component. If the current handler already has additional state reconciliation, keep that body and only replace the event source transport.

- [ ] **Step 5: Update `App.tsx` download usage**

Find direct usage of `fileDownloadUrl`. Replace click handlers or anchor URLs with:

```tsx
  const handleDownloadFile = async (fileId: string) => {
    const downloaded = await downloadFile(apiBaseUrl, fileId);
    const objectUrl = URL.createObjectURL(downloaded.blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = downloaded.filename;
    link.rel = 'noreferrer';
    link.click();
    URL.revokeObjectURL(objectUrl);
  };
```

Wire existing download buttons to call `handleDownloadFile(file.id)`. Keep existing visible labels and layout unchanged.

- [ ] **Step 6: Run client tests**

Run:

```bash
npm run test -- src/client/apiClient.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run server auth regression test**

Run:

```bash
npm run test -- src/server/appServer.test.ts
```

Expected: PASS, including the product-mode SSE header-auth test from Task 1.

- [ ] **Step 8: Commit client token transport**

Run:

```bash
git add src/client/apiClient.ts src/client/apiClient.test.ts src/App.tsx src/server/appServer.test.ts
git commit -m "feat: remove browser URL token transport"
```

Expected: commit succeeds.

---

### Task 3: Download And Upload Hardening

**Files:**
- Create: `src/server/security/downloadPolicy.ts`
- Create: `src/server/security/downloadPolicy.test.ts`
- Modify: `src/server/appServer.ts`
- Modify: `src/server/appServer.test.ts`

- [ ] **Step 1: Write failing download policy tests**

Create `src/server/security/downloadPolicy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  assertUploadContentTypeAllowed,
  createDownloadHeaders,
  sanitizeAttachmentFilename
} from './downloadPolicy';

describe('download policy', () => {
  it('creates hardened attachment headers', () => {
    expect(
      createDownloadHeaders({
        filename: 'team notes.txt',
        contentType: 'text/plain',
        byteLength: 12
      })
    ).toMatchObject({
      'cache-control': 'private, no-store',
      'content-disposition': `attachment; filename="team notes.txt"; filename*=UTF-8''team%20notes.txt`,
      'content-length': '12',
      'content-type': 'text/plain',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    });
  });

  it('sanitizes unsafe attachment filenames', () => {
    expect(sanitizeAttachmentFilename('../secret\r\nx.txt')).toBe('secret__x.txt');
    expect(sanitizeAttachmentFilename('')).toBe('download');
  });

  it('blocks SVG uploads in product mode', () => {
    expect(() =>
      assertUploadContentTypeAllowed({
        contentType: 'image/svg+xml',
        productMode: true
      })
    ).toThrow('SVG uploads are disabled in product mode');
  });

  it('keeps SVG uploads available in local demo mode', () => {
    expect(() =>
      assertUploadContentTypeAllowed({
        contentType: 'image/svg+xml',
        productMode: false
      })
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run download policy tests to verify they fail**

Run:

```bash
npm run test -- src/server/security/downloadPolicy.test.ts
```

Expected: FAIL because `downloadPolicy.ts` does not exist.

- [ ] **Step 3: Implement download policy**

Create `src/server/security/downloadPolicy.ts`:

```ts
export interface DownloadHeaderInput {
  filename: string;
  contentType: string;
  byteLength: number;
}

export function createDownloadHeaders(input: DownloadHeaderInput): Record<string, string> {
  const filename = sanitizeAttachmentFilename(input.filename);
  return {
    'cache-control': 'private, no-store',
    'content-disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'content-length': String(input.byteLength),
    'content-type': input.contentType || 'application/octet-stream',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  };
}

export function sanitizeAttachmentFilename(filename: string): string {
  const baseName = filename.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  const cleaned = baseName.replace(/[\r\n"]/g, '_');
  return cleaned || 'download';
}

export function assertUploadContentTypeAllowed(input: { contentType: string; productMode: boolean }): void {
  if (input.productMode && input.contentType.toLowerCase() === 'image/svg+xml') {
    throw new Error('SVG uploads are disabled in product mode');
  }
}
```

- [ ] **Step 4: Integrate hardened download headers**

Modify `src/server/appServer.ts`:

1. Add imports:

```ts
import { assertUploadContentTypeAllowed, createDownloadHeaders } from './security/downloadPolicy';
```

2. Replace the current `sendBytes` header block with:

```ts
function sendBytes(
  response: ServerResponse,
  bytes: Uint8Array,
  options: {
    contentType: string;
    filename: string;
  }
): void {
  response.writeHead(
    200,
    createDownloadHeaders({
      filename: options.filename,
      contentType: options.contentType,
      byteLength: bytes.byteLength
    })
  );
  response.end(bytes);
}
```

3. In `validateFileUpload`, after the existing allowed type check and before extension checks, call:

```ts
  try {
    assertUploadContentTypeAllowed({
      contentType: input.contentType,
      productMode: input.productMode
    });
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'unsupported file type');
  }
```

If `validateFileUpload` remains outside `createAppServer`, pass `productMode` into the function:

```ts
function validateFileUpload(
  state: DemoState,
  input: {
    roomId: string;
    senderId: string;
    filename: string;
    bytes: Uint8Array;
    contentType: string;
    maxUploadBytes: number;
    productMode: boolean;
  }
): void {
```

Then update the upload route call site:

```ts
        validateFileUpload(state, {
          roomId,
          senderId,
          filename,
          bytes,
          contentType,
          maxUploadBytes,
          productMode: authConfig.mode === 'public' || authConfig.mode === 'production'
        });
```

- [ ] **Step 5: Add server download hardening tests**

Modify the existing file download tests in `src/server/appServer.test.ts` so the local media download assertion includes:

```ts
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('referrer-policy')).toBe('no-referrer');
    expect(download.headers.get('cache-control')).toBe('private, no-store');
```

Add this product-mode SVG upload test near the upload tests:

```ts
  it('rejects SVG uploads in public mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const previousPublicMode = process.env.AGENT_IM_PUBLIC_MODE;
    const previousAllowedOrigins = process.env.AGENT_IM_ALLOWED_ORIGINS;
    process.env.AGENT_IM_PUBLIC_MODE = 'true';
    process.env.AGENT_IM_ALLOWED_ORIGINS = 'https://agentbridge.example.com';
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      apiToken: 'local-secret'
    });
    servers.push(app);

    try {
      const response = await fetch(
        `${app.url}/api/files/upload?roomId=room-team&senderId=user-lin&agentCanShare=true`,
        {
          method: 'POST',
          headers: {
            'content-type': 'image/svg+xml',
            'x-agent-im-token': 'local-secret',
            'x-file-name': encodeURIComponent('diagram.svg')
          },
          body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
        }
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'SVG uploads are disabled in product mode' });
    } finally {
      if (previousPublicMode === undefined) {
        delete process.env.AGENT_IM_PUBLIC_MODE;
      } else {
        process.env.AGENT_IM_PUBLIC_MODE = previousPublicMode;
      }
      if (previousAllowedOrigins === undefined) {
        delete process.env.AGENT_IM_ALLOWED_ORIGINS;
      } else {
        process.env.AGENT_IM_ALLOWED_ORIGINS = previousAllowedOrigins;
      }
    }
  });
```

- [ ] **Step 6: Run download and server tests**

Run:

```bash
npm run test -- src/server/security/downloadPolicy.test.ts src/server/appServer.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit download hardening**

Run:

```bash
git add src/server/security/downloadPolicy.ts src/server/security/downloadPolicy.test.ts src/server/appServer.ts src/server/appServer.test.ts
git commit -m "feat: harden file download policy"
```

Expected: commit succeeds.

---

### Task 4: Product Readiness Endpoint

**Files:**
- Create: `src/server/readiness/productReadiness.ts`
- Create: `src/server/readiness/productReadiness.test.ts`
- Modify: `src/server/appServer.ts`
- Modify: `src/server/appServer.test.ts`

- [ ] **Step 1: Write failing readiness tests**

Create `src/server/readiness/productReadiness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildProductReadiness } from './productReadiness';

describe('product readiness', () => {
  it('reports ready when required product checks pass', () => {
    expect(
      buildProductReadiness({
        auth: {
          mode: 'public',
          requireAuth: true,
          allowQueryToken: false,
          tokenConfigured: true,
          allowedOrigins: ['https://agentbridge.example.com']
        },
        storage: { mode: 'json-local', writable: true },
        worker: { autopilotEnabled: true, running: false, lastError: undefined },
        connector: { matrixEnabled: false, bootstrapMode: 'local' },
        provider: { configured: true, health: 'ok', provider: 'deepseek', lastError: undefined }
      })
    ).toMatchObject({
      ok: true,
      checks: {
        auth: { ok: true },
        storage: { ok: true },
        worker: { ok: true },
        connector: { ok: true },
        provider: { ok: true }
      }
    });
  });

  it('marks readiness as blocked when auth is open in public mode', () => {
    expect(
      buildProductReadiness({
        auth: {
          mode: 'public',
          requireAuth: false,
          allowQueryToken: true,
          tokenConfigured: false,
          allowedOrigins: []
        },
        storage: { mode: 'json-local', writable: true },
        worker: { autopilotEnabled: false, running: false, lastError: undefined },
        connector: { matrixEnabled: false, bootstrapMode: 'local' },
        provider: { configured: false, health: 'disabled', provider: 'local', lastError: undefined }
      })
    ).toMatchObject({
      ok: false,
      checks: {
        auth: {
          ok: false,
          status: 'blocked'
        }
      }
    });
  });
});
```

- [ ] **Step 2: Run readiness tests to verify they fail**

Run:

```bash
npm run test -- src/server/readiness/productReadiness.test.ts
```

Expected: FAIL because `productReadiness.ts` does not exist.

- [ ] **Step 3: Implement readiness builder**

Create `src/server/readiness/productReadiness.ts`:

```ts
import type { AuthConfig } from '../security/auth';

export interface ReadinessCheck {
  ok: boolean;
  status: 'ready' | 'degraded' | 'blocked' | 'disabled';
  message: string;
}

export interface ProductReadiness {
  ok: boolean;
  checkedAt: string;
  checks: {
    auth: ReadinessCheck & {
      mode: AuthConfig['mode'];
      requireAuth: boolean;
      allowQueryToken: boolean;
      tokenConfigured: boolean;
      allowedOrigins: string[];
    };
    storage: ReadinessCheck & { mode: string };
    worker: ReadinessCheck & { autopilotEnabled: boolean; running: boolean };
    connector: ReadinessCheck & { matrixEnabled: boolean; bootstrapMode: string };
    provider: ReadinessCheck & { configured: boolean; provider: string; health: string };
  };
}

export interface ProductReadinessInput {
  auth: {
    mode: AuthConfig['mode'];
    requireAuth: boolean;
    allowQueryToken: boolean;
    tokenConfigured: boolean;
    allowedOrigins: string[];
  };
  storage: {
    mode: string;
    writable: boolean;
  };
  worker: {
    autopilotEnabled: boolean;
    running: boolean;
    lastError?: string;
  };
  connector: {
    matrixEnabled: boolean;
    bootstrapMode: string;
  };
  provider: {
    configured: boolean;
    health: string;
    provider: string;
    lastError?: string;
  };
  checkedAt?: string;
}

export function buildProductReadiness(input: ProductReadinessInput): ProductReadiness {
  const authCheck = buildAuthCheck(input.auth);
  const storageCheck = input.storage.writable
    ? ready('storage can read and write demo state')
    : blocked('storage is not writable');
  const workerCheck = input.worker.lastError
    ? degraded(`worker last error: ${input.worker.lastError}`)
    : ready(input.worker.autopilotEnabled ? 'autopilot worker configured' : 'autopilot worker disabled');
  const connectorCheck = input.connector.matrixEnabled
    ? ready('Matrix connector enabled')
    : ready('Matrix connector disabled; local mode active');
  const providerCheck =
    input.provider.configured && input.provider.health !== 'failed'
      ? ready(`AI provider ${input.provider.provider} is ${input.provider.health}`)
      : input.provider.configured
        ? degraded(`AI provider ${input.provider.provider} is ${input.provider.health}`)
        : degraded('AI provider is not configured');

  const checks = {
    auth: { ...authCheck, ...input.auth },
    storage: { ...storageCheck, mode: input.storage.mode },
    worker: {
      ...workerCheck,
      autopilotEnabled: input.worker.autopilotEnabled,
      running: input.worker.running
    },
    connector: {
      ...connectorCheck,
      matrixEnabled: input.connector.matrixEnabled,
      bootstrapMode: input.connector.bootstrapMode
    },
    provider: {
      ...providerCheck,
      configured: input.provider.configured,
      provider: input.provider.provider,
      health: input.provider.health
    }
  };

  return {
    ok: Object.values(checks).every((check) => check.ok),
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    checks
  };
}

function buildAuthCheck(input: ProductReadinessInput['auth']): ReadinessCheck {
  if ((input.mode === 'public' || input.mode === 'production') && (!input.requireAuth || !input.tokenConfigured)) {
    return blocked('product mode requires AGENT_IM_API_TOKEN');
  }
  if ((input.mode === 'public' || input.mode === 'production') && input.allowQueryToken) {
    return blocked('product mode must not allow query-string API tokens');
  }
  if ((input.mode === 'public' || input.mode === 'production') && input.allowedOrigins.length === 0) {
    return blocked('product mode requires AGENT_IM_ALLOWED_ORIGINS');
  }
  return ready('auth policy is configured');
}

function ready(message: string): ReadinessCheck {
  return { ok: true, status: 'ready', message };
}

function degraded(message: string): ReadinessCheck {
  return { ok: false, status: 'degraded', message };
}

function blocked(message: string): ReadinessCheck {
  return { ok: false, status: 'blocked', message };
}
```

- [ ] **Step 4: Add `/api/readiness` to app server**

Modify `src/server/appServer.ts`:

1. Add import:

```ts
import { buildProductReadiness } from './readiness/productReadiness';
```

2. Add route after auth succeeds and before `/api/state`:

```ts
      if (request.method === 'GET' && url.pathname === '/api/readiness') {
        return sendJson(
          response,
          buildProductReadiness({
            auth: {
              mode: authConfig.mode,
              requireAuth: authConfig.requireAuth,
              allowQueryToken: authConfig.allowQueryToken,
              tokenConfigured: Boolean(authConfig.apiToken),
              allowedOrigins: corsConfig.allowedOrigins
            },
            storage: {
              mode: 'json-local',
              writable: true
            },
            worker: {
              autopilotEnabled: autopilotWorkerStatus.enabled,
              running: autopilotWorkerStatus.running,
              lastError: autopilotWorkerStatus.lastError
            },
            connector: {
              matrixEnabled: Boolean(matrixStore),
              bootstrapMode: matrixStore ? 'matrix' : 'local'
            },
            provider: createAiRuntimeStatus(aiProvider, aiStatusProbe)
          })
        );
      }
```

- [ ] **Step 5: Add app server readiness test**

Add this test to `src/server/appServer.test.ts` near the auth tests:

```ts
  it('returns product readiness without exposing the API token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-im-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'db.json');
    const previousPublicMode = process.env.AGENT_IM_PUBLIC_MODE;
    const previousAllowedOrigins = process.env.AGENT_IM_ALLOWED_ORIGINS;
    process.env.AGENT_IM_PUBLIC_MODE = 'true';
    process.env.AGENT_IM_ALLOWED_ORIGINS = 'https://agentbridge.example.com';
    const app = await createAppServer({
      dbPath,
      port: 0,
      matrixBootstrapPath: null,
      apiToken: 'local-secret'
    });
    servers.push(app);

    try {
      const response = await fetch(`${app.url}/api/readiness`, {
        headers: { 'x-agent-im-token': 'local-secret' }
      });
      const body = await response.json();

      expect(response.ok).toBe(true);
      expect(body.checks.auth).toMatchObject({
        mode: 'public',
        requireAuth: true,
        allowQueryToken: false,
        tokenConfigured: true,
        allowedOrigins: ['https://agentbridge.example.com']
      });
      expect(JSON.stringify(body)).not.toContain('local-secret');
    } finally {
      if (previousPublicMode === undefined) {
        delete process.env.AGENT_IM_PUBLIC_MODE;
      } else {
        process.env.AGENT_IM_PUBLIC_MODE = previousPublicMode;
      }
      if (previousAllowedOrigins === undefined) {
        delete process.env.AGENT_IM_ALLOWED_ORIGINS;
      } else {
        process.env.AGENT_IM_ALLOWED_ORIGINS = previousAllowedOrigins;
      }
    }
  });
```

- [ ] **Step 6: Run readiness tests**

Run:

```bash
npm run test -- src/server/readiness/productReadiness.test.ts src/server/appServer.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit readiness endpoint**

Run:

```bash
git add src/server/readiness/productReadiness.ts src/server/readiness/productReadiness.test.ts src/server/appServer.ts src/server/appServer.test.ts
git commit -m "feat: add product readiness endpoint"
```

Expected: commit succeeds.

---

### Task 5: Documentation And Product Gate

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `scripts/product-readiness.mjs`
- Modify: `docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md`

- [ ] **Step 1: Document product security variables**

Modify `.env.example` to include:

```bash
# Product safety mode.
# Local demo mode can run without a token.
# Controlled server/public mode must set AGENT_IM_PUBLIC_MODE=true and AGENT_IM_API_TOKEN.
AGENT_IM_PUBLIC_MODE=false
AGENT_IM_API_TOKEN=
AGENT_IM_ALLOWED_ORIGINS=http://127.0.0.1:5175,http://localhost:5175

# Emergency local override only. Do not set to true for controlled server deployments.
AGENT_IM_ALLOW_NO_AUTH=false

# Local compatibility only. Product/public/production mode ignores query tokens.
AGENT_IM_ALLOW_QUERY_TOKEN=true

# Browser client token used for local demos or controlled single-user deployments.
VITE_AGENT_API_TOKEN=
```

- [ ] **Step 2: Document deployment modes in README**

Add this section to `README.md`:

```md
## Deployment Modes

### Local Demo

Local demo mode is for development and internal demos on `127.0.0.1`.

```bash
AGENT_IM_PUBLIC_MODE=false
AGENT_IM_API_TOKEN=
VITE_AGENT_API_TOKEN=
npm run demo:prepare
npm run dev:full
```

Local demo mode allows no-token requests and keeps query-token compatibility for older local tooling.

### Controlled Server Pilot

Controlled server pilot mode is the minimum safe mode for deploying behind HTTPS on a private server.

```bash
AGENT_IM_PUBLIC_MODE=true
AGENT_IM_API_TOKEN=<server-token>
AGENT_IM_ALLOWED_ORIGINS=https://your-agentbridge-host.example.com
VITE_AGENT_API_TOKEN=<server-token>
npm run build
npm run api
```

In controlled server mode:

- `AGENT_IM_API_TOKEN` is required.
- Browser requests send the token in `x-agent-im-token`.
- `agent_im_token` query parameters are rejected.
- CORS allows only `AGENT_IM_ALLOWED_ORIGINS`.
- File downloads are served as attachments with `nosniff` and no-store cache headers.
- SVG uploads are rejected.

Check readiness:

```bash
curl -H "x-agent-im-token: <server-token>" https://your-agentbridge-host.example.com/api/readiness
```
```

- [ ] **Step 3: Add readiness endpoint check to product readiness script**

Modify `scripts/product-readiness.mjs` so the local demo gate checks `/api/readiness` after the API server starts. Add a helper:

```js
async function checkReadinessEndpoint(baseUrl, token) {
  const response = await fetch(`${baseUrl}/api/readiness`, {
    headers: token ? { 'x-agent-im-token': token } : {}
  });
  if (!response.ok) {
    throw new Error(`/api/readiness failed with ${response.status}`);
  }
  const body = await response.json();
  if (!body.checks?.auth || !body.checks?.storage || !body.checks?.worker || !body.checks?.connector || !body.checks?.provider) {
    throw new Error('/api/readiness response is missing required checks');
  }
  return body;
}
```

Call it in the same section that runs browser smoke, using the API URL and token already passed to the local test environment.

- [ ] **Step 4: Update release status with Phase 1 work item**

Append this section to `docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md`:

```md
## Phase 1 Product Safety Branch

Branch: `product-safety-phase1`

Target:

- Product/public mode requires `AGENT_IM_API_TOKEN`.
- Product/public mode rejects `agent_im_token` query parameters.
- Browser client uses `x-agent-im-token` for SSE and downloads.
- CORS requires explicit `AGENT_IM_ALLOWED_ORIGINS` in product/public mode.
- Downloads use attachment, `nosniff`, no-referrer, and no-store headers.
- Product/public mode rejects SVG uploads.
- `/api/readiness` reports auth, storage, worker, connector, and provider checks without exposing secrets.
```

- [ ] **Step 5: Run documentation-sensitive tests**

Run:

```bash
npm run test -- src/server/security/auth.test.ts src/server/security/downloadPolicy.test.ts src/server/readiness/productReadiness.test.ts src/client/apiClient.test.ts src/server/appServer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit documentation and readiness gate**

Run:

```bash
git add .env.example README.md scripts/product-readiness.mjs docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md
git commit -m "docs: document product safety deployment"
```

Expected: commit succeeds.

---

### Task 6: Final Verification And Release Candidate Notes

**Files:**
- Modify: `docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md`

- [ ] **Step 1: Run the full unit test suite**

Run:

```bash
npm run test
```

Expected: PASS with all Vitest files passing.

- [ ] **Step 2: Run the production build**

Run:

```bash
npm run build
```

Expected: PASS with TypeScript and Vite build completing.

- [ ] **Step 3: Run the local product readiness gate**

Run:

```bash
npm run readiness:product -- --local-demo
```

Expected: PASS. The script should include `/api/readiness` in its output or logs and should not require a real Matrix homeserver in `--local-demo` mode.

- [ ] **Step 4: Run a product-mode auth smoke manually**

Start the API in product mode:

```bash
$env:AGENT_IM_PUBLIC_MODE='true'
$env:AGENT_IM_API_TOKEN='local-secret'
$env:AGENT_IM_ALLOWED_ORIGINS='http://127.0.0.1:5175'
$env:MATRIX_BOOTSTRAP_PATH='local'
npm run api
```

From another shell, verify unauthorized and authorized readiness:

```bash
curl -i http://127.0.0.1:4173/api/readiness
curl -i -H "x-agent-im-token: local-secret" http://127.0.0.1:4173/api/readiness
```

Expected:
- First request returns `401`.
- Second request returns `200`.
- Response JSON contains `checks.auth.allowQueryToken: false`.
- Response JSON does not contain `local-secret`.

- [ ] **Step 5: Update release status with verification results**

Append this section to `docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md`:

```md
## Phase 1 Verification

Date: 2026-05-07
Branch: `product-safety-phase1`

Checks:

- `npm run test`: PASS
- `npm run build`: PASS
- `npm run readiness:product -- --local-demo`: PASS
- Product-mode auth smoke: PASS

Security boundary:

- Product/public startup fails without `AGENT_IM_API_TOKEN`.
- Product/public requests reject `agent_im_token` query parameters.
- Browser SSE and downloads use `x-agent-im-token`.
- Product/public CORS requires explicit allowed origins.
- File downloads are attachments with hardened headers.
- Product/public SVG uploads are rejected.
- `/api/readiness` reports status without exposing token values.
```

- [ ] **Step 6: Commit final status**

Run:

```bash
git add docs/superpowers/status/2026-05-07-agentbridge-v0.1.0-demo-readiness.md
git commit -m "docs: record product safety verification"
```

Expected: commit succeeds.

- [ ] **Step 7: Inspect final branch history**

Run:

```bash
git log --oneline --decorate -6
```

Expected: The top commits are the Phase 1 commits on `product-safety-phase1`, with `v0.1.0-demo` remaining behind them as the rollback baseline.

---

## Security Review Checklist

- [ ] No API token is hardcoded in source, docs, tests, or status files.
- [ ] Product/public mode requires `AGENT_IM_API_TOKEN`.
- [ ] Product/public mode rejects query-string auth.
- [ ] Browser client no longer constructs URLs containing `agent_im_token`.
- [ ] Readiness response reports `tokenConfigured: true` but never token values.
- [ ] Product/public CORS requires an explicit allowlist.
- [ ] File downloads use `Content-Disposition: attachment`.
- [ ] File downloads set `X-Content-Type-Options: nosniff`.
- [ ] File downloads set `Cache-Control: private, no-store`.
- [ ] File downloads set `Referrer-Policy: no-referrer`.
- [ ] Product/public mode rejects SVG uploads.
- [ ] Local demo mode still works without a token.
- [ ] `npm run readiness:product -- --local-demo` still passes after the safety changes.

## Execution Notes

- Use branch `product-safety-phase1`.
- Keep `v0.1.0-demo` untouched as the rollback baseline.
- Commit after each task.
- Do not start Postgres, AgentSession v2, or UI restructuring in this branch.
- If a command involving Vite, esbuild, Playwright, or child processes fails with `EPERM`, rerun the same command with sandbox escalation because this project has already hit Windows child-process sandbox restrictions.
