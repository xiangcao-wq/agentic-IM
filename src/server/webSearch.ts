import type { WebSearchResultItem } from '../domain/types';

export interface WebSearchProvider {
  search(query: string, options?: { maxResults?: number }): Promise<WebSearchResultItem[]>;
}

interface DuckDuckGoRelatedTopic {
  Text?: string;
  FirstURL?: string;
  Name?: string;
  Topics?: DuckDuckGoRelatedTopic[];
}

interface DuckDuckGoResponse {
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: DuckDuckGoRelatedTopic[];
}

export function createConfiguredWebSearchProvider(env: NodeJS.ProcessEnv = process.env): WebSearchProvider | undefined {
  if (env.AGENT_IM_WEB_SEARCH_DISABLED === '1') {
    return undefined;
  }
  return createDuckDuckGoSearchProvider();
}

export function createDuckDuckGoSearchProvider(fetcher: typeof fetch = fetch): WebSearchProvider {
  return {
    async search(query, options = {}) {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        return [];
      }
      const maxResults = Math.max(1, Math.min(options.maxResults ?? 5, 8));
      const url = new URL('https://api.duckduckgo.com/');
      url.searchParams.set('q', normalizedQuery);
      url.searchParams.set('format', 'json');
      url.searchParams.set('no_redirect', '1');
      url.searchParams.set('no_html', '1');
      url.searchParams.set('skip_disambig', '1');

      try {
        const response = await fetcher(url, {
          headers: {
            accept: 'application/json'
          }
        });
        if (response.ok) {
          const body = (await response.json()) as DuckDuckGoResponse;
      const instantResults = await enrichOfficialResults(normalizeDuckDuckGoResults(body), fetcher);
      if (instantResults.length > 0) {
        return instantResults.slice(0, maxResults);
      }
        }
      } catch {
        // Continue to the HTML result page. The instant-answer endpoint often returns empty or non-JSON bodies.
      }

      const htmlUrl = new URL('https://duckduckgo.com/html/');
      htmlUrl.searchParams.set('q', normalizedQuery);
      const htmlResponse = await fetcher(htmlUrl, {
        headers: {
          accept: 'text/html'
        }
      });
      if (!htmlResponse.ok) {
        throw new Error(`web search html fallback failed ${htmlResponse.status}: ${await htmlResponse.text()}`);
      }
      return (await enrichOfficialResults(normalizeDuckDuckGoHtmlResults(await htmlResponse.text()), fetcher))
        .slice(0, maxResults);
    }
  };
}

function normalizeDuckDuckGoResults(body: DuckDuckGoResponse): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = [];
  if (body.AbstractText?.trim() && body.AbstractURL?.trim()) {
    results.push({
      title: body.Heading?.trim() || body.AbstractURL,
      url: body.AbstractURL,
      snippet: body.AbstractText.trim(),
      source: 'duckduckgo'
    });
  }

  for (const item of flattenRelatedTopics(body.RelatedTopics ?? [])) {
    if (!item.Text?.trim() || !item.FirstURL?.trim()) {
      continue;
    }
    results.push({
      title: inferTitleFromRelatedTopic(item),
      url: item.FirstURL,
      snippet: item.Text.trim(),
      source: 'duckduckgo'
    });
  }

  const byUrl = new Map<string, WebSearchResultItem>();
  for (const result of results) {
    if (!byUrl.has(result.url)) {
      byUrl.set(result.url, result);
    }
  }
  return [...byUrl.values()];
}

function flattenRelatedTopics(items: DuckDuckGoRelatedTopic[]): DuckDuckGoRelatedTopic[] {
  return items.flatMap((item) => item.Topics?.length ? flattenRelatedTopics(item.Topics) : [item]);
}

function inferTitleFromRelatedTopic(item: DuckDuckGoRelatedTopic): string {
  if (item.Name?.trim()) {
    return item.Name.trim();
  }
  const text = item.Text?.trim() ?? item.FirstURL ?? 'Web result';
  const separatorIndex = text.search(/\s[-–:]\s/);
  return separatorIndex > 0 ? text.slice(0, separatorIndex) : text.slice(0, 80);
}

function normalizeDuckDuckGoHtmlResults(html: string): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = [];
  const pattern =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<(?:a|div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
  for (const match of html.matchAll(pattern)) {
    const url = normalizeDuckDuckGoUrl(decodeHtml(match[1]));
    const title = stripHtml(match[2]);
    const snippet = stripHtml(match[3]);
    if (!url || !title || !snippet) {
      continue;
    }
    results.push({
      title,
      url,
      snippet,
      source: 'duckduckgo'
    });
  }
  return results;
}

function normalizeDuckDuckGoUrl(raw: string): string | undefined {
  const withProtocol = raw.startsWith('//') ? `https:${raw}` : raw;
  try {
    const url = new URL(withProtocol);
    const redirected = url.searchParams.get('uddg');
    return redirected ? decodeURIComponent(redirected) : url.toString();
  } catch {
    return undefined;
  }
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function enrichOfficialResults(
  results: WebSearchResultItem[],
  fetcher: typeof fetch
): Promise<WebSearchResultItem[]> {
  const enriched = await Promise.all(results.map(async (result, index) => {
    if (index >= 3 || !shouldFetchResultSnippet(result.url)) {
      return result;
    }
    try {
      const response = await fetcher(result.url, { headers: { accept: 'text/html,text/plain' } });
      if (!response.ok) {
        return result;
      }
      const text = stripHtml(await response.text()).slice(0, 1600);
      return text.length > result.snippet.length ? { ...result, snippet: text } : result;
    } catch {
      return result;
    }
  }));
  return enriched;
}

function shouldFetchResultSnippet(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'api-docs.deepseek.com' || host === 'platform.deepseek.com';
  } catch {
    return false;
  }
}
