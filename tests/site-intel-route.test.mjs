import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workerSource = await readFile(new URL('../tinyfish-worker.js', import.meta.url), 'utf8');
const workerModule = await import('data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64'));
const worker = workerModule.default;

async function requestWorker(path, options = {}) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = new Map();

  globalThis.caches = {
    default: {
      match: async key => cache.get(key.url)?.clone() || null,
      put: async (key, response) => cache.set(key.url, response.clone())
    }
  };
  let mockError = null;
  globalThis.fetch = options.fetchMock
    ? async (...args) => {
        try { return await options.fetchMock(...args); }
        catch (error) { mockError = error; throw error; }
      }
    : async () => new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

  try {
    const request = new Request('https://civilaegis.test' + path, {
      method: options.method || 'GET',
      headers: { Origin: options.origin || 'https://anggaconni.github.io' }
    });
    const response = await worker.fetch(request, {
      TINYFISH_API_KEY: options.tinyfishKey,
      OPENALEX_API_KEY: options.openAlexKey,
      ALLOWED_ORIGINS: 'https://anggaconni.github.io'
    }, { waitUntil: promise => promise });
    return { response, body: await response.json(), mockError };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
}

test('health endpoint reports the shared Worker routes', async () => {
  const { response, body } = await requestWorker('/health');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.endpoints.includes('/nearby-intel'));
  assert.ok(body.endpoints.includes('/site-intel'));
});

test('site news route forwards a scoped query through TinyFish and normalizes results', async () => {
  let upstreamCalls = 0;
  const { response, body } = await requestWorker('/site-intel?scope=news&site=Borobudur%20Temple&country=Indonesia', {
    tinyfishKey: 'test-tinyfish-key',
    fetchMock: async (input, init) => {
      upstreamCalls += 1;
      const url = new URL(typeof input === 'string' ? input : input.url);
      assert.equal(url.hostname, 'api.search.tinyfish.ai');
      assert.match(url.searchParams.get('query') || '', /Borobudur Temple/);
      assert.equal(init.headers['X-API-Key'], 'test-tinyfish-key');
      return new Response(JSON.stringify({ results: [
        { title: 'Borobudur conservation update', url: 'https://publisher.example/borobudur', snippet: 'Conservation report.', publishedAt: '2026-10-15' },
        { title: 'Unsafe URL', url: 'javascript:alert(1)' }
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  assert.equal(response.status, 200);
  assert.equal(upstreamCalls, 1);
  assert.equal(body.scope, 'news');
  assert.equal(body.provider, 'TinyFish Search');
  assert.equal(body.status, 'ok');
  assert.equal((await Promise.resolve(undefined)), undefined);
  assert.equal(body.count, 1);
  assert.equal(body.items[0].title, 'Borobudur conservation update');
  assert.equal(body.items[0].publishedAt, '2026-10-15T00:00:00.000Z');
  assert.equal(body.items[0].evidenceStatus, 'unverified-source-lead');
});

test('site news route explains a missing TinyFish secret without a transport error', async () => {
  const { response, body } = await requestWorker('/site-intel?scope=news&site=Borobudur');
  assert.equal(response.status, 200);
  assert.equal(body.status, 'not_configured');
  assert.match(body.message, /TINYFISH_API_KEY/);
});

test('site research route normalizes OpenAlex works', async () => {
  const { response, body } = await requestWorker('/site-intel?scope=research&site=Komodo%20National%20Park&country=Indonesia', {
    fetchMock: async input => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      assert.equal(url.hostname, 'api.openalex.org');
      assert.equal(url.pathname, '/works');
      assert.equal(url.searchParams.get('search'), 'Komodo National Park');
      return new Response(JSON.stringify({
        meta: { count: 1 },
        results: [{
          id: 'https://openalex.org/W123',
          doi: 'https://doi.org/10.1234/example',
          title: 'Conservation research at Komodo National Park',
          publication_year: 2025,
          type: 'article',
          authorships: [{ author: { display_name: 'A. Researcher' } }],
          primary_location: { source: { display_name: 'Journal of Heritage' }, landing_page_url: 'https://journal.example/paper' },
          cited_by_count: 12,
          open_access: { is_oa: true, oa_url: 'https://repository.example/paper.pdf' }
        }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  assert.equal(response.status, 200);
  assert.equal(body.scope, 'research');
  assert.equal(body.provider, 'OpenAlex');
  assert.equal(body.status, 'ok');
  assert.equal(body.count, 1);
  assert.equal(body.items[0].year, 2025);
  assert.deepEqual(body.items[0].authors, ['A. Researcher']);
  assert.equal(body.items[0].citedByCount, 12);
  assert.equal(body.items[0].openAccessUrl, 'https://repository.example/paper.pdf');
});

test('site intelligence rejects unexpected browser origins', async () => {
  const { response, body } = await requestWorker('/health', { origin: 'https://example.invalid' });
  assert.equal(response.status, 403);
  assert.equal(body.error, 'Origin not allowed');
});
