/**
 * CivilAegis TinyFish local-news proxy
 *
 * Deploy this file as a Cloudflare Worker. Store TINYFISH_API_KEY as a Worker secret.
 * Do not put TinyFish API keys in index.html or other public GitHub Pages files.
 *
 * Endpoint: GET /nearby-intel?lat=-6.2&lng=106.8
 * Returns local search signals only; these are not verified incident records and have no claimed exact coordinates.
 */

const DEFAULT_ALLOWED_ORIGINS = 'https://anggaconni.github.io';

function jsonResponse(body, status, origin) {
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': origin || 'null',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin'
    };
    return new Response(JSON.stringify(body), { status: status || 200, headers: headers });
}

function extractResults(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.results)) return payload.results;
    if (payload && payload.data && Array.isArray(payload.data.results)) return payload.data.results;
    if (payload && Array.isArray(payload.items)) return payload.items;
    if (payload && Array.isArray(payload.organic_results)) return payload.organic_results;
    return [];
}

function getLocality(address, fallback) {
    address = address || {};
    // Prefer municipality/city/regency fields. Do not search by village, suburb,
    // neighbourhood, or district because that makes local awareness too narrow.
    const municipality = address.city || address.town || address.municipality ||
        address.county || address.city_municipality || address.state_district || '';
    const region = address.state || address.province || '';
    const values = [municipality, region, 'Indonesia'].filter(Boolean);
    const unique = [];
    values.forEach(function (value) {
        if (unique.indexOf(value) < 0) unique.push(value);
    });
    return unique.length > 1 ? unique.join(', ') : (municipality || region || fallback) + ', Indonesia';
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin') || '';
        const allowedOrigins = String(env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS)
            .split(',').map(function (value) { return value.trim(); }).filter(Boolean);
        const isAllowedOrigin = !origin || allowedOrigins.indexOf(origin) >= 0;
        const corsOrigin = origin && isAllowedOrigin ? origin : allowedOrigins[0];

        if (!isAllowedOrigin) return jsonResponse({ error: 'Origin not allowed' }, 403, 'null');
        if (request.method === 'OPTIONS') return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': corsOrigin,
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '86400',
                'Vary': 'Origin'
            }
        });
        if (request.method !== 'GET') return jsonResponse({ error: 'Use GET' }, 405, corsOrigin);
        if (url.pathname !== '/nearby-intel') return jsonResponse({ error: 'Not found' }, 404, corsOrigin);
        if (!env.TINYFISH_API_KEY) return jsonResponse({ error: 'Worker secret TINYFISH_API_KEY is not configured' }, 503, corsOrigin);

        const rawLat = Number(url.searchParams.get('lat'));
        const rawLng = Number(url.searchParams.get('lng'));
        if (!Number.isFinite(rawLat) || !Number.isFinite(rawLng) ||
            rawLat < -90 || rawLat > 90 || rawLng < -180 || rawLng > 180) {
            return jsonResponse({ error: 'Valid lat and lng query parameters are required' }, 400, corsOrigin);
        }

        // Round coordinates before reverse-geocoding. TinyFish receives only the resulting locality,
        // not the user's exact GPS coordinates.
        const lat = Math.round(rawLat * 100) / 100;
        const lng = Math.round(rawLng * 100) / 100;
        const timeBucket = Math.floor(Date.now() / (15 * 60 * 1000));
        const cacheKey = new Request(url.origin + '/_cache/nearby-intel?lat=' + lat + '&lng=' + lng + '&slot=' + timeBucket);
        const cache = caches.default;
        try {
            const cached = await cache.match(cacheKey);
            if (cached) {
                const body = await cached.json();
                return jsonResponse(body, 200, corsOrigin);
            }
        } catch (_) {
            // Cache is an optimization; continue with live search when unavailable.
        }

        let locality = lat.toFixed(2) + ', ' + lng.toFixed(2);
        try {
            const reverseUrl = new URL('https://nominatim.openstreetmap.org/reverse');
            reverseUrl.searchParams.set('format', 'jsonv2');
            reverseUrl.searchParams.set('lat', String(lat));
            reverseUrl.searchParams.set('lon', String(lng));
            reverseUrl.searchParams.set('zoom', '10');
            reverseUrl.searchParams.set('addressdetails', '1');
            const reverseResponse = await fetch(reverseUrl.toString(), {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'CivilAegisSafetyRadar/1.0'
                }
            });
            if (reverseResponse.ok) {
                const reversePayload = await reverseResponse.json();
                locality = getLocality(reversePayload.address, locality);
            }
        } catch (_) {
            // Keep rounded coordinates as a broad-area fallback.
        }

        const baseQuery = 'publicly reported crime, violence, murder, homicide, sexual assault, rape, sexual harassment, riots, mob violence, fatal clashes, deaths during unrest, pickpocketing, bag snatching, robbery, phone theft, scams, fraud, card skimming, road accidents, traffic crashes, flooding, fires and other public-safety incidents in ' +
            locality + '. Include dates, approximate city/regency/municipality, source links, official statements where available, and reported injuries or fatalities. Prefer police, courts, local government, emergency services, reputable local newsrooms and established national media. Distinguish alleged, reported, investigated, charged, and confirmed outcomes. Do not infer a specific person or address is involved, and do not invent events.';
        const timeWindows = [
            { label: 'recent-30-days', query: 'published or occurred within the last 30 days', maxAgeDays: 30 },
            { label: 'history-30-days-to-2-years', query: 'published or occurred from 30 days ago up to 2 years ago', maxAgeDays: 730 },
            { label: 'history-2-to-5-years', query: 'published or occurred from 2 years ago up to 5 years ago', maxAgeDays: 1826 }
        ];

        try {
            const gathered = [];
            const seen = new Set();
            let successfulSearches = 0;
            for (const window of timeWindows) {
                const scopedQuery = baseQuery + ' Search only for reports ' + window.query +
                    '. This is the ' + window.label + ' window. Return publication/event date when available.';
                const searchUrl = new URL('https://api.search.tinyfish.ai/');
                searchUrl.searchParams.set('query', scopedQuery);
                const searchResponse = await fetch(searchUrl.toString(), {
                    headers: { 'X-API-Key': env.TINYFISH_API_KEY, 'Accept': 'application/json' }
                });
                if (!searchResponse.ok) continue;
                successfulSearches += 1;
                const payload = await searchResponse.json();
                extractResults(payload).forEach(function (item) {
                    const targetUrl = item.url || item.link || item.href || '';
                    if (!/^https?:\/\//i.test(targetUrl)) return;
                    const key = targetUrl.toLowerCase();
                    if (seen.has(key)) return;

                    const title = String(item.title || item.name || 'Local public-safety report');
                    const snippet = String(item.snippet || item.description || item.content || '');
                    const text = (title + ' ' + snippet).toLowerCase();
                    let category = 'public_safety';
                    if (/rape|sexual assault|sexual violence|molest|sexual harassment/.test(text)) category = 'sexual_violence';
                    else if (/murder|homicide|killed|fatal stabbing|fatal shooting|fatal clash/.test(text)) category = 'homicide_or_fatality';
                    else if (/riot|unrest|mob violence|clash|communal violence/.test(text)) category = 'unrest';
                    else if (/pickpocket|snatch|theft|robbery|burglary|stolen phone/.test(text)) category = 'theft';
                    else if (/scam|fraud|card skimming|carding|phishing/.test(text)) category = 'scam_or_fraud';
                    else if (/accident|crash|collision|hit-and-run/.test(text)) category = 'road_accident';
                    else if (/flood|inundation|landslide|earthquake|volcan/.test(text)) category = 'disaster';

                    const rawDate = item.publishedAt || item.published_at || item.date || item.pubDate || null;
                    let publishedAt = rawDate;
                    let ageYears = null;
                    let dateStatus = 'Publication date unconfirmed';
                    if (rawDate) {
                        const dateMs = Date.parse(String(rawDate));
                        if (Number.isFinite(dateMs)) {
                            ageYears = Math.max(0, (Date.now() - dateMs) / (365.2425 * 24 * 60 * 60 * 1000));
                            publishedAt = new Date(dateMs).toISOString();
                            dateStatus = 'Publication date parsed';
                        } else {
                            dateStatus = 'Date supplied but not parseable';
                        }
                    }
                    if (ageYears !== null && ageYears > 5) return;
                    if (ageYears !== null && ageYears * 365.2425 > window.maxAgeDays + 60) return;
                    seen.add(key);
                    let source = '';
                    try { source = new URL(targetUrl).hostname.replace(/^www\\./, ''); } catch (_) {}
                    gathered.push({
                        id: key, title: title, snippet: snippet, url: targetUrl,
                        source: source || 'TinyFish Search', area: locality,
                        publishedAt: publishedAt, ageYears: ageYears,
                        searchWindow: window.label, dateStatus: dateStatus,
                        category: category, verified: false,
                        recencyLabel: ageYears === null ? 'Publication date unconfirmed' :
                            ageYears <= (30 / 365.2425) ? 'Recent · up to 30 days' :
                            ageYears <= 2 ? 'Historical · 30 days to 2 years' : 'Historical · 2 to 5 years'
                    });
                });
            }

            const recentResults = [];
            const mediumTermResults = [];
            const longTermResults = [];
            const undatedResults = [];
            gathered.forEach(function (item) {
                if (item.ageYears === null) undatedResults.push(item);
                else if (item.ageYears <= (30 / 365.2425)) recentResults.push(item);
                else if (item.ageYears <= 2) mediumTermResults.push(item);
                else if (item.ageYears <= 5) longTermResults.push(item);
            });
            const responseBody = {
                area: locality, radiusType: 'municipality/city/regency',
                generatedAt: new Date().toISOString(), successfulSearches: successfulSearches,
                recentResults: recentResults.slice(0, 8),
                mediumTermResults: mediumTermResults.slice(0, 8),
                longTermResults: longTermResults.slice(0, 8),
                historicalResults: mediumTermResults.concat(longTermResults).slice(0, 16),
                undatedResults: undatedResults.slice(0, 8),
                results: recentResults.concat(mediumTermResults, longTermResults, undatedResults).slice(0, 30),
                note: 'TinyFish search/media leads are not independently verified and are not precisely geolocated. Publication dates may differ from incident dates. Verify original sources; historical reports do not imply current danger.'
            };
            if (!successfulSearches) {
                return jsonResponse({ error: 'TinyFish Search did not return successful time-window searches', area: locality, results: [], recentResults: [], historicalResults: [], successfulSearches: 0 }, 502, corsOrigin);
            }
            try {
                const cacheResponse = new Response(JSON.stringify(responseBody), {
                    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=900' }
                });
                ctx.waitUntil(cache.put(cacheKey, cacheResponse));
            } catch (_) {}
            return jsonResponse(responseBody, 200, corsOrigin);
        } catch (_) {
            return jsonResponse({ error: 'Unable to retrieve local web signals from TinyFish', area: locality, results: [] }, 502, corsOrigin);
        }
    }
};
