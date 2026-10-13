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
    const primary = address.suburb || address.neighbourhood || address.city_district ||
        address.town || address.city || address.village || address.municipality ||
        address.county || '';
    const city = address.city || address.town || address.municipality || address.county || '';
    const region = address.state || address.province || '';
    const values = [primary, city, region, 'Indonesia'].filter(Boolean);
    const unique = [];
    values.forEach(function (value) {
        if (unique.indexOf(value) < 0) unique.push(value);
    });
    return unique.length > 1 ? unique.join(', ') : fallback + ', Indonesia';
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

        const query = 'recent local news reports and official public-safety notices about pickpocketing, bag snatching, phone theft, robbery, assault, card skimming, payment-card fraud, scams, road traffic accidents, vehicle crashes, flooding, fires, or emergency incidents near ' +
            locality + ' in the last 24 hours. Prefer police, fire and rescue services, local government, transport agencies, and established local newsrooms. Return relevant source links and preserve the original publication date and reported location when available. Do not invent events.';

        try {
            const searchUrl = new URL('https://api.search.tinyfish.ai/');
            searchUrl.searchParams.set('query', query);
            const searchResponse = await fetch(searchUrl.toString(), {
                headers: {
                    'X-API-Key': env.TINYFISH_API_KEY,
                    'Accept': 'application/json'
                }
            });
            if (!searchResponse.ok) {
                return jsonResponse({
                    error: 'TinyFish Search API returned HTTP ' + searchResponse.status,
                    results: [],
                    area: locality
                }, 502, corsOrigin);
            }

            const payload = await searchResponse.json();
            const seen = new Set();
            const results = extractResults(payload).map(function (item) {
                const targetUrl = item.url || item.link || item.href || '';
                if (!/^https?:\/\//i.test(targetUrl) || seen.has(targetUrl)) return null;
                seen.add(targetUrl);
                let source = '';
                try { source = new URL(targetUrl).hostname.replace(/^www\./, ''); } catch (_) {}
                return {
                    title: String(item.title || item.name || 'Local news signal'),
                    snippet: String(item.snippet || item.description || item.content || ''),
                    url: targetUrl,
                    source: source || 'TinyFish Search',
                    area: locality,
                    publishedAt: item.publishedAt || item.published_at || item.date || null,
                    verified: false
                };
            }).filter(Boolean).slice(0, 12);

            const responseBody = {
                area: locality,
                generatedAt: new Date().toISOString(),
                note: 'Search/media signals are not independently verified incidents and are not precisely geolocated.',
                results: results
            };

            try {
                const cacheResponse = new Response(JSON.stringify(responseBody), {
                    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=900' }
                });
                ctx.waitUntil(cache.put(cacheKey, cacheResponse));
            } catch (_) {
                // Search response remains useful when edge caching is unavailable.
            }
            return jsonResponse(responseBody, 200, corsOrigin);
        } catch (_) {
            return jsonResponse({ error: 'Unable to retrieve local web signals from TinyFish', area: locality, results: [] }, 502, corsOrigin);
        }
    }
};
