// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDuckDuckGoSearchProvider } from './webSearch';

describe('web search provider', () => {
  it('falls back to DuckDuckGo html results when instant answers are empty', async () => {
    const fetcher = async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.includes('format=json')) {
        return new Response(JSON.stringify({ RelatedTopics: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(`
        <html>
          <body>
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example Docs</a>
            <a class="result__snippet">A useful public result snippet.</a>
          </body>
        </html>
      `, {
        status: 200,
        headers: { 'content-type': 'text/html' }
      });
    };

    const provider = createDuckDuckGoSearchProvider(fetcher as typeof fetch);
    const results = await provider.search('example query');

    expect(results[0]).toMatchObject({
      title: 'Example Docs',
      url: 'https://example.com/docs',
      snippet: 'A useful public result snippet.'
    });
  });

  it('falls back to DuckDuckGo html results when instant answer JSON is invalid', async () => {
    const fetcher = async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.includes('format=json')) {
        return new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(`
        <a class="result__a" href="https://example.com/news">Example News</a>
        <div class="result__snippet">Fallback html snippet.</div>
      `, { status: 200, headers: { 'content-type': 'text/html' } });
    };

    const provider = createDuckDuckGoSearchProvider(fetcher as typeof fetch);
    const results = await provider.search('example news');

    expect(results[0]).toMatchObject({
      title: 'Example News',
      url: 'https://example.com/news',
      snippet: 'Fallback html snippet.'
    });
  });

  it('enriches official DeepSeek result snippets with fetched page text', async () => {
    const fetcher = async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.includes('format=json')) {
        return new Response(JSON.stringify({ RelatedTopics: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (href.includes('duckduckgo.com/html')) {
        return new Response(`
          <a class="result__a" href="https://api-docs.deepseek.com/">DeepSeek API Docs</a>
          <div class="result__snippet">Official API docs.</div>
        `, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response(`
        <main>
          <h1>Your First API Call</h1>
          <table>
            <tr><td>model</td><td>deepseek-v4-flash</td></tr>
            <tr><td>model</td><td>deepseek-v4-pro</td></tr>
          </table>
        </main>
      `, { status: 200, headers: { 'content-type': 'text/html' } });
    };

    const provider = createDuckDuckGoSearchProvider(fetcher as typeof fetch);
    const results = await provider.search('DeepSeek API models');

    expect(results[0].snippet).toContain('deepseek-v4-flash');
    expect(results[0].snippet).toContain('deepseek-v4-pro');
  });
});
