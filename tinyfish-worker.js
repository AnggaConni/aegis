/**
 * CivilAegis TinyFish local-news proxy.
 * Search results are awareness leads, not independently verified incident reports.
 * Endpoint: GET /nearby-intel?lat=-6.2&lng=106.8
 */
const DEFAULT_ALLOWED_ORIGINS = 'https://anggaconni.github.io';
const DAY_MS = 86400000;
const FIVE_YEARS_DAYS = 1826.25;

function jsonResponse(body, status, origin) {
    return new Response(JSON.stringify(body), {
        status: status || 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': origin || 'null',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Vary': 'Origin'
        }
    });
}

function extractResults(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.results)) return payload.results;
    if (payload && payload.data && Array.isArray(payload.data.results)) return payload.data.results;
    if (payload && Array.isArray(payload.items)) return payload.items;
    if (payload && Array.isArray(payload.organic_results)) return payload.organic_results;
    return [];
}

function normalize(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getLocality(address, fallback) {
    address = address || {};
    const municipality = address.city || address.town || address.municipality ||
        address.county || address.city_municipality || address.state_district || '';
    const region = address.state || address.province || '';
    const unique = [];
    [municipality, region, 'Indonesia'].filter(Boolean).forEach(value => {
        if (!unique.includes(value)) unique.push(value);
    });
    return unique.length > 1 ? unique.join(', ') : (municipality || region || fallback) + ', Indonesia';
}

function getLocalitySearchTerms(locality) {
    const firstPart = String(locality || '').split(',')[0].trim();
    const municipality = firstPart
        .replace(/^daerah khusus ibukota\s+/i, '')
        .replace(/^daerah istimewa\s+/i, '')
        .replace(/^(kota administrasi|kabupaten administrasi|kota|kabupaten|regency|municipality|city of|city|kab\.?|kot\.?|dki)\s+/i, '')
        .trim();
    return Array.from(new Set([municipality, firstPart].map(normalize).filter(value => value.length >= 4)))
        .sort((a, b) => b.length - a.length);
}

function assessIncidentLocation(item, localityTerms) {
    const title = String(item.title || item.name || '');
    const snippet = String(item.snippet || item.description || item.content || '');
    const url = String(item.url || item.link || item.href || '');
    const contentText = title + ' ' + snippet;
    const normalizedContent = normalize(contentText);
    const normalizedUrl = normalize(url);
    if (!localityTerms.length) return { accepted: false, reason: 'no-locality-term' };

    const matchedTerm = localityTerms.find(term => normalizedContent.includes(term));
    if (!matchedTerm) {
        return {
            accepted: false,
            reason: localityTerms.some(term => normalizedUrl.includes(term)) ? 'city-in-url-only' : 'no-city-mention'
        };
    }

    const allText = title + ' ' + snippet + ' ' + url;
    const genericReference = /(crime statistics|violent crime rate|crime data explorer|crime in the united states|uniform crime reporting|annual crime figures|crime statistics by state|research starters|topic pages table)/i.test(allText);
    const foreignGenericDomain = /(ucr\.fbi\.gov|bjs\.ojp\.gov|cde\.ucr\.cjis\.gov|suffolkpd\.org|osc\.ny\.gov|crimeindex\.org|ebsco\.com|wikipedia\.org)/i.test(url);
    if (genericReference || foreignGenericDomain) return { accepted: false, reason: 'generic-or-foreign-reference' };

    const nationalScale = /(nationwide|across indonesia|throughout indonesia|across the country|across the archipelago|several provinces|multiple provinces|multiple cities|nationwide unrest|nationwide protests|di seluruh indonesia|lintas provinsi|sejumlah daerah|berbagai daerah|kerusuhan nasional)/i.test(allText);
    const city = localityTerms.find(term => !term.startsWith('daerah khusus ibukota')) || matchedTerm;
    const escapedCity = city.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const explicitLocalContext = new RegExp(
        '(?:\\b(?:in|at|near|around|within|across|di|ke|dari|sekitar|wilayah|kawasan)\\s+(?:the\\s+)?' + escapedCity + '\\b|' +
        '\\b' + escapedCity + '\\s+(?:attacks?|murders?|homicides?|rapes?|robberies|riots?|clashes|protests?|floods?|fires?|accidents?|pickpocketing|snatching|crime|kerusuhan|pembunuhan|pemerkosaan|pencopetan|penjambretan|kecelakaan|banjir|kebakaran)\\b)',
        'i'
    ).test(contentText);

    const scope = nationalScale && !explicitLocalContext
        ? 'national-context'
        : explicitLocalContext
            ? 'city-mentioned-location-unverified'
            : 'city-mentioned-context-unclear';
    const status = scope === 'national-context'
        ? 'National or multi-location report; the city is mentioned but exact incident locations are not confirmed.'
        : scope === 'city-mentioned-location-unverified'
            ? 'The city is linked to the incident in the text; exact incident location has not been independently confirmed.'
            : 'The city is mentioned in the article, but the event location is unclear.';
    return { accepted: true, reason: 'city-mentioned', scope: scope, status: status, matchedTerm: matchedTerm };
}

function parseDateValue(value, nowMs) {
    if (value === null || value === undefined || value === '') return null;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();

    if (typeof value === 'number' && Number.isFinite(value)) {
        const ms = value > 100000000000 ? value : value * 1000;
        if (ms > 0 && ms <= now + DAY_MS) return { iso: new Date(ms).toISOString(), dateMs: ms, precision: 'absolute-timestamp', raw: value };
    }

    const raw = String(value).trim();
    const relativeText = raw.toLowerCase();
    if (/\b(today|just now|moments ago)\b/.test(relativeText)) {
        return { iso: new Date(now).toISOString(), dateMs: now, precision: 'relative-estimate', ageDays: 0, raw: raw, relativeLabel: 'approximately today' };
    }
    if (/\byesterday\b/.test(relativeText)) {
        const ms = now - DAY_MS;
        return { iso: new Date(ms).toISOString(), dateMs: ms, precision: 'relative-estimate', ageDays: 1, raw: raw, relativeLabel: 'approximately 1 day ago' };
    }

    const relative = relativeText.match(/\b(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?)\s+ago\b/);
    const abbreviated = relativeText.match(/\b(\d+(?:\.\d+)?)\s*(d|wk|wks|mo|yr|yrs)\s*ago\b/);
    const match = relative || abbreviated;
    if (match) {
        const amount = Number(match[1]);
        const unit = match[2];
        const multiplier = /^min|^minute/.test(unit) ? 1 / 1440
            : /^hour|^hr/.test(unit) ? 1 / 24
            : /^day|^d$/.test(unit) ? 1
            : /^week|^wk/.test(unit) ? 7
            : /^month|^mo/.test(unit) ? 30.4375
            : 365.2425;
        const ageDays = amount * multiplier;
        const ms = now - ageDays * DAY_MS;
        return { iso: new Date(ms).toISOString(), dateMs: ms, precision: 'relative-estimate', ageDays: ageDays, raw: raw, relativeLabel: 'approximately ' + raw };
    }

    const monthNumbers = {
        january: 0, januari: 0, february: 1, februari: 1, march: 2, maret: 2, april: 3,
        may: 4, mei: 4, june: 5, juni: 5, july: 6, juli: 6, august: 7, agustus: 7,
        september: 8, october: 9, oktober: 9, november: 10, december: 11, desember: 11
    };
    const monthAlternation = 'January|February|March|April|May|June|July|August|September|October|November|December|Januari|Februari|Maret|Mei|Juni|Juli|Agustus|Oktober|Desember';

    const yearOnly = raw.match(/^(19|20)\d{2}$/);
    if (yearOnly) {
        const yearMs = Date.UTC(Number(raw), 0, 1);
        return { iso: new Date(yearMs).toISOString(), dateMs: yearMs, precision: 'year-only-estimate', raw: raw };
    }
    const isoMonthOnly = raw.match(/^(19|20)\d{2}-(0[1-9]|1[0-2])$/);
    const monthYear = raw.match(new RegExp('^(' + monthAlternation + ')\\s+(\\d{4})$', 'i'));
    if (isoMonthOnly || monthYear) {
        const year = Number(isoMonthOnly ? raw.slice(0, 4) : monthYear[2]);
        const month = isoMonthOnly ? Number(isoMonthOnly[2]) - 1 : monthNumbers[monthYear[1].toLowerCase()];
        if (month !== undefined) {
            const monthMs = Date.UTC(year, month, 1);
            return { iso: new Date(monthMs).toISOString(), dateMs: monthMs, precision: 'month-only-estimate', raw: raw };
        }
    }

    const dayFirst = raw.match(new RegExp('^(\\d{1,2})\\s+(' + monthAlternation + ')\\s+(\\d{4})$', 'i'));
    const monthFirst = raw.match(new RegExp('^(' + monthAlternation + ')\\s+(\\d{1,2}),?\\s+(\\d{4})$', 'i'));
    if (dayFirst || monthFirst) {
        const m = dayFirst || monthFirst;
        const day = Number(dayFirst ? m[1] : m[2]);
        const monthName = (dayFirst ? m[2] : m[1]).toLowerCase();
        const year = Number(m[3]);
        const month = monthNumbers[monthName];
        if (month !== undefined && day >= 1 && day <= 31) {
            const parsed = new Date(Date.UTC(year, month, day));
            if (parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month && parsed.getUTCDate() === day && parsed.getTime() <= now + DAY_MS) {
                return { iso: parsed.toISOString(), dateMs: parsed.getTime(), precision: 'absolute-date', raw: raw };
            }
        }
    }

    // Numeric slash dates are ambiguous when both day and month are 12 or below; do not guess.
    const numericDate = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (numericDate) {
        const first = Number(numericDate[1]);
        const second = Number(numericDate[2]);
        const year = Number(numericDate[3]);
        let day, month;
        if (first > 12 && second <= 12) { day = first; month = second - 1; }
        else if (second > 12 && first <= 12) { day = second; month = first - 1; }
        else return null;
        const parsed = new Date(Date.UTC(year, month, day));
        if (parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month && parsed.getUTCDate() === day && parsed.getTime() <= now + DAY_MS) {
            return { iso: parsed.toISOString(), dateMs: parsed.getTime(), precision: 'absolute-date', raw: raw };
        }
    }

    const absoluteMs = Date.parse(raw);
    if (raw && Number.isFinite(absoluteMs) && absoluteMs > 0 && absoluteMs <= now + DAY_MS) {
        return { iso: new Date(absoluteMs).toISOString(), dateMs: absoluteMs, precision: 'absolute-date', raw: raw };
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
    const month = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Januari|Februari|Maret|Mei|Juni|Juli|Agustus|Oktober|Desember)';
    const date = '(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+' + month + '\\s+\\d{4}|' + month + '\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{4})';
    const cue = '(?:occurred|happened|took place|was reported to have occurred|terjadi|berlangsung|kejadian(?: terjadi| pada)?|peristiwa terjadi|insiden terjadi)\\s+(?:on|at|pada(?: tanggal)?)?\\s*(' + date + ')';
    const match = text.match(new RegExp(cue, 'i'));
    if (match) {
        const parsed = parseDateValue(match[1], nowMs);
        if (parsed) return { ...parsed, status: parsed.precision === 'relative-estimate' ? 'relative-event-date-estimate' : 'event-date-mentioned-in-summary' };
    }
    return null;
}

function makeAgeLabel(ageDays, basis, publicationParsed, eventParsed) {
    if (!Number.isFinite(ageDays)) return 'Date unconfirmed';
    const days = Math.max(0, ageDays);
    const ago = days < 1 ? 'today' : days < 30 ? Math.round(days) + ' days ago'
        : days < 365.2425 ? Math.round(days / 30.4375) + ' months ago'
        : (days / 365.2425).toFixed(1) + ' years ago';
    if (basis === 'event-date') {
        if (eventParsed && eventParsed.precision !== 'absolute-date' && eventParsed.precision !== 'absolute-timestamp') {
            return 'Event age is approximate from source wording/date precision; verify original source';
        }
        return 'Event date stated in result; approximately ' + ago + ' · verify original source';
    }
    if (publicationParsed && publicationParsed.precision === 'relative-estimate') {
        return 'Article appears published ' + (publicationParsed.relativeLabel || 'at a relative time') + '; event date unconfirmed';
    }
    if (publicationParsed && (publicationParsed.precision === 'month-only-estimate' || publicationParsed.precision === 'year-only-estimate')) {
        return 'Article date is approximate (' + publicationParsed.raw + '); event date unconfirmed';
    }
    return 'Article published ' + ago + '; event date unconfirmed';
}

function bucketForAge(ageDays) {
    if (!Number.isFinite(ageDays) || ageDays < 0) return 'undated';
    if (ageDays <= 30) return 'recent-30-days';
    if (ageDays <= 730.5) return 'history-30-days-to-2-years';
    if (ageDays <= FIVE_YEARS_DAYS) return 'history-2-to-5-years';
    return 'outside-5-year-window';
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin') || '';
        const allowedOrigins = String(env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS).split(',').map(value => value.trim()).filter(Boolean);
        const isAllowedOrigin = !origin || allowedOrigins.includes(origin);
        const corsOrigin = origin && isAllowedOrigin ? origin : allowedOrigins[0];

        if (!isAllowedOrigin) return jsonResponse({ error: 'Origin not allowed' }, 403, 'null');
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: {
                'Access-Control-Allow-Origin': corsOrigin,
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '86400',
                'Vary': 'Origin'
            }});
        }
        if (request.method !== 'GET') return jsonResponse({ error: 'Use GET' }, 405, corsOrigin);
        if (url.pathname !== '/nearby-intel') return jsonResponse({ error: 'Not found' }, 404, corsOrigin);
        if (!env.TINYFISH_API_KEY) return jsonResponse({ error: 'Worker secret TINYFISH_API_KEY is not configured' }, 503, corsOrigin);

        const rawLat = Number(url.searchParams.get('lat'));
        const rawLng = Number(url.searchParams.get('lng'));
        if (!Number.isFinite(rawLat) || !Number.isFinite(rawLng) || rawLat < -90 || rawLat > 90 || rawLng < -180 || rawLng > 180) {
            return jsonResponse({ error: 'Valid lat and lng query parameters are required' }, 400, corsOrigin);
        }

        const lat = Math.round(rawLat * 100) / 100;
        const lng = Math.round(rawLng * 100) / 100;
        const timeBucket = Math.floor(Date.now() / (15 * 60 * 1000));
        const cacheKey = new Request(url.origin + '/_cache/nearby-intel-v4?lat=' + lat + '&lng=' + lng + '&slot=' + timeBucket);
        const cache = caches.default;
        try {
            const cached = await cache.match(cacheKey);
            if (cached) return jsonResponse(await cached.json(), 200, corsOrigin);
        } catch (_) {}

        let locality = lat.toFixed(2) + ', ' + lng.toFixed(2);
        try {
            const reverseUrl = new URL('https://nominatim.openstreetmap.org/reverse');
            reverseUrl.searchParams.set('format', 'jsonv2');
            reverseUrl.searchParams.set('lat', String(lat));
            reverseUrl.searchParams.set('lon', String(lng));
            reverseUrl.searchParams.set('zoom', '10');
            reverseUrl.searchParams.set('addressdetails', '1');
            const reverseResponse = await fetch(reverseUrl.toString(), {
                headers: { 'Accept': 'application/json', 'User-Agent': 'CivilAegisSafetyRadar/1.0' }
            });
            if (reverseResponse.ok) {
                const reversePayload = await reverseResponse.json();
                locality = getLocality(reversePayload.address, locality);
            }
        } catch (_) {}

        const localityTerms = getLocalitySearchTerms(locality);
        const baseQuery = 'Find specific public-safety incidents reported in or relevant to ' + locality + ', Indonesia. Search Indonesian and English-language local reporting for pembunuhan, pemerkosaan, kekerasan seksual, kerusuhan, bentrokan, tawuran, tewas, meninggal dunia, pencopetan, penjambretan, perampokan, pencurian ponsel, penipuan, scam, skimming kartu, kecelakaan lalu lintas, banjir, kebakaran, murder, homicide, sexual assault, rape, riot, fatal clash, pickpocketing, robbery, scam, card fraud, road accident and other public-safety events. Prefer official police, courts, local government, emergency services, and established Indonesian newsrooms. Include separate publication date and incident/event date if available, the reported location, fatalities/injuries if reported, and the original source URL. Distinguish a city-specific incident from national/multi-location coverage. Do not return generic crime statistics, research-reference pages, incidents in unrelated countries, or invented events.';

        const timeWindows = [
            { label: 'recent-30-days', query: 'published or occurred within the last 30 days' },
            { label: 'history-30-days-to-2-years', query: 'published or occurred from 30 days ago up to 2 years ago' },
            { label: 'history-2-to-5-years', query: 'published or occurred from 2 years ago up to 5 years ago' }
        ];

        try {
            const gathered = [];
            const seen = new Set();
            let successfulSearches = 0;
            const failedSearchWindows = [];
            let rawResultCount = 0;
            const diagnostics = {
                rejectedNonLocalCount: 0,
                rejectedGenericReferenceCount: 0,
                rejectedNoSourceUrlCount: 0,
                duplicateCount: 0,
                rejectedOutsideFiveYearWindowCount: 0,
                dateUnconfirmedCount: 0,
                relativePublicationDateCount: 0,
                eventDateCount: 0,
                cityMentionCount: 0,
                nationalContextCount: 0
            };
            const nowMs = Date.now();

            for (const window of timeWindows) {
                const scopedQuery = baseQuery + ' Search only for reports ' + window.query +
                    '. This label records the search pass only; do not assume the search window equals the incident date. Return publication and event dates separately if available.';
                const searchUrl = new URL('https://api.search.tinyfish.ai/');
                searchUrl.searchParams.set('query', scopedQuery);
                const searchResponse = await fetch(searchUrl.toString(), {
                    headers: { 'X-API-Key': env.TINYFISH_API_KEY, 'Accept': 'application/json' }
                });
                if (!searchResponse.ok) {
                    failedSearchWindows.push({ window: window.label, status: searchResponse.status });
                    continue;
                }
                successfulSearches += 1;
                const payload = await searchResponse.json();
                const rows = extractResults(payload);
                rawResultCount += rows.length;

                rows.forEach(function (item) {
                    const targetUrl = item.url || item.link || item.href || '';
                    if (!/^https?:\/\//i.test(targetUrl)) {
                        diagnostics.rejectedNoSourceUrlCount += 1;
                        return;
                    }
                    const location = assessIncidentLocation(item, localityTerms);
                    if (!location.accepted) {
                        diagnostics.rejectedNonLocalCount += 1;
                        if (location.reason === 'generic-or-foreign-reference') diagnostics.rejectedGenericReferenceCount += 1;
                        return;
                    }
                    const key = targetUrl.toLowerCase();
                    if (seen.has(key)) {
                        diagnostics.duplicateCount += 1;
                        return;
                    }

                    const title = String(item.title || item.name || 'Local public-safety report');
                    const snippet = String(item.snippet || item.description || item.content || '');
                    const combined = (title + ' ' + snippet).toLowerCase();
                    let category = 'public_safety';
                    if (/rape|sexual assault|sexual violence|molest|sexual harassment|pemerkosaan|perkosaan|kekerasan seksual|pelecehan seksual|pencabulan/.test(combined)) category = 'sexual_violence';
                    else if (/murder|homicide|killed|fatal stabbing|fatal shooting|fatal clash|pembunuhan|korban tewas|meninggal dunia|tewas dalam/.test(combined)) category = 'homicide_or_fatality';
                    else if (/riot|unrest|mob violence|clash|communal violence|kerusuhan|tawuran|bentrokan|bentrok|ricuh/.test(combined)) category = 'unrest';
                    else if (/pickpocket|snatch|theft|robbery|burglary|stolen phone|pencopetan|copet|penjambretan|jambret|perampokan|pencurian|begal|curanmor/.test(combined)) category = 'theft';
                    else if (/scam|fraud|card skimming|carding|phishing|penipuan|skimming|investasi bodong|penipuan online/.test(combined)) category = 'scam_or_fraud';
                    else if (/accident|crash|collision|hit-and-run|kecelakaan lalu lintas|laka lantas|tabrakan|kecelakaan beruntun/.test(combined)) category = 'road_accident';
                    else if (/flood|inundation|landslide|earthquake|volcan|banjir|tanah longsor|gempa bumi|gunung meletus|kebakaran/.test(combined)) category = 'disaster';

                    const publicationRaw = item.publishedAt || item.published_at || item.date || item.pubDate || item.published || null;
                    const publicationParsed = parseDateValue(publicationRaw, nowMs);
                    const eventParsed = extractEventDate(item, title, snippet, nowMs);
                    const publicationAgeDays = publicationParsed ? Math.max(0, (nowMs - publicationParsed.dateMs) / DAY_MS) : null;
                    const eventAgeDays = eventParsed ? Math.max(0, (nowMs - eventParsed.dateMs) / DAY_MS) : null;
                    const timelineAgeDays = eventAgeDays !== null ? eventAgeDays : publicationAgeDays;
                    const timelineBasis = eventAgeDays !== null ? 'event-date' : publicationAgeDays !== null ? 'publication-date-proxy' : 'undated';
                    const timelineBucket = bucketForAge(timelineAgeDays);
                    if (timelineBucket === 'outside-5-year-window') {
                        diagnostics.rejectedOutsideFiveYearWindowCount += 1;
                        continue;
                    }
                    if (timelineBucket === 'undated') diagnostics.dateUnconfirmedCount += 1;
                    if (publicationParsed && publicationParsed.precision === 'relative-estimate') diagnostics.relativePublicationDateCount += 1;
                    if (eventParsed) diagnostics.eventDateCount += 1;
                    diagnostics.cityMentionCount += 1;
                    if (location.scope === 'national-context') diagnostics.nationalContextCount += 1;
                    seen.add(key);

                    let source = '';
                    try { source = new URL(targetUrl).hostname.replace(/^www\./, ''); } catch (_) {}
                    const explicitLocation = item.eventLocation || item.event_location || item.incidentLocation || item.incident_location || null;
                    const publicationDateLabel = publicationParsed
                        ? publicationParsed.precision === 'relative-estimate'
                            ? 'Publication age estimated: ' + (publicationParsed.relativeLabel || 'relative source date') + '; event date unconfirmed'
                            : (publicationParsed.precision === 'month-only-estimate' || publicationParsed.precision === 'year-only-estimate')
                                ? 'Publication date approximate: ' + publicationParsed.raw + '; event date unconfirmed'
                                : 'Article published ' + publicationParsed.iso.slice(0, 10) + '; event date unconfirmed'
                        : 'Publication date unconfirmed';
                    const eventDateLabel = eventParsed
                        ? eventParsed.precision === 'relative-estimate'
                            ? 'Event age estimated from relative source wording; verify'
                            : (eventParsed.precision === 'month-only-estimate' || eventParsed.precision === 'year-only-estimate')
                                ? 'Event date approximate: ' + eventParsed.raw + '; verify original source'
                                : 'Event date supplied or mentioned: ' + eventParsed.iso.slice(0, 10) + '; verify original source'
                        : 'Event date unconfirmed';
                    const timelineLabel = makeAgeLabel(timelineAgeDays, timelineBasis, publicationParsed, eventParsed);
                    gathered.push({
                        id: key,
                        title: title,
                        snippet: snippet,
                        url: targetUrl,
                        source: source || 'TinyFish Search',
                        area: locality,
                        searchArea: locality,
                        radiusType: 'municipality/city/regency',
                        publishedAt: publicationParsed && ['absolute-date', 'absolute-timestamp'].includes(publicationParsed.precision) ? publicationParsed.iso : null,
                        publishedAtRaw: publicationRaw === null ? null : String(publicationRaw),
                        publicationDateLabel: publicationDateLabel,
                        publicationDatePrecision: publicationParsed ? publicationParsed.precision : 'unconfirmed',
                        publicationAgeDays: publicationAgeDays,
                        eventDate: eventParsed ? eventParsed.iso : null,
                        eventDatePrecision: eventParsed ? eventParsed.precision : 'unconfirmed',
                        eventDateStatus: eventParsed ? eventParsed.status : 'event-date-unconfirmed',
                        eventDateLabel: eventDateLabel,
                        eventAgeDays: eventAgeDays,
                        ageYears: timelineAgeDays === null ? null : timelineAgeDays / 365.2425,
                        timelineAgeDays: timelineAgeDays,
                        timelineBasis: timelineBasis,
                        timelineBucket: timelineBucket,
                        timelineLabel: timelineLabel,
                        recencyLabel: timelineLabel,
                        dateStatus: eventParsed ? eventParsed.status : publicationParsed ? 'Publication date parsed; event date unconfirmed' : 'Publication and event dates unconfirmed',
                        searchWindow: window.label,
                        category: category,
                        eventLocation: explicitLocation ? String(explicitLocation) : null,
                        eventLocationScope: location.scope,
                        eventLocationStatus: location.status,
                        locationEvidence: location.reason,
                        verified: false
                    });
                });
            }

            const recentResults = [];
            const mediumTermResults = [];
            const longTermResults = [];
            const undatedResults = [];
            gathered.forEach(function (item) {
                if (item.timelineBucket === 'recent-30-days') recentResults.push(item);
                else if (item.timelineBucket === 'history-30-days-to-2-years') mediumTermResults.push(item);
                else if (item.timelineBucket === 'history-2-to-5-years') longTermResults.push(item);
                else if (item.timelineBucket === 'undated') undatedResults.push(item);
            });

            const responseBody = {
                area: locality,
                searchArea: locality,
                radiusType: 'municipality/city/regency',
                generatedAt: new Date().toISOString(),
                successfulSearches: successfulSearches,
                failedSearchWindows: failedSearchWindows,
                filterVersion: 3,
                rawResultCount: rawResultCount,
                diagnostics: diagnostics,
                recentResults: recentResults.slice(0, 8),
                mediumTermResults: mediumTermResults.slice(0, 8),
                longTermResults: longTermResults.slice(0, 8),
                historicalResults: mediumTermResults.concat(longTermResults).slice(0, 16),
                undatedResults: undatedResults.slice(0, 8),
                results: recentResults.concat(mediumTermResults, longTermResults, undatedResults).slice(0, 30),
                note: 'Event and publication dates are separate. If only publication age is known, the timeline bucket describes the article date, not the event date. City mention is not precise geolocation. TinyFish results are unverified search leads; check original sources before making safety decisions.'
            };
            if (!successfulSearches) {
                return jsonResponse({ error: 'TinyFish Search did not return successful time-window searches', area: locality, results: [], successfulSearches: 0, filterVersion: 3, diagnostics: diagnostics }, 502, corsOrigin);
            }
            try {
                const cacheResponse = new Response(JSON.stringify(responseBody), {
                    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=900' }
                });
                ctx.waitUntil(cache.put(cacheKey, cacheResponse));
            } catch (_) {}
            return jsonResponse(responseBody, 200, corsOrigin);
        } catch (error) {
            return jsonResponse({ error: 'Unable to retrieve local web signals from TinyFish', detail: String(error && error.message || error), area: locality, results: [] }, 502, corsOrigin);
        }
    }
};