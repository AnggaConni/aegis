import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workerSource = await readFile(new URL('../tinyfish-worker.js', import.meta.url), 'utf8');
const workerModule = await import('data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64'));
const worker = workerModule.default;

async function runWorker(rowsByPass) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let searchIndex = 0;

  globalThis.caches = {
    default: {
      match: async () => null,
      put: async () => undefined
    }
  };

  globalThis.fetch = async (input) => {
    const requestUrl = new URL(typeof input === 'string' ? input : input.url);

    if (requestUrl.hostname === 'nominatim.openstreetmap.org') {
      return new Response(JSON.stringify({
        address: { city: 'Jakarta', state: 'DKI Jakarta', country: 'Indonesia' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (requestUrl.hostname === 'api.search.tinyfish.ai') {
      const rows = rowsByPass[searchIndex] || [];
      searchIndex += 1;
      return new Response(JSON.stringify({ results: rows }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    throw new Error('Unexpected fetch in test: ' + requestUrl.href);
  };

  try {
    const request = new Request('https://civilaegis.test/nearby-intel?lat=-6.2&lng=106.8', {
      method: 'GET',
      headers: { Origin: 'https://anggaconni.github.io' }
    });
    const response = await worker.fetch(
      request,
      { TINYFISH_API_KEY: 'test-key', ALLOWED_ORIGINS: 'https://anggaconni.github.io' },
      { waitUntil: () => undefined }
    );
    assert.equal(response.status, 200);
    return response.json();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
}

test('a known out-of-window date removes an earlier undated duplicate', async () => {
  const url = 'https://www.facebook.com/cnn/videos/jakarta-at-least-4-people-dead-after-blasts/10154379872021509/';
  const body = await runWorker([
    [{
      title: 'Jakarta: At least 4 people dead after blasts',
      snippet: 'Police confirm deaths after explosions in #Jakarta, Indonesia.',
      url
    }],
    [{
      title: '2016 Jakarta blasts',
      snippet: 'A historical report describes the Jakarta explosions in 2016.',
      url
    }],
    [{
      title: 'Jakarta: At least 4 people dead after blasts',
      snippet: 'Police confirm deaths after explosions in #Jakarta, Indonesia.',
      url
    }]
  ]);

  assert.equal(body.filterVersion, 5);
  assert.equal(body.buildVersion, 'timeline-v5-dated-dedupe');
  assert.equal(body.results.length, 0, 'dated historical evidence should remove the undated duplicate');
  assert.equal(body.undatedResults.length, 0);
  assert.ok(body.diagnostics.rejectedOutsideFiveYearWindowCount >= 1);
  assert.ok(body.diagnostics.duplicateCount >= 1);
});

test('deduplication keeps the best dated copy and result buckets remain disjoint', async () => {
  const url = 'https://example.com/jakarta-theft-report?utm_source=search';
  const eventDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const body = await runWorker([
    [{
      title: 'Jakarta theft incident reported',
      snippet: 'Police reported a theft incident in Jakarta, Indonesia.',
      url
    }],
    [{
      title: 'Jakarta theft incident reported',
      snippet: 'Police reported a theft incident in Jakarta, Indonesia. Event date: ' + eventDate,
      url: 'https://example.com/jakarta-theft-report'
        .replace('/jakarta-theft-report', '/jakarta-theft-report')
        + '?utm_medium=search',
      eventDate,
      publishedAt: eventDate
    }],
    [{
      title: 'Jakarta theft incident reported',
      snippet: 'Police reported a theft incident in Jakarta, Indonesia.',
      url: 'https://example.com/jakarta-theft-report'
    }]
  ]);

  assert.equal(body.results.length, 1);
  assert.equal(body.recentResults.length, 1);
  assert.equal(body.mediumTermResults.length, 0);
  assert.equal(body.longTermResults.length, 0);
  assert.equal(body.undatedResults.length, 0);
  assert.equal(body.results[0].eventDate, eventDate + 'T00:00:00.000Z');
  assert.equal(body.results[0].currentIncidentConfirmed, false);
  assert.equal(body.results[0].alertEligibility, 'recent-dated-event-lead-unverified');
  assert.equal(body.results[0].searchWindowMeaning, 'search-pass-only-not-publication-or-event-date');
  assert.equal(
    body.results.length,
    body.recentResults.length + body.mediumTermResults.length + body.longTermResults.length + body.undatedResults.length
  );
});

test('year-only incident dates are treated as approximate and old years are rejected', async () => {
  const body = await runWorker([
    [{
      title: '2016 Jakarta blasts',
      snippet: 'A report about the 2016 Jakarta blasts in Indonesia.',
      url: 'https://example.com/archive/jakarta-blasts'
    }],
    [],
    []
  ]);

  assert.equal(body.results.length, 0);
  assert.ok(body.diagnostics.rejectedOutsideFiveYearWindowCount >= 1);
});
