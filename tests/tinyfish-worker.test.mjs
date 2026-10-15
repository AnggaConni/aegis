import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workerSource = await readFile(new URL('../tinyfish-worker.js', import.meta.url), 'utf8');
const workerModule = await import('data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64'));
const worker = workerModule.default;

async function runWorker(rowsByPass, sourcePages = {}, options = {}) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let searchIndex = 0;

  globalThis.caches = {
    default: {
      match: async () => null,
      put: async () => undefined
    }
  };

  globalThis.fetch = async (input, init = {}) => {
    const requestUrl = new URL(typeof input === 'string' ? input : input.url);

    if (requestUrl.hostname === 'nominatim.openstreetmap.org') {
      return new Response(JSON.stringify({
        address: options.address || { city: 'Jakarta', state: 'DKI Jakarta', country: 'Indonesia' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (requestUrl.hostname === 'api.search.tinyfish.ai') {
      if (Array.isArray(options.searchQueries)) options.searchQueries.push(requestUrl.searchParams.get('query') || '');
      const thisIndex = searchIndex;
      searchIndex += 1;
      const failure = Array.isArray(options.searchFailures) ? options.searchFailures[thisIndex] : null;
      if (failure && failure.type === 'timeout') {
        const timeoutError = new Error('The operation timed out');
        timeoutError.name = 'TimeoutError';
        throw timeoutError;
      }
      if (failure && failure.type === 'network') {
        throw new TypeError('fetch failed');
      }
      if (failure && failure.status) {
        return new Response(JSON.stringify({ error: failure.message || 'Mock upstream error' }), {
          status: failure.status,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const rows = rowsByPass[thisIndex] || [];
      return new Response(JSON.stringify({ results: rows }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const page = sourcePages[requestUrl.href] || sourcePages[requestUrl.origin + requestUrl.pathname];
    if (page !== undefined) {
      if (typeof page === 'string') {
        return new Response(page, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
      return new Response(page.body || '', {
        status: page.status || 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...(page.headers || {}) }
      });
    }

    return new Response('Not found in test fixture', { status: 404 });
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
    assert.equal(response.status, options.expectedStatus || 200);
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

  assert.equal(body.filterVersion, 11);
  assert.equal(body.buildVersion, 'global-drr-v1.1-search-reliability');
  assert.equal(body.results.length, 0, 'dated historical evidence should remove the undated duplicate');
  assert.equal(body.undatedResults.length, 0);
  assert.ok(body.diagnostics.rejectedOutsideFiveYearWindowCount >= 1);
  assert.ok(body.diagnostics.duplicateCount >= 1);
});

test('original article metadata filters the January 2016 Jakarta blast lead', async () => {
  const cnnLink = 'http://cnn.it/1UQuTRZ';
  const facebookUrl = 'https://www.facebook.com/archive/jakarta-blasts-post';
  const html = '<!doctype html><html><head>' +
    '<meta content="2016-01-14T03:30:00Z" property="article:published_time">' +
    '<meta name="description" content="Deadly explosions in Jakarta on January 14, 2016.">' +
    '</head><body><article>Deadly explosions in Jakarta on January 14, 2016 killed several people.</article></body></html>';
  const body = await runWorker([
    [{
      title: 'Jakarta explosions: at least four people dead',
      snippet: 'An archived report describes explosions in Jakarta, Indonesia. Original report: ' + cnnLink + '.',
      url: facebookUrl
    }],
    [],
    []
  ], {
    [cnnLink]: html,
    ['https://cnn.it/1UQuTRZ']: html
  });

  assert.equal(body.results.length, 0, 'the original article date should keep the 2016 event out of the five-year window');
  assert.equal(body.undatedResults.length, 0);
  assert.ok(body.diagnostics.originalSourceFetchCount >= 1);
  assert.ok(body.diagnostics.originalSourcePageReadCount >= 1);
  assert.ok(body.diagnostics.originalSourceDateEnrichedCount >= 1);
  assert.ok(body.diagnostics.rejectedOutsideFiveYearWindowCount >= 1);
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
      url: 'https://example.com/jakarta-theft-report?utm_medium=search',
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

test('source page metadata separates publication date from incident date and classifies unrest', async () => {
  const url = 'https://localnews.example/jakarta-protests';
  const publicationDate = '2025-08-29T00:00:00.000Z';
  const eventDate = '2025-08-28T00:00:00.000Z';
  const html = '<!doctype html><html><head>' +
    '<meta property="article:published_time" content="' + publicationDate + '">' +
    '</head><body><article>Demonstrations began on August 15, 2025. The fatal road incident occurred on August 28, 2025. Demonstrations continued in Jakarta.</article></body></html>';
  const body = await runWorker([
    [{
      title: 'Situation remains tense in Jakarta as protests continue',
      snippet: 'Demonstrations in Jakarta continued after the fatal road incident.',
      url
    }],
    [],
    []
  ], { [url]: html });

  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].eventDate, eventDate);
  assert.equal(body.results[0].publishedAt, publicationDate);
  assert.equal(body.results[0].category, 'unrest');
  assert.ok(body.results[0].incidentTags.includes('unrest'));
  assert.ok(body.results[0].incidentTags.includes('fatality'));
  assert.equal(body.results[0].dateEnrichmentSource, 'original-source-metadata-or-body');
});

test('fatal assault headlines receive a specific fatality category', async () => {
  const body = await runWorker([
    [{
      title: 'Jakarta police confirm fatal assault incident in South Jakarta',
      snippet: 'The victim died after being attacked in Jakarta.',
      url: 'https://example.com/jakarta-fatal-assault'
    }],
    [],
    []
  ]);

  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].category, 'homicide_or_fatality');
  assert.ok(body.results[0].incidentTags.includes('fatality'));
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


test('known Amnesty reference to the January 2016 Jakarta attack is excluded by its incident date', async () => {
  const url = 'https://amnesty.org.nz/indonesia-vicious-jakarta-attack-shows-utter-contempt-human-life';
  const body = await runWorker([
    [{
      title: 'Indonesia: Vicious Jakarta attack shows utter contempt for ...',
      snippet: 'A series of bomb blasts and shootings that rocked Jakarta yesterday killed at least seven people, five of whom were suspected attackers.',
      url
    }],
    [],
    []
  ]);

  assert.equal(body.results.length, 0);
  assert.equal(body.undatedResults.length, 0);
  assert.equal(body.diagnostics.knownHistoricalDateMatchCount, 1);
  assert.ok(body.diagnostics.rejectedOutsideFiveYearWindowCount >= 1);
});

test('general crime statistics and overview pages are rejected as non-incident references', async () => {
  const body = await runWorker([
    [{
      title: 'CRIME IN INDONESIA',
      snippet: "Indonesia's murder rate is 8 homicides per 100,000. Jakarta is a remarkably safe city.",
      url: 'https://factsanddetails.com/indonesia/Government_Military_Crime/sub6_5b/entry-4063.html'
    }],
    [],
    []
  ]);

  assert.equal(body.results.length, 0);
  assert.equal(body.undatedResults.length, 0);
  assert.ok(body.diagnostics.rejectedGenericReferenceCount >= 1);
});

test('fatality tags recognize plural deaths in protest-related reports', async () => {
  const body = await runWorker([
    [{
      title: 'Indonesia: Authorities must investigate eight deaths following violent crackdown on protests',
      snippet: 'Deaths from the crackdown on protests in Jakarta and other regions are alarming.',
      url: 'https://example.com/indonesia-protest-deaths'
    }],
    [],
    []
  ]);

  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].category, 'unrest');
  assert.ok(body.results[0].incidentTags.includes('unrest'));
  assert.ok(body.results[0].incidentTags.includes('fatality'));
});


test('explicit date-first wording captures the incident date', async () => {
  const publishedAt = '2025-08-30T00:00:00.000Z';
  const body = await runWorker([
    [{
      title: 'Fatal clash in Jakarta',
      snippet: 'On August 28, 2025, a 23-year-old man was killed after a street clash in central Jakarta.',
      publishedAt,
      url: 'https://example.com/jakarta-clash-2025-08-28'
    }],
    [],
    []
  ]);

  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].eventDate, '2025-08-28T00:00:00.000Z');
  assert.equal(body.results[0].publishedAt, publishedAt);
  assert.equal(body.results[0].timelineBasis, 'event-date');
  assert.equal(body.diagnostics.eventDateCount, 1);
  assert.equal(body.diagnostics.eventDateUnconfirmedCount, 0);
});

test('relative event dates are labelled approximate and not confused with publication date', async () => {
  const publishedAt = new Date().toISOString();
  const expectedDay = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const body = await runWorker([
    [{
      title: 'Jakarta fatal assault investigation',
      snippet: 'Police said the victim died two days ago after being attacked in South Jakarta.',
      publishedAt,
      url: 'https://example.com/jakarta-fatal-assault-relative'
    }],
    [],
    []
  ]);

  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].eventDate.slice(0, 10), expectedDay);
  assert.equal(body.results[0].eventDatePrecision, 'relative-estimate');
  assert.equal(body.results[0].publishedAt, publishedAt);
  assert.equal(body.results[0].timelineBasis, 'event-date');
  assert.equal(body.diagnostics.eventDateCount, 1);
});

test('weekday-only incident dates resolve only against an absolute publication date', async () => {
  const publishedAt = '2025-08-30T00:00:00.000Z'; // Saturday; the preceding Thursday is 28 August.
  const body = await runWorker([
    [{
      title: 'Protests escalate in Jakarta after a driver is killed',
      snippet: 'On Thursday, a 21-year-old ride-hailing driver was run over by an armored police vehicle in Jakarta.',
      publishedAt,
      url: 'https://example.com/jakarta-driver-thursday'
    }],
    [],
    []
  ]);

  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].eventDate.slice(0, 10), '2025-08-28');
  assert.equal(body.results[0].eventDatePrecision, 'relative-estimate');
  assert.match(body.results[0].eventDateStatus, /weekday-inferred-from-publication-date|context-matched-in-original-source/);
});

test('the start date of a protest series is not mislabelled as an individual incident date', async () => {
  const publishedAt = '2025-08-29T00:00:00.000Z';
  const body = await runWorker([
    [{
      title: 'Nationwide protests started on August 15, 2025 in Indonesia.',
      snippet: 'Demonstrations continued in Jakarta through the week.',
      publishedAt,
      url: 'https://example.com/jakarta-protests-series-start'
    }],
    [],
    []
  ]);

  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].eventDate, null);
  assert.equal(body.results[0].timelineBasis, 'publication-date-proxy');
  assert.equal(body.diagnostics.eventDateCount, 0);
  assert.equal(body.diagnostics.eventDateUnconfirmedCount, 1);
});

test('general crime roundups are filtered while concrete investigations remain', async () => {
  const body = await runWorker([
    [
      {
        title: 'LIVE - Robbers "Haunt" Jakarta | INVESTIGATION DIPO',
        snippet: 'A roundup of recurring street crime in Jakarta: begal, penjambretan, and theft reports.',
        url: 'https://www.youtube.com/watch?v=generic-jakarta-crime-roundup'
      },
      {
        title: 'Jakarta residents welcome an anti-crime crackdown',
        snippet: 'This report describes a police campaign against street crime in Jakarta, without a specific incident.',
        url: 'https://example.com/jakarta-anti-crime-campaign'
      },
      {
        title: 'Jakarta police arrest two suspects after a fatal robbery',
        snippet: 'Police in Jakarta arrested two suspects in a fatal robbery investigation on Tuesday.',
        url: 'https://example.com/jakarta-fatal-robbery-investigation'
      }
    ],
    [],
    []
  ]);

  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].title, 'Jakarta police arrest two suspects after a fatal robbery');
  assert.ok(body.diagnostics.rejectedGenericReferenceCount >= 2);
});

test('timeline bucket arrays include all unique results beyond the former eight-item limit', async () => {
  const publishedAt = new Date(Date.now() - 60 * 86400000).toISOString();
  const rows = Array.from({ length: 10 }, (_, index) => ({
    title: 'Jakarta theft incident report ' + (index + 1),
    snippet: 'Police reported a distinct theft incident in Jakarta, Indonesia. Reference number ' + (index + 1) + '.',
    publishedAt,
    url: 'https://example.com/jakarta-theft-report-' + (index + 1)
  }));
  const body = await runWorker([rows, [], []]);

  assert.equal(body.mediumTermResults.length, 10);
  assert.equal(body.results.length, 10);
  assert.equal(body.diagnostics.eventDateUnconfirmedCount, 10);
});


test('the Worker returns 429 after the per-client burst allowance is used', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async () => null,
      put: async () => undefined
    }
  };
  globalThis.fetch = async () => {
    throw new Error('invalid coordinates should be rejected before outbound fetch');
  };

  try {
    const requestFor = () => new Request('https://civilaegis.test/nearby-intel?lat=not-a-number&lng=not-a-number', {
      method: 'GET',
      headers: {
        Origin: 'https://anggaconni.github.io',
        'CF-Connecting-IP': '198.51.100.44'
      }
    });
    for (let index = 0; index < 6; index += 1) {
      const response = await worker.fetch(
        requestFor(),
        { TINYFISH_API_KEY: 'test-key', ALLOWED_ORIGINS: 'https://anggaconni.github.io' },
        { waitUntil: () => undefined }
      );
      assert.equal(response.status, 400);
    }

    const limited = await worker.fetch(
      requestFor(),
      { TINYFISH_API_KEY: 'test-key', ALLOWED_ORIGINS: 'https://anggaconni.github.io' },
      { waitUntil: () => undefined }
    );
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).retryAfterSeconds, 60);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});


test('reverse-geocoded country and region drive global search without Indonesia hardcoding', async () => {
  const searchQueries = [];
  const body = await runWorker([
    [],
    [],
    [{
      title: 'Papua New Guinea national survey finds high prevalence of sexual violence against women',
      snippet: 'A population-based survey in Papua New Guinea reports that many women have experienced sexual violence. This study describes national prevalence, not an incident in the city where the user is located.',
      publishedAt: new Date(Date.now() - 6 * 365.2425 * 86400000).toISOString(),
      url: 'https://example.com/papua-new-guinea-prevalence-survey'
    }]
  ], {}, {
    address: { city: 'Port Moresby', state: 'National Capital District', country: 'Papua New Guinea' },
    searchQueries
  });

  assert.match(body.area, /Port Moresby, National Capital District, Papua New Guinea/);
  assert.equal(searchQueries.length, 3);
  assert.ok(searchQueries.every(query => /Papua New Guinea/.test(query)), 'all search windows should target the reverse-geocoded country');
  assert.ok(searchQueries.every(query => !/locality, Indonesia|Search Indonesian/.test(query)), 'queries must not hardcode Indonesia');
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].evidenceType, 'structural-risk');
  assert.equal(body.results[0].timelineBucket, 'risk-context');
  assert.equal(body.results[0].alertEligibility, 'risk-context-only');
  assert.equal(body.results[0].eventLocationScope, 'country-context');
  assert.equal(body.results[0].category, 'sexual_violence');
});

test('a three-year-old local bombing is retained as historical incident context, not undated or current', async () => {
  const eventDate = new Date(Date.now() - 3 * 365.2425 * 86400000).toISOString().slice(0, 10);
  const body = await runWorker([
    [],
    [],
    [{
      title: 'Port Moresby bombing reported three years ago',
      snippet: 'Authorities reported a bomb attack in Port Moresby, Papua New Guinea. The article describes a historical event.',
      eventDate,
      publishedAt: eventDate,
      url: 'https://example.com/port-moresby-bombing'
    }]
  ], {}, {
    address: { city: 'Port Moresby', state: 'National Capital District', country: 'Papua New Guinea' }
  });

  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].timelineBucket, 'history-2-to-5-years');
  assert.equal(body.results[0].timelineBasis, 'event-date');
  assert.equal(body.results[0].category, 'explosion_or_blast');
  assert.equal(body.results[0].alertEligibility, 'historical-awareness-only');
  assert.equal(body.results[0].currentIncidentConfirmed, false);
});


test('a timed-out TinyFish window does not stop later search windows from succeeding', async () => {
  const publishedAt = new Date().toISOString();
  const body = await runWorker([
    [],
    [{
      title: 'Fatal robbery reported in Jakarta',
      snippet: 'Police arrested a suspect following a fatal robbery in Jakarta, Indonesia.',
      eventDate: publishedAt,
      publishedAt,
      url: 'https://example.com/jakarta-fatal-robbery-today'
    }],
    []
  ], {}, {
    searchFailures: [{ type: 'timeout' }, null, null]
  });

  assert.equal(body.successfulSearches, 2);
  assert.equal(body.failedSearchWindows.length, 1);
  assert.equal(body.failedSearchWindows[0].window, 'recent-30-days');
  assert.equal(body.failedSearchWindows[0].reason, 'timeout');
  assert.equal(body.results.length, 1, 'later windows must still contribute results');
  assert.equal(body.results[0].title, 'Fatal robbery reported in Jakarta');
});

test('all failed TinyFish windows return actionable diagnostics instead of hiding the failure', async () => {
  const body = await runWorker([[], [], []], {}, {
    expectedStatus: 502,
    searchFailures: [{ type: 'timeout' }, { status: 429 }, { status: 403 }]
  });

  assert.equal(body.error, 'TinyFish Search did not return successful time-window searches');
  assert.equal(body.successfulSearches, 0);
  assert.equal(body.failedSearchWindows.length, 3);
  assert.equal(body.failedSearchWindows[0].reason, 'timeout');
  assert.equal(body.failedSearchWindows[1].reason, 'rate-limited');
  assert.equal(body.failedSearchWindows[2].reason, 'authentication-failed');
  assert.equal(body.filterVersion, 11);
  assert.equal(body.buildVersion, 'global-drr-v1.1-search-reliability');
});


test('Semantic Scholar proxy forwards a bounded search and returns CORS-enabled JSON', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  let requestHeaders;
  globalThis.fetch = async (input, init = {}) => {
    requestedUrl = new URL(typeof input === 'string' ? input : input.url);
    requestHeaders = init.headers || {};
    return new Response(JSON.stringify({
      total: 1,
      offset: 0,
      data: [{ paperId: 'paper-1', title: 'Biosphere reserves and resilience', year: 2024, authors: [] }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const request = new Request(
      'https://civilaegis.test/semantic-scholar?query=' + encodeURIComponent('  biosphere   reserves  '),
      { method: 'GET', headers: { Origin: 'https://anggaconni.github.io', 'CF-Connecting-IP': '203.0.113.20' } }
    );
    const response = await worker.fetch(
      request,
      { ALLOWED_ORIGINS: 'https://anggaconni.github.io' },
      { waitUntil: () => undefined }
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://anggaconni.github.io');
    assert.equal(requestedUrl.hostname, 'api.semanticscholar.org');
    assert.equal(requestedUrl.searchParams.get('query'), 'biosphere reserves');
    assert.equal(requestedUrl.searchParams.get('limit'), '8');
    assert.match(requestedUrl.searchParams.get('fields'), /citationCount/);
    assert.equal(requestHeaders['x-api-key'], undefined, 'no client key is forwarded by default');
    const body = await response.json();
    assert.equal(body.data[0].title, 'Biosphere reserves and resilience');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Semantic Scholar proxy validates query and rejects disallowed origins', async () => {
  const shortQuery = await worker.fetch(
    new Request('https://civilaegis.test/semantic-scholar?query=hi', {
      method: 'GET',
      headers: { Origin: 'https://anggaconni.github.io' }
    }),
    { ALLOWED_ORIGINS: 'https://anggaconni.github.io' },
    { waitUntil: () => undefined }
  );
  assert.equal(shortQuery.status, 400);

  const blockedOrigin = await worker.fetch(
    new Request('https://civilaegis.test/semantic-scholar?query=biosphere', {
      method: 'GET',
      headers: { Origin: 'https://untrusted.example' }
    }),
    { ALLOWED_ORIGINS: 'https://anggaconni.github.io' },
    { waitUntil: () => undefined }
  );
  assert.equal(blockedOrigin.status, 403);
});
