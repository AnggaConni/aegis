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
    // Prefer city/regency fields; never fall back to village/suburb/district.
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

function normalizeForMatching(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getLocalitySearchTerms(locality) {
    const firstPart = String(locality || '').split(',')[0].trim();
    const municipality = firstPart
        .replace(/^daerah khusus ibukota\s+/i, '')
        .replace(/^daerah istimewa\s+/i, '')
        .replace(/^(kota administrasi|kabupaten administrasi|kota|kabupaten|regency|municipality|city of|city|kab\.?|kot\.?|dki)\s+/i, '')
        .trim();
    const terms = [];
    [municipality, firstPart].forEach(value => {
        const normalized = normalizeForMatching(value);
        if (normalized.length >= 4 && !terms.includes(normalized)) terms.push(normalized);
    });
    // Do not split a municipality into individual words; partial matches create false positives.
    return terms.sort((a, b) => b.length - a.length);
}

function assessIncidentLocation(item, localityTerms) {
    const title = String(item.title || item.name || '');
    const snippet = String(item.snippet || item.description || item.content || '');
    const url = String(item.url || item.link || item.href || '');
    const contentText = title + ' ' + snippet;
    const normalizedContent = normalizeForMatching(contentText);
    const normalizedUrl = normalizeForMatching(url);
    if (!localityTerms.length) return { accepted: false, reason: 'no-locality-term' };
    const matchedTerm = localityTerms.find(term => normalizedContent.includes(term));
    if (!matchedTerm) {
        return { accepted: false, reason: localityTerms.some(term => normalizedUrl.includes(term)) ? 'city-in-url-only' : 'no-city-mention' };
    }

    const rawCombined = title + ' ' + snippet + ' ' + url;
    const genericReference = /(crime statistics|violent crime rate|crime data explorer|crime in the united states|uniform crime reporting|annual crime figures|crime statistics by state|research starters|topic pages table)/i.test(rawCombined);
    const foreignGenericDomains = /(ucr\.fbi\.gov|bjs\.ojp\.gov|cde\.ucr\.cjis\.gov|suffolkpd\.org|osc\.ny\.gov|crimeindex\.org|ebsco\.com|wikipedia\.org)/i.test(url);
    if (genericReference || foreignGenericDomains) return { accepted: false, reason: 'generic-or-foreign-reference' };

    const nationalScale = /(nationwide|across indonesia|throughout indonesia|across the country|across the archipelago|several provinces|multiple provinces|multiple cities|nationwide unrest|nationwide protests|di seluruh indonesia|lintas provinsi|sejumlah daerah|berbagai daerah|kerusuhan nasional)/i.test(rawCombined);
    const escaped = matchedTerm.replace(/[.*+?^$()|[\]\\]/g, '\\function getLocalitySearchTerms(locality) {
    const ignored = new Set(['indonesia', 'province', 'provinsi', 'java', 'jawa', 'west', 'east', 'central', 'barat', 'timur', 'tengah', 'utara', 'selatan']);
    const terms = [];
    const add = function (value) {
        const normalized = normalizeForMatching(value);
        if (normalized.length < 3 || ignored.has(normalized) || terms.indexOf(normalized) >= 0) return;
        terms.push(normalized);
    };
    const firstPart = String(locality || '').split(',')[0].trim();
    add(firstPart);
    const municipality = firstPart
        .replace(/^daerah khusus ibukota\s+/i, '')
        .replace(/^daerah istimewa\s+/i, '')
        .replace(/^(kota administrasi|kabupaten administrasi|kota|kabupaten|regency|municipality|city of|city|kab\.?|kot\.?|dki)\s+/i, '')
        .trim();
    add(municipality);
    municipality.split(/\s+/).filter(part => part.length >= 4 && !ignored.has(part)).forEach(add);
    return terms;
}

function isLocalIncidentResult(item, localityTerms) {
    const title = String(item.title || item.name || '');
    const snippet = String(item.snippet || item.description || item.content || '');
    const url = String(item.url || item.link || item.href || '');
    const combined = normalizeForMatching(title + ' ' + snippet + ' ' + url);
    if (!localityTerms.length) return false;
    const mentionsLocality = localityTerms.some(term => combined.includes(term));
    if (!mentionsLocality) return false;

    // Filter general foreign crime-statistics/reference pages even if a broad query surfaced them.
    const genericReference = /(crime statistics|violent crime rate|crime data explorer|crime in the united states|uniform crime reporting|annual crime figures|crime statistics by state|research starters|topic pages table)/i.test(title + ' ' + snippet + ' ' + url);
    const foreignGenericDomains = /(ucr\.fbi\.gov|bjs\.ojp\.gov|cde\.ucr\.cjis\.gov|suffolkpd\.org|osc\.ny\.gov|crimeindex\.org|ebsco\.com|wikipedia\.org)/i.test(url);
    if (genericReference || foreignGenericDomains) return false;
    return true;
}').replace(/\s+/g, '\\s+');
    const explicitLocalContext = new RegExp(
        '(?:\\b(?:in|at|near|around|within|across|di|ke|dari|sekitar|wilayah|kawasan)\\s+(?:the\\s+)?' + escaped + '\\b|' +
        '\\b' + escaped + '\\s+(?:attacks?|murders?|homicides?|rapes?|robberies|riots?|clashes|protests?|floods?|fires?|accidents?|pickpocketing|snatching|crime|kerusuhan|pembunuhan|pemerkosaan|pencopetan|penjambretan|kecelakaan|banjir|kebakaran)\\b)',
        'i'
    ).test(contentText);
    const scope = nationalScale && !explicitLocalContext
        ? 'national-context'
        : explicitLocalContext
            ? 'city-mentioned-location-unverified'
            : 'city-mentioned-context-unclear';
    const status = scope === 'national-context'
        ? 'National or multi-location report; city is mentioned but exact incident locations are not confirmed.'
        : scope === 'city-mentioned-location-unverified'
            ? 'City is linked to the incident in the text; exact incident location has not been independently confirmed.'
            : 'City is mentioned in the article, but the event location is unclear.';
    return { accepted: true, reason: 'city-mentioned', scope: scope, status: status, matchedTerm: matchedTerm };
}

function parseDateValue(value, nowMs) {
    if (value === null || value === undefined || value === '') return null;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (typeof value === 'number' && Number.isFinite(value)) {
        const ms = value > 100000000000 ? value : value * 1000;
        if (ms > 0 && ms <= now + 86400000) return { iso: new Date(ms).toISOString(), dateMs: ms, precision: 'absolute-timestamp', raw: value };
    }
    const raw = String(value).trim();
    const absoluteMs = Date.parse(raw);
    if (raw && Number.isFinite(absoluteMs) && absoluteMs > 0 && absoluteMs <= now + 86400000) {
        return { iso: new Date(absoluteMs).toISOString(), dateMs: absoluteMs, precision: 'absolute-date', raw: raw };
    }

    const normalized = raw.toLowerCase().trim();
    if (/\b(today|just now|moments ago)\b/.test(normalized)) {
        return { iso: new Date(now).toISOString(), dateMs: now, precision: 'relative-estimate', raw: raw, relativeLabel: 'approximately today' };
    }
    if (/\byesterday\b/.test(normalized)) {
        const ms = now - 86400000;
        return { iso: new Date(ms).toISOString(), dateMs: ms, precision: 'relative-estimate', raw: raw, ageDays: 1, relativeLabel: 'approximately 1 day ago' };
    }
    const relative = normalized.match(/\b(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?)\s+ago\b/);
    if (relative) {
        const amount = Number(relative[1]);
        const unit = relative[2];
        const multiplier = /^min|^minute/.test(unit) ? 1 / 1440
            : /^hour|^hr/.test(unit) ? 1 / 24
            : /^day/.test(unit) ? 1
            : /^week|^wk/.test(unit) ? 7
            : /^month|^mo/.test(unit) ? 30.4375
            : 365.2425;
        const ageDays = amount * multiplier;
        const ms = now - ageDays * 86400000;
        return { iso: new Date(ms).toISOString(), dateMs: ms, precision: 'relative-estimate', raw: raw, ageDays: ageDays, relativeLabel: 'approximately ' + raw };
    }
    const abbreviated = normalized.match(/\b(\d+(?:\.\d+)?)\s*(d|wk|wks|mo|yr|yrs)\s*ago\b/);
    if (abbreviated) {
        const unit = abbreviated[2];
        const ageDays = Number(abbreviated[1]) * (/^d$/.test(unit) ? 1 : /^wk/.test(unit) ? 7 : /^mo/.test(unit) ? 30.4375 : 365.2425);
        const ms = now - ageDays * 86400000;
        return { iso: new Date(ms).toISOString(), dateMs: ms, precision: 'relative-estimate', raw: raw, ageDays: ageDays, relativeLabel: 'approximately ' + raw };
    }
    return null;
}

function extractEventDate(item, title, snippet, nowMs) {
    const structured = item.eventDate || item.event_date || item.incidentDate || item.incident_date ||
        item.occurredAt || item.occurred_at || item.eventTimestamp || item.incident_timestamp || null;
    if (structured) {
        const parsed = parseDateValue(structured, nowMs);
        if (parsed) return { ...parsed, status: parsed.precision === 'relative-estimate' ? 'relative-event-date-estimate' : 'event-date-field-from-search-result' };
    }
    const text = String(title || '') + ' ' + String(snippet || '');
    const month = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)';
    const date = '(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+' + month + '\\s+\\d{4}|' + month + '\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{4})';
    const re = new RegExp('(?:occurred|happened|took place|was reported to have occurred|terjadi|berlangsung|kejadian pada|insiden pada)\\s+(?:on|at|pada(?: tanggal)?)?\\s*(' + date + ')', 'i');
    const match = text.match(re);
    if (match) {
        const parsed = parseDateValue(match[1], nowMs);
        if (parsed) return { ...parsed, status: 'event-date-mentioned-in-summary' };
    }
    return null;
}

function formatAgeLabel(ageDays, basis, publicationPrecision) {
    if (!Number.isFinite(ageDays)) return 'Date unconfirmed';
    const days = Math.max(0, ageDays);
    if (basis === 'event-date') return 'Event date supplied; approximately ' + (days < 1 ? 'today' : days < 30 ? Math.round(days) + ' days ago' : days < 365.2425 ? Math.round(days / 30.4375) + ' months ago' : (days / 365.2425).toFixed(1) + ' years ago');
    if (publicationPrecision === 'relative-estimate') return 'Publication age estimated from relative source wording; event date unconfirmed';
    return 'Article published ' + (days < 1 ? 'today' : days < 30 ? Math.round(days) + ' days ago' : days < 365.2425 ? Math.round(days / 30.4375) + ' months ago' : (days / 365.2425).toFixed(1) + ' years ago') + '; event date unconfirmed';
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
        const cacheKey = new Request(url.origin + '/_cache/nearby-intel-v2?lat=' + lat + '&lng=' + lng + '&slot=' + timeBucket);
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

        const localityTerms = getLocalitySearchTerms(locality);
        const baseQuery = 'Find specific public-safety incidents that explicitly happened in ' + locality + ' in Indonesia. Search Indonesian and English-language local reporting using terms including pembunuhan, pemerkosaan, kekerasan seksual, kerusuhan, bentrokan, tawuran, tewas, meninggal dunia, pencopetan, penjambretan, perampokan, pencurian ponsel, penipuan, scam, skimming kartu, kecelakaan lalu lintas, banjir, kebakaran, murder, homicide, sexual assault, riot, fatal clash, pickpocketing, robbery, scam, card fraud and road accident. Prefer official police, courts, local government, emergency services, and established Indonesian newsrooms. Only return articles that explicitly mention ' + locality + ' or its municipality name and describe an incident in that locality. Do not return generic crime-statistics pages, research/reference pages, incidents in other countries, or national/global trends not tied to the searched city. Include source links, dates, reported location and status when available. Distinguish alleged, reported, investigated, charged, and confirmed outcomes. Do not infer a specific person or address is involved, and do not invent events.';
        const timeWindows = [
            { label: 'recent-30-days', query: 'published or occurred within the last 30 days', maxAgeDays: 30 },
            { label: 'history-30-days-to-2-years', query: 'published or occurred from 30 days ago up to 2 years ago', maxAgeDays: 730 },
            { label: 'history-2-to-5-years', query: 'published or occurred from 2 years ago up to 5 years ago', maxAgeDays: 1826 }
        ];

        try {
            const gathered = [];
            const seen = new Set();
            let successfulSearches = 0;
            let rawResultCount = 0;
            let rejectedNonLocalCount = 0;
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
                const rawRows = extractResults(payload);
                rawResultCount += rawRows.length;
                rawRows.forEach(function (item) {
                    const targetUrl = item.url || item.link || item.href || '';
                    if (!/^https?:\/\//i.test(targetUrl)) return;
                    if (!isLocalIncidentResult(item, localityTerms)) {
                        rejectedNonLocalCount += 1;
                        return;
                    }
                    const key = targetUrl.toLowerCase();
                    if (seen.has(key)) return;

                    const title = String(item.title || item.name || 'Local public-safety report');
                    const snippet = String(item.snippet || item.description || item.content || '');
                    const text = (title + ' ' + snippet).toLowerCase();
                    let category = 'public_safety';
                    if (/rape|sexual assault|sexual violence|molest|sexual harassment|pemerkosaan|perkosaan|kekerasan seksual|pelecehan seksual|pencabulan/.test(text)) category = 'sexual_violence';
                    else if (/murder|homicide|killed|fatal stabbing|fatal shooting|fatal clash|pembunuhan|korban tewas|meninggal dunia|tewas dalam/.test(text)) category = 'homicide_or_fatality';
                    else if (/riot|unrest|mob violence|clash|communal violence|kerusuhan|tawuran|bentrokan|bentrok|ricuh/.test(text)) category = 'unrest';
                    else if (/pickpocket|snatch|theft|robbery|burglary|stolen phone|pencopetan|copet|penjambretan|jambret|perampokan|pencurian|begal|curanmor/.test(text)) category = 'theft';
                    else if (/scam|fraud|card skimming|carding|phishing|penipuan|skimming|investasi bodong|penipuan online/.test(text)) category = 'scam_or_fraud';
                    else if (/accident|crash|collision|hit-and-run|kecelakaan lalu lintas|laka lantas|tabrakan|kecelakaan beruntun/.test(text)) category = 'road_accident';
                    else if (/flood|inundation|landslide|earthquake|volcan|banjir|tanah longsor|gempa bumi|gunung meletus|kebakaran/.test(text)) category = 'disaster';

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
                filterVersion: 2, rawResultCount: rawResultCount,
                rejectedNonLocalCount: rejectedNonLocalCount,
                recentResults: recentResults.slice(0, 8),
                mediumTermResults: mediumTermResults.slice(0, 8),
                longTermResults: longTermResults.slice(0, 8),
                historicalResults: mediumTermResults.concat(longTermResults).slice(0, 16),
                undatedResults: undatedResults.slice(0, 8),
                results: recentResults.concat(mediumTermResults, longTermResults, undatedResults).slice(0, 30),
                note: 'Only results mentioning the searched city are retained; generic foreign crime-statistics pages are filtered out. TinyFish search/media leads are not independently verified and are not precisely geolocated. Publication dates may differ from incident dates. Verify original sources; historical reports do not imply current danger.'
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
