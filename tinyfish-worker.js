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

        const query = 'publicly reported crime, violence, murder, homicide, sexual assault, rape, sexual harassment, riots, mob violence, fatal clashes, deaths during unrest, pickpocketing, bag snatching, robbery, phone theft, scams, fraud, card skimming, road accidents, traffic crashes, flooding, fires and other public-safety incidents in ' +
            locality + '. Cover incidents reported in the last 30 days and notable historical incidents up to 5 years ago. Include dates, approximate locality, incident type, source links, official statements where available, and whether people were reported injured or killed. Prefer police, courts, local government, emergency services, reputable local newsrooms and established national media. Distinguish alleged, reported, investigated, charged, and confirmed outcomes. Do not imply a historical incident is current, do not infer a specific person or address is involved, and do not invent events.';
        const timeWindows = [
            { label: 'recent-30-days', query: 'recent last 30 days' },
            { label: 'history-1-to-5-years', query: 'historical past 5 years notable incidents' }
        ];

        try {
            const gathered = [];
            const seen = new Set();
            for (const window of timeWindows) {
                const scopedQuery = query + ' Search window: ' + window.query + '. Label this window as ' + window.label + '.';
                const searchUrl = new URL('https://api.search.tinyfish.ai/');
                searchUrl.searchParams.set('query', scopedQuery);
                const searchResponse = await fetch(searchUrl.toString(), {
                    headers: {
                        'X-API-Key': env.TINYFISH_API_KEY,
                        'Accept': 'application/json'
                    }
                });
                if (!searchResponse.ok) {
                    // A failed historic search should not discard current reports (or vice versa).
                    continue;
                }

                const payload = await searchResponse.json();
                extractResults(payload).forEach(function (item) {
                    const targetUrl = item.url || item.link || item.href || '';
                    if (!/^https?:\/\//i.test(targetUrl)) return;
                    const key = targetUrl.toLowerCase();
                    if (seen.has(key)) return;
                    seen.add(key);
                    let source = '';
                    try { source = new URL(targetUrl).hostname.replace(/^www\./, ''); } catch (_) {}
                    const publishedAt = item.publishedAt || item.published_at || item.date || null;
                    const snippet = String(item.snippet || item.description || item.content || '');
                    const title = String(item.title || item.name || 'Local public-safety report');
                    const combined = (title + ' ' + snippet).toLowerCase();
                    let category = 'public_safety';
                    if (/rape|sexual assault|sexual violence|molest|harass/.test(combined)) category = 'sexual_violence';
                    else if (/murder|homicide|killed|fatal stabbing|fatal shooting|fatal clash/.test(combined)) category = 'homicide_or_fatality';
                    else if (/riot|unrest|mob violence|clash|communal violence/.test(combined)) category = 'unrest';
                    else if (/pickpocket|snatch|theft|robbery|burglary|stolen phone/.test(combined)) category = 'theft';
                    else if (/scam|fraud|card skimming|carding|phishing/.test(combined)) category = 'scam_or_fraud';
                    else if (/accident|crash|collision|hit-and-run/.test(combined)) category = 'road_accident';
                    else if (/flood|inundation|landslide|earthquake|volcan/.test(combined)) category = 'disaster';
                    let ageYears = null;
                    if (publishedAt) {
                        const parsed = Date.parse(String(publishedAt));
                        if (Number.isFinite(parsed)) ageYears = Math.max(0, (Date.now() - parsed) / (365.2425 * 24 * 60 * 60 * 1000));
                    }
                    gathered.push({
                        id: key,
                        title: title,
                        snippet: snippet,
                        url: targetUrl,
                        source: source || 'TinyFish Search',
                        area: locality,
                        publishedAt: publishedAt,
                        ageYears: ageYears,
                        searchWindow: window.label,
                        category: category,
                        verified: false,
                        recencyLabel: ageYears === null ? 'Date not confirmed' :
                            ageYears < (30 / 365.2425) ? 'Reported within ~30 days' :
                            ageYears < 1 ? 'Historical · under 1 year' :
                            ageYears < 2 ? 'Historical · 1–2 years' :
                            ageYears < 5 ? 'Historical · 2–5 years' : 'Outside awareness window'
                    });
                });
            }

            const now = Date.now();
            const recent = [];
            const historic = [];
            gathered.forEach(function (item) {
                if (item.ageYears === null || item.ageYears <= (30 / 365.2425)) recent.push(item);
                else if (item.ageYears <= 5) historic.push(item);
            });
            // Prioritize timely information, while preserving a separate historical-awareness section in the response.
            const responseBody = {
                area: locality,
                radiusType: 'municipality/city/regency',
                generatedAt: new Date().toISOString(),
                recentResults: recent.slice(0, 8),
                historicalResults: historic.slice(0, 12),
                results: recent.concat(historic).slice(0, 20),
                note: 'TinyFish search/media leads are not independently verified incident records and are not precisely geolocated. Dates and outcomes must be checked at the original source. A historical report is not a claim of current danger.'
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
