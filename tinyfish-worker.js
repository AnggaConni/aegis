/**
 * CivilAegis TinyFish local-news proxy.
 * Search results are awareness leads, not independently verified incident reports.
 * Endpoint: GET /nearby-intel?lat=-6.2&lng=106.8
 */
const DEFAULT_ALLOWED_ORIGINS = 'https://anggaconni.github.io';
const DAY_MS = 86400000;
const FIVE_YEARS_DAYS = 1826.25;

// Best-effort per-isolate guard. Cloudflare may run several isolates/regions, so this
// is defence-in-depth, not a globally atomic quota. The Worker cache reduces repeat
// TinyFish usage; strict global quotas require an external rate-limit primitive.
const CLIENT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const CLIENT_RATE_LIMIT_MAX = 6;
const clientRequestTimes = new Map();

function isClientRateLimited(request, nowMs = Date.now()) {
    const clientIp = request.headers.get('CF-Connecting-IP');
    if (!clientIp) return false; // Local tests/non-Cloudflare runtimes have no trusted client IP.
    const recent = (clientRequestTimes.get(clientIp) || [])
        .filter(timestamp => nowMs - timestamp < CLIENT_RATE_LIMIT_WINDOW_MS);
    if (recent.length >= CLIENT_RATE_LIMIT_MAX) {
        clientRequestTimes.set(clientIp, recent);
        return true;
    }
    recent.push(nowMs);
    clientRequestTimes.set(clientIp, recent);
    // Bound isolate memory when many distinct clients hit the endpoint.
    if (clientRequestTimes.size > 5000) {
        for (const [ip, timestamps] of clientRequestTimes.entries()) {
            if (!timestamps.some(timestamp => nowMs - timestamp < CLIENT_RATE_LIMIT_WINDOW_MS)) {
                clientRequestTimes.delete(ip);
            }
        }
    }
    return false;
}

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

function canonicalizeSourceUrl(raw) {
    try {
        const parsed = new URL(raw);
        let host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        parsed.hash = '';

        // Normalize common video URL variants without lowercasing case-sensitive video IDs.
        if (host === 'youtu.be') {
            const videoId = parsed.pathname.split('/').filter(Boolean)[0];
            if (videoId) return 'youtube.com/watch?v=' + videoId;
        }
        if ((host === 'youtube.com' || host === 'm.youtube.com') && parsed.pathname === '/watch' && parsed.searchParams.get('v')) {
            return 'youtube.com/watch?v=' + parsed.searchParams.get('v');
        }

        const trackingParams = /^(utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid|ref_src|ref_url)$/i;
        for (const key of Array.from(parsed.searchParams.keys())) {
            if (trackingParams.test(key)) parsed.searchParams.delete(key);
        }
        const params = Array.from(parsed.searchParams.entries())
            .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
        const query = new URLSearchParams();
        params.forEach(([key, value]) => query.append(key, value));
        const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
        return host + pathname + (query.toString() ? '?' + query.toString() : '');
    } catch (_) {
        return String(raw || '').trim();
    }
}

function makeContentFingerprint(title, snippet) {
    const normalizedTitle = normalize(title);
    const normalizedSnippet = normalize(snippet);
    if (normalizedTitle.length < 12 || normalizedSnippet.length < 24) return '';
    return normalizedTitle.slice(0, 180) + '|' + normalizedSnippet.slice(0, 220);
}

function resultQualityScore(result) {
    let score = 0;
    if (result.eventDate) {
        score += ['absolute-date', 'absolute-timestamp'].includes(result.eventDatePrecision) ? 8
            : result.eventDatePrecision === 'relative-estimate' ? 5 : 4;
    }
    if (result.publishedAt || result.publishedAtRaw) {
        score += ['absolute-date', 'absolute-timestamp'].includes(result.publicationDatePrecision) ? 4
            : result.publishedAtRaw ? 2 : 1;
    }
    if (result.eventLocation) score += 1;
    if (/\.(?:gov|mil)(?:\.|$)|(?:^|\.)go\.id$|polri\.go\.id$/i.test(result.source || '')) score += 0.5;
    return score;
}

function getLocality(address, fallback) {
    address = address || {};
    const municipality = address.city || address.town || address.municipality ||
        address.county || address.city_municipality || address.state_district || '';
    const region = address.state || address.province || address.region || '';
    const country = address.country || '';
    const unique = [];
    [municipality, region, country].filter(Boolean).forEach(value => {
        const clean = String(value).trim();
        if (clean && !unique.some(existing => normalize(existing) === normalize(clean))) unique.push(clean);
    });
    // Use the actual reverse-geocoded country. Never silently label an unknown location as Indonesia.
    return unique.length ? unique.join(', ') : String(fallback || 'Unknown area');
}

function getLocalitySearchTerms(locality) {
    const parts = String(locality || '').split(',').map(value => value.trim()).filter(Boolean);
    const cleanedParts = parts.map(part => part
        .replace(/^daerah khusus ibukota\s+/i, '')
        .replace(/^daerah istimewa\s+/i, '')
        .replace(/^(kota administrasi|kabupaten administrasi|kota|kabupaten|regency|municipality|city of|city|kab\.?|kot\.?|dki)\s+/i, '')
        .trim());
    // Preserve most-specific-first order while retaining region and country names for
    // national risk/prevalence material that may not mention the user's city.
    return Array.from(new Set(cleanedParts.concat(parts).map(normalize).filter(value => value.length >= 3)));
}

function isStructuralRiskContext(title, snippet) {
    const raw = String(title || '') + ' ' + String(snippet || '');
    const text = normalize(raw);
    const hasEvidenceFrame = /\b(prevalence|survey|studies|study|research|risk assessment|victimization|victimisation|lifetime experience|ever experienced|incidence rate|population based|national sample|women and girls|percentage|percent|per cent|rate of|proportion of|prevalensi|survei|penelitian|riset|pernah mengalami|angka kejadian|tingkat risiko)\b/.test(text) ||
        /\b\d+(?:\.\d+)?\s*%/.test(raw);
    return hasEvidenceFrame && classifyIncident(title, snippet).category !== 'public_safety';
}

function assessIncidentLocation(item, localityTerms, locality) {
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
    const structuralRiskContext = isStructuralRiskContext(title, snippet);
    const genericReference = /(crime statistics|violent crime rate|crime data explorer|crime in the united states|uniform crime reporting|annual crime figures|crime statistics by state|research starters|topic pages table)/i.test(allText);
    const genericCrimeOverview = /(crime overview|crime rate|murder rate|homicide rate|homicides? per 100,?000|criminality statistics|crime index|crime data by country)/i.test(title + ' ' + snippet);
    const genericCrimeCoverage = /(crime wave|crime roundup|crime trends?|criminality overview|crime documentary|crime compilation|crime situation|anti-crime crackdown|campaign against (?:violent )?crime|police.{0,30}campaign against|new police.{0,25}campaign|recurring street crime)/i.test(title + ' ' + snippet);
    const specificIncidentSignal = /\b(arrest(?:ed|s)?|detain(?:ed|s)?|occurred|happened|took place|attacked|assaulted|was killed|were killed|died|dead after|fatal clash|bomb blasts?|explosions?|robbed|stole|was raped|was stabbed|was run over|menewaskan|tewas|ditangkap|terjadi|dianiaya|dibunuh|dibacok|dirampok|kecelakaan|named victim|suspect charged|police confirmed the incident)\b/i.test(title + ' ' + snippet);
    const foreignGenericDomain = /(ucr\.fbi\.gov|bjs\.ojp\.gov|cde\.ucr\.cjis\.gov|suffolkpd\.org|osc\.ny\.gov|crimeindex\.org|ebsco\.com|wikipedia\.org)/i.test(url);
    // Exclude broad crime roundups, but preserve geographically relevant prevalence studies
    // and risk assessments as a separate evidence class.
    if (foreignGenericDomain || ((genericReference || genericCrimeOverview || genericCrimeCoverage) &&
        !specificIncidentSignal && !structuralRiskContext)) {
        return { accepted: false, reason: 'generic-or-foreign-reference' };
    }

    const nationalScale = /(nationwide|across the country|throughout the country|nationally|nationwide unrest|nationwide protests|multiple provinces|multiple cities|across the region|across the nation)/i.test(allText);
    const localityParts = String(locality || '').split(',').map(value => normalize(value)).filter(Boolean);
    const countryTerm = localityParts.length ? localityParts[localityParts.length - 1] : '';
    const countryContext = !!countryTerm && matchedTerm === countryTerm &&
        !localityTerms.slice(0, -1).some(term => normalizedContent.includes(term));
    const city = localityTerms[0] || matchedTerm;
    const escapedCity = city.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const explicitLocalContext = new RegExp(
        '(?:\\b(?:in|at|near|around|within|across|di|ke|dari|sekitar|wilayah|kawasan)\\s+(?:the\\s+)?#?' + escapedCity + '\\b|' +
        '\\b' + escapedCity + '(?:\\s*[:,-]\\s*|\\s+)(?:at least \\d+ (?:people )?(?:dead|killed)|attacks?|murders?|homicides?|rapes?|robberies|riots?|clashes|protests?|blasts?|explosions?|bombings?|floods?|fires?|accidents?|pickpocketing|snatching|crime|kerusuhan|pembunuhan|pemerkosaan|pencopetan|penjambretan|kecelakaan|ledakan|pengeboman|banjir|kebakaran)\\b)',
        'i'
    ).test(contentText);

    const scope = countryContext
        ? 'country-context'
        : nationalScale && !explicitLocalContext
            ? 'national-context'
            : explicitLocalContext
                ? 'city-mentioned-location-unverified'
                : 'city-mentioned-context-unclear';
    const status = scope === 'country-context'
        ? 'Country-level context; this does not confirm an incident at the user's exact location.'
        : scope === 'national-context'
            ? 'National or multi-location report; exact incident locations are not confirmed.'
            : scope === 'city-mentioned-location-unverified'
                ? 'The locality is linked to the incident in the text; exact incident location has not been independently confirmed.'
                : 'The locality is mentioned in the article, but the event location is unclear.';
    return {
        accepted: true,
        reason: structuralRiskContext ? 'structural-risk-context' : 'location-mentioned',
        scope: scope,
        status: status,
        matchedTerm: matchedTerm,
        evidenceType: structuralRiskContext ? 'structural-risk' : 'incident'
    };
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

    const relative = relativeText.match(/\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?)\s+ago\b/);
    const abbreviated = relativeText.match(/\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*(d|wk|wks|mo|yr|yrs)\s*ago\b/);
    const match = relative || abbreviated;
    if (match) {
        const wordNumbers = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
        const amountToken = String(match[1]).toLowerCase();
        const amount = Number.isFinite(Number(amountToken)) ? Number(amountToken) : wordNumbers[amountToken];
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
        const yearMs = Date.UTC(Number(raw), 6, 1);
        if (yearMs <= now + DAY_MS) {
            return { iso: new Date(yearMs).toISOString(), dateMs: yearMs, precision: 'year-only-estimate', raw: raw };
        }
        return null;
    }
    const isoMonthOnly = raw.match(/^(19|20)\d{2}-(0[1-9]|1[0-2])$/);
    const monthYear = raw.match(new RegExp('^(' + monthAlternation + ')\\s+(\\d{4})$', 'i'));
    if (isoMonthOnly || monthYear) {
        const year = Number(isoMonthOnly ? raw.slice(0, 4) : monthYear[2]);
        const month = isoMonthOnly ? Number(isoMonthOnly[2]) - 1 : monthNumbers[monthYear[1].toLowerCase()];
        if (month !== undefined) {
            const monthMs = Date.UTC(year, month, 15);
            if (monthMs <= now + DAY_MS) {
                return { iso: new Date(monthMs).toISOString(), dateMs: monthMs, precision: 'month-only-estimate', raw: raw };
            }
            return null;
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

function resolveWeekdayRelativeToPublication(weekdayName, publicationAnchor) {
    if (!publicationAnchor || !Number.isFinite(publicationAnchor.dateMs) ||
        !['absolute-date', 'absolute-timestamp'].includes(publicationAnchor.precision)) return null;
    const weekdays = {
        sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
        thursday: 4, friday: 5, saturday: 6
    };
    const wanted = weekdays[String(weekdayName || '').toLowerCase()];
    if (wanted === undefined) return null;
    const publicationDate = new Date(publicationAnchor.dateMs);
    const diff = (publicationDate.getUTCDay() - wanted + 7) % 7;
    // A same-weekday reference is ambiguous: it could mean today or the previous week.
    if (diff === 0 || diff > 6) return null;
    const dayMs = Date.UTC(publicationDate.getUTCFullYear(), publicationDate.getUTCMonth(), publicationDate.getUTCDate()) - diff * DAY_MS;
    return {
        iso: new Date(dayMs).toISOString(),
        dateMs: dayMs,
        precision: 'relative-estimate',
        raw: String(weekdayName) + ' relative to publication date',
        relativeLabel: 'weekday estimated from the article publication date'
    };
}

function isSeriesStartDateSentence(sentence) {
    const text = String(sentence || '');
    return /\b(?:nationwide\s+)?(?:protests?|demonstrations?|waves?\s+of\s+protests?|movements?|campaigns?|nationwide unrest)\b[^.!?]{0,75}\b(?:began|started|commenced|kicked off|dimulai|bermula)\b/i.test(text);
}

function extractEventDate(item, title, snippet, nowMs, publicationAnchor) {
    const structured = item.eventDate || item.event_date || item.incidentDate || item.incident_date ||
        item.occurredAt || item.occurred_at || item.eventTimestamp || item.incident_timestamp || null;
    if (structured) {
        const parsed = parseDateValue(structured, nowMs);
        if (parsed) {
            const approximate = ['relative-estimate', 'month-only-estimate', 'year-only-estimate'].includes(parsed.precision);
            return {
                ...parsed,
                status: parsed.precision === 'year-only-estimate' ? 'event-year-field-from-search-result'
                    : approximate ? 'approximate-event-date-field-from-search-result'
                    : 'event-date-field-from-search-result'
            };
        }
    }

    const text = String(title || '') + ' ' + String(snippet || '');
    const month = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Januari|Februari|Maret|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)';
    const date = '(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+' + month + '\\s+\\d{4}|' + month + '\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{4}|(?:19|20)\\d{2})';
    const relativeDate = '(?:today|just now|moments ago|yesterday|(?:\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?|d|wk|wks|mo|yr|yrs)\\s+ago)';
    const weekday = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
    const eventWords = '(?:attacks?|bombings?|blasts?|explosions?|explosive device|murders?|homicides?|fatal assaults?|sexual assaults?|rapes?|robberies|thefts?|shootings?|stabbings?|riots?|unrest|clashes?|protests?|floods?|fires?|accidents?|crashes?|landslides?|earthquakes?|kerusuhan|bentrokan|tawuran|ledakan|pengeboman|pembunuhan|pemerkosaan|penjambretan|pencurian|perampokan|kecelakaan|banjir|kebakaran|tanah longsor|tewas|meninggal dunia)';
    const eventAction = '(?:occurred|happened|took place|was reported|was killed|were killed|killed|died|was run over|were run over|run over|was attacked|were attacked|attacked|was shot|were shot|shot|was stabbed|were stabbed|stabbed|was raped|was robbed|robbed|was assaulted|were assaulted|assaulted|was arrested|were arrested|arrested|terjadi|tewas|meninggal|menewaskan|dibunuh|ditabrak|diserang|ditembak|dibacok)';
    const directCue = new RegExp('\\b(?:occurred|happened|took place|was reported to have occurred|incident occurred|event occurred|attack(?:s)? occurred|clash(?:es)? occurred|terjadi|berlangsung|peristiwa terjadi|insiden terjadi|kejadian(?: terjadi| pada)?)\\b[^.!?]{0,24}?\\b(?:on|at|in|during|pada(?: tanggal)?|tanggal)?\\s*(' + date + ')', 'i');
    const actionBeforeDate = new RegExp('\\b' + eventAction + '\\b[^.!?]{0,24}?\\b(?:on|at|in|during|pada(?: tanggal)?|tanggal)\\s+(' + date + ')', 'i');
    const dateBeforeAction = new RegExp('\\b(?:on|pada)\\s+(' + date + ')\\s*,?\\s+[^.!?]{0,100}\\b' + eventAction + '\\b', 'i');
    const eventNearDate = new RegExp('\\b' + eventWords + '\\b[^.!?]{0,45}?\\b(?:on|in|during|pada(?: tanggal)?)\\s+(' + date + ')', 'i');
    const relativeAfterAction = new RegExp('\\b' + eventAction + '\\b[^.!?]{0,35}\\b(' + relativeDate + ')\\b', 'i');
    const relativeBeforeAction = new RegExp('\\b(' + relativeDate + ')\\b[^.!?]{0,80}\\b' + eventAction + '\\b', 'i');
    const weekdayBeforeAction = new RegExp('\\b(?:on|last)\\s+(' + weekday + ')\\b[^.!?]{0,100}\\b' + eventAction + '\\b', 'i');

    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const nonSeriesText = [];
    for (const sentence of sentences) {
        if (isSeriesStartDateSentence(sentence)) continue;
        nonSeriesText.push(sentence);

        const directMatch = sentence.match(directCue);
        const actionMatch = sentence.match(actionBeforeDate);
        const dateLeadMatch = sentence.match(dateBeforeAction);
        const eventMatch = sentence.match(eventNearDate);
        const absoluteMatch = directMatch || actionMatch || dateLeadMatch || eventMatch;
        if (absoluteMatch) {
            const parsed = parseDateValue(absoluteMatch[1], nowMs);
            if (parsed) {
                const approximate = ['relative-estimate', 'month-only-estimate', 'year-only-estimate'].includes(parsed.precision);
                return {
                    ...parsed,
                    status: parsed.precision === 'year-only-estimate' ? 'event-year-mentioned-in-summary'
                        : approximate ? 'approximate-event-date-mentioned-in-summary'
                        : 'event-date-mentioned-in-summary'
                };
            }
        }

        const relativeMatch = sentence.match(relativeAfterAction) || sentence.match(relativeBeforeAction);
        if (relativeMatch) {
            const parsed = parseDateValue(relativeMatch[1], nowMs);
            if (parsed) {
                return {
                    ...parsed,
                    status: parsed.precision === 'relative-estimate'
                        ? 'event-date-relative-wording-in-summary'
                        : 'event-date-mentioned-in-summary'
                };
            }
        }

        const weekdayMatch = sentence.match(weekdayBeforeAction);
        if (weekdayMatch) {
            const anchor = publicationAnchor || parseDateValue(
                item.publishedAt || item.published_at || item.date || item.pubDate || item.published || null,
                nowMs
            );
            const parsed = resolveWeekdayRelativeToPublication(weekdayMatch[1], anchor);
            if (parsed) return { ...parsed, status: 'event-weekday-inferred-from-publication-date' };
        }
    }

    // Year-only estimates remain permitted when the year is tied to a specific event term,
    // but dates in a protest-series start sentence are deliberately excluded.
    const filteredText = nonSeriesText.join(' ');
    const yearBeforeEvent = filteredText.match(new RegExp('\\b((?:19|20)\\d{2})\\b[^.!?]{0,35}\\b' + eventWords + '\\b', 'i'));
    const yearAfterEvent = filteredText.match(new RegExp('\\b' + eventWords + '\\b[^.!?]{0,50}\\b(?:in|during|on|tahun|pada tahun)\\s+((?:19|20)\\d{2})\\b', 'i'));
    const yearMatch = yearBeforeEvent || yearAfterEvent;
    if (yearMatch) {
        const parsed = parseDateValue(yearMatch[1], nowMs);
        if (parsed) return { ...parsed, status: 'event-year-mentioned-in-summary' };
    }
    return null;
}

function decodeHtmlEntities(value) {
    return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, function (_, entity) {
        const key = entity.toLowerCase();
        if (key === 'amp') return '&';
        if (key === 'quot') return '"';
        if (key === 'apos') return "'";
        if (key === 'lt') return '<';
        if (key === 'gt') return '>';
        if (key === 'nbsp') return ' ';
        if (key.startsWith('#x')) {
            const point = parseInt(key.slice(2), 16);
            return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : '';
        }
        if (key.startsWith('#')) {
            const point = parseInt(key.slice(1), 10);
            return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : '';
        }
        return _;
    });
}

function extractAttribute(tag, name) {
    const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let match;
    while ((match = pattern.exec(tag)) !== null) {
        if (match[1].toLowerCase() === name.toLowerCase()) {
            return decodeHtmlEntities(match[2] || match[3] || match[4] || '').trim();
        }
    }
    return '';
}

function isSafePublicHttpUrl(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch (_) { return false; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        host.endsWith('.internal') || host.endsWith('.test') || host.endsWith('.invalid')) return false;

    const octets = host.split('.');
    if (octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
        const [a, b] = octets.map(Number);
        if (a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
    }
    if (host.includes(':')) {
        if (host === '::' || host === '::1' || /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host) || host.startsWith('::ffff:')) return false;
    }
    return true;
}

function htmlToReadableText(html) {
    return decodeHtmlEntities(String(html || '')
        .replace(/<(script|style|noscript|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120000);
}

function extractMetaValue(html, wantedNames) {
    const wanted = new Set(wantedNames.map(value => value.toLowerCase()));
    const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
    for (const tag of tags) {
        const key = (extractAttribute(tag, 'property') || extractAttribute(tag, 'name') ||
            extractAttribute(tag, 'itemprop') || extractAttribute(tag, 'http-equiv')).toLowerCase();
        if (wanted.has(key)) {
            const value = extractAttribute(tag, 'content');
            if (value) return value;
        }
    }
    return '';
}

function collectJsonLdSignals(html) {
    const scripts = String(html || '').match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script\s*>/gi) || [];
    const objects = [];
    for (const script of scripts) {
        const start = script.indexOf('>');
        const end = script.toLowerCase().lastIndexOf('</script');
        if (start < 0 || end <= start) continue;
        const raw = script.slice(start + 1, end).trim().replace(/^<!--|-->$/g, '').trim();
        try {
            const parsed = JSON.parse(raw);
            const visit = value => {
                if (Array.isArray(value)) {
                    value.forEach(visit);
                } else if (value && typeof value === 'object') {
                    objects.push(value);
                    if (value['@graph']) visit(value['@graph']);
                    if (value.mainEntity) visit(value.mainEntity);
                    if (value.mainEntityOfPage && typeof value.mainEntityOfPage === 'object') visit(value.mainEntityOfPage);
                }
            };
            visit(parsed);
        } catch (_) {}
    }

    let publicationRaw = '';
    let eventRaw = '';
    for (const object of objects) {
        const types = (Array.isArray(object['@type']) ? object['@type'] : [object['@type']])
            .filter(Boolean).map(value => String(value).toLowerCase());
        if (!publicationRaw) publicationRaw = object.datePublished || object.dateCreated || object.uploadDate || '';
        if (!eventRaw && types.some(type => /(^|\/)(event|crimeevent|socialevent|publicevent)$/.test(type))) {
            eventRaw = object.startDate || object.endDate || '';
        }
    }
    return { publicationRaw: String(publicationRaw || ''), eventRaw: String(eventRaw || '') };
}

async function fetchPublicHtml(rawUrl) {
    if (!isSafePublicHttpUrl(rawUrl)) return null;
    let url = new URL(rawUrl);
    for (let redirects = 0; redirects <= 3; redirects++) {
        if (!isSafePublicHttpUrl(url.href)) return null;
        let response;
        try {
            response = await fetch(url.href, {
                method: 'GET',
                redirect: 'manual',
                headers: {
                    'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.2',
                    'User-Agent': 'CivilAegisSafetyRadar/1.1 (+https://anggaconni.github.io/aegis/)'
                },
                signal: AbortSignal.timeout(3000)
            });
        } catch (_) {
            return null;
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('Location');
            if (!location || redirects === 3) return null;
            try { url = new URL(location, url); } catch (_) { return null; }
            continue;
        }
        if (!response.ok) return null;
        const contentType = response.headers.get('Content-Type') || '';
        const length = Number(response.headers.get('Content-Length') || 0);
        if (length > 1500000 || (contentType && !/(text\/html|application\/xhtml\+xml)/i.test(contentType))) return null;
        let html = '';
        try { html = await response.text(); } catch (_) { return null; }
        if (!html || html.length > 1800000) return null;
        return { html: html, url: url.href };
    }
    return null;
}

function extractCandidateOriginalUrls(text, sourceUrl) {
    const candidates = [];
    const sourceHost = (() => {
        try { return new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; }
    })();
    const urls = String(text || '').match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
    urls.forEach(raw => {
        const cleaned = raw.replace(/[.,;:!?]+$/g, '');
        if (!isSafePublicHttpUrl(cleaned)) return;
        let host = '';
        try { host = new URL(cleaned).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return; }
        if (host === sourceHost) return;
        if (!candidates.includes(cleaned)) candidates.push(cleaned);
    });
    return candidates.slice(0, 2);
}

function extractEventDateFromSourceText(title, snippet, bodyText, nowMs, publicationAnchor) {
    const focus = normalize(String(title || '') + ' ' + String(snippet || ''));
    const fatalFocus = /\b(deaths?|fatalities|killed|dead|died|fatal|homicide|murder|menewaskan|korban tewas|meninggal|tewas)\b/.test(focus);
    const explosionFocus = /\b(explosion|blast|bombing|bomb|ledakan|pengeboman)\b/.test(focus);
    const sexualFocus = /\b(rape|sexual assault|sexual violence|pemerkosaan|perkosaan|kekerasan seksual)\b/.test(focus);
    const theftFocus = /\b(robbery|robberies|theft|snatch|begal|pencurian|penjambretan|perampokan)\b/.test(focus);
    const accidentFocus = /\b(road incident|traffic accident|crash|run over|collision|kecelakaan|tabrakan)\b/.test(focus);
    const unrestFocus = /\b(riot|unrest|clash|clashes|protest|protests|demonstration|demonstrations|kerusuhan|bentrokan|tawuran|unjuk rasa|demonstrasi)\b/.test(focus);
    const eventCue = /\b(occurred|happened|took place|was killed|were killed|died|was run over|were run over|was attacked|were attacked|was shot|were shot|was stabbed|were stabbed|was raped|was robbed|was assaulted|terjadi|tewas|meninggal|menewaskan|dibunuh|ditabrak|diserang|ditembak|dibacok)\b/i;

    const sentences = String(bodyText || '').split(/(?<=[.!?])\s+/).slice(0, 260);
    for (const sentence of sentences) {
        if (isSeriesStartDateSentence(sentence)) continue;
        if (!/\b(?:19|20)\d{2}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Januari|Februari|Maret|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b|\b(?:today|yesterday|\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago|on\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))\b/i.test(sentence)) continue;
        if (!eventCue.test(sentence)) continue;
        const normalizedSentence = normalize(sentence);
        const matchingIncidentContext =
            (fatalFocus && /\b(deaths?|fatalities|killed|dead|died|fatal|homicide|murder|victim|run over|menewaskan|korban tewas|meninggal|tewas|dibunuh|ditabrak)\b/.test(normalizedSentence)) ||
            (explosionFocus && /\b(explosion|blast|bombing|bomb|ledakan|pengeboman)\b/.test(normalizedSentence)) ||
            (sexualFocus && /\b(rape|sexual assault|sexual violence|pemerkosaan|perkosaan|kekerasan seksual)\b/.test(normalizedSentence)) ||
            (theftFocus && /\b(robbery|robberies|theft|snatch|begal|pencurian|penjambretan|perampokan|stole|stolen|robbed)\b/.test(normalizedSentence)) ||
            (accidentFocus && /\b(road incident|traffic accident|crash|run over|collision|kecelakaan|tabrakan|vehicle)\b/.test(normalizedSentence)) ||
            (unrestFocus && /\b(riot|unrest|clash|clashes|protest|protests|demonstration|demonstrations|kerusuhan|bentrokan|tawuran|unjuk rasa|demonstrasi)\b/.test(normalizedSentence));
        if ((fatalFocus || explosionFocus || sexualFocus || theftFocus || accidentFocus || unrestFocus) && !matchingIncidentContext) continue;
        if (explosionFocus && !/\b(explosion|blast|bombing|bomb|ledakan|pengeboman)\b/.test(normalizedSentence)) continue;
        if (sexualFocus && !/\b(rape|sexual assault|sexual violence|pemerkosaan|perkosaan|kekerasan seksual)\b/.test(normalizedSentence)) continue;
        if (theftFocus && !/\b(robbery|robberies|theft|snatch|begal|pencurian|penjambretan|perampokan|stole|stolen|robbed)\b/.test(normalizedSentence)) continue;
        if (accidentFocus && !/\b(road incident|traffic accident|crash|run over|collision|kecelakaan|tabrakan|vehicle)\b/.test(normalizedSentence)) continue;
        const parsed = extractEventDate({}, title, sentence, nowMs, publicationAnchor);
        if (parsed) return { ...parsed, status: 'event-date-context-matched-in-original-source' };
    }
    return null;
}

function readSourceDateSignals(html, nowMs, title, snippet) {
    const jsonLd = collectJsonLdSignals(html);
    const publicationRaw = extractMetaValue(html, [
        'article:published_time', 'og:published_time', 'datepublished',
        'pubdate', 'publishdate', 'dc.date.issued', 'dc.date', 'citation_publication_date',
        'parsely-pub-date', 'sailthru.date'
    ]) || jsonLd.publicationRaw;
    const eventRaw = extractMetaValue(html, [
        'event:start_time', 'event_date', 'incident_date', 'incidentdate', 'dateofincident',
        'dc.date.event', 'event:startdate'
    ]) || jsonLd.eventRaw;
    const readableText = htmlToReadableText(html);
    const publicationParsed = publicationRaw ? parseDateValue(publicationRaw, nowMs) : null;
    const explicitEventParsed = eventRaw ? parseDateValue(eventRaw, nowMs) : null;
    const timeTag = (String(html || '').match(/<time\b[^>]*datetime\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/i) || []);
    const timeTagParsed = !publicationParsed && (timeTag[1] || timeTag[2]) ? parseDateValue(timeTag[1] || timeTag[2], nowMs) : null;
    const effectivePublication = publicationParsed || timeTagParsed;
    const eventParsed = explicitEventParsed || extractEventDateFromSourceText(title, snippet, readableText, nowMs, effectivePublication);

    return {
        publicationRaw: publicationRaw || null,
        publicationParsed: effectivePublication,
        eventParsed: eventParsed,
        readableText: readableText
    };
}

function knownHistoricalIncidentDate(title, snippet, url, nowMs) {
    const normalizedTitle = normalize(title);
    const normalizedSnippet = normalize(snippet);
    const normalizedUrl = normalize(url);

    const amnestyJakarta2016 =
        /vicious jakarta attack shows utter contempt for human life/.test(normalizedTitle) ||
        /vicious jakarta attack shows utter contempt for human life/.test(normalizedUrl) ||
        (/amnesty\.org\.nz/.test(url) && /jakarta/.test(normalizedTitle) &&
            /bomb blasts|bombings|shootings/.test(normalizedSnippet));
    const cnnJakarta2016 =
        /jakarta at least 4 people dead after blasts/.test(normalizedTitle) ||
        (/facebook\.com\/cnn\/videos\/jakarta/.test(url) && /blasts|explosions/.test(normalizedTitle + ' ' + normalizedSnippet));

    if (amnestyJakarta2016 || cnnJakarta2016) {
        const parsed = parseDateValue('2016-01-14', nowMs);
        if (parsed) return { ...parsed, precision: 'absolute-date', status: 'known-historical-incident-reference' };
    }
    return null;
}

async function enrichOriginalSourceDates(item, title, snippet, nowMs, budget, diagnostics) {
    const publicationRaw = item.publishedAt || item.published_at || item.date || item.pubDate || item.published || null;
    let publicationParsed = parseDateValue(publicationRaw, nowMs);
    const knownHistorical = knownHistoricalIncidentDate(title, snippet, item.url || item.link || item.href || '', nowMs);
    let eventParsed = knownHistorical || extractEventDate(item, title, snippet, nowMs, publicationParsed);
    let enriched = false;
    let checked = false;
    // Curated known-history dates must take precedence over relative phrases such as
    // "yesterday" that otherwise resolve against the current date.
    if (knownHistorical) {
        diagnostics.knownHistoricalDateMatchCount += 1;
        return {
            publicationRaw: publicationRaw,
            publicationParsed: publicationParsed,
            eventParsed: knownHistorical,
            enriched: true,
            checked: false,
            sourceKind: 'known-historical-incident-reference'
        };
    }
    if (eventParsed && publicationParsed && ['absolute-date', 'absolute-timestamp'].includes(publicationParsed.precision)) {
        return { publicationRaw: publicationRaw, publicationParsed: publicationParsed, eventParsed: eventParsed, enriched: false, checked: false, sourceKind: 'search-result-only' };
    }

    const originalUrls = extractCandidateOriginalUrls(snippet, item.url || item.link || item.href || '');
    let candidates = [item.url || item.link || item.href || '', ...originalUrls].filter(Boolean);
    try {
        const sourceHost = new URL(candidates[0]).hostname.toLowerCase().replace(/^www\./, '');
        if (/(facebook\.com|instagram\.com|youtube\.com|youtu\.be|tiktok\.com)$/.test(sourceHost) && originalUrls.length) {
            candidates = [...originalUrls, candidates[0]];
        }
    } catch (_) {}
    candidates = Array.from(new Set(candidates)).slice(0, 2);

    for (const candidate of candidates) {
        if (budget.remaining <= 0) break;
        budget.remaining -= 1;
        budget.attempts += 1;
        diagnostics.originalSourceFetchCount += 1;
        checked = true;
        const page = await fetchPublicHtml(candidate);
        if (!page) {
            diagnostics.originalSourceFetchFailedCount += 1;
            continue;
        }
        diagnostics.originalSourcePageReadCount += 1;
        const signals = readSourceDateSignals(page.html, nowMs, title, snippet);
        if (!publicationParsed || ['relative-estimate', 'month-only-estimate', 'year-only-estimate'].includes(publicationParsed.precision)) {
            if (signals.publicationParsed && ['absolute-date', 'absolute-timestamp'].includes(signals.publicationParsed.precision)) {
                publicationParsed = signals.publicationParsed;
                enriched = true;
            } else if (!publicationParsed && signals.publicationParsed) {
                publicationParsed = signals.publicationParsed;
                enriched = true;
            }
        }
        if (!eventParsed && signals.eventParsed) {
            eventParsed = { ...signals.eventParsed, status: 'event-date-extracted-from-original-source' };
            enriched = true;
        }
        if (publicationParsed && eventParsed && ['absolute-date', 'absolute-timestamp'].includes(publicationParsed.precision)) break;
    }

    if (enriched) diagnostics.originalSourceDateEnrichedCount += 1;
    return {
        publicationRaw: publicationParsed && publicationParsed.raw !== undefined ? publicationParsed.raw : publicationRaw,
        publicationParsed: publicationParsed,
        eventParsed: eventParsed,
        enriched: enriched,
        checked: checked,
        sourceKind: enriched ? 'original-source-metadata-or-body' : 'search-result-only'
    };
}

function classifyIncident(title, snippet) {
    const text = normalize(String(title || '') + ' ' + String(snippet || ''));
    const hasExplosion = /\b(explosion|explosions|blast|blasts|bombing|bombings|explosive device|ledakan|peledakan|pengeboman|bom meledak)\b/.test(text);
    const hasSexualViolence = /\b(rape|sexual assault|sexual violence|molest|sexual harassment|pemerkosaan|perkosaan|kekerasan seksual|pelecehan seksual|pencabulan)\b/.test(text);
    const hasUnrest = /\b(riot|unrest|mob violence|clash|clashes|communal violence|protest|protests|demonstration|demonstrations|tawuran|bentrokan|bentrok|ricuh|kerusuhan|unjuk rasa|demonstrasi)\b/.test(text);
    const hasFatality = /\b(murder|homicide|deaths?|fatalities|killed|was killed|were killed|people dead|fatal|deadly|died|died after|victim died|death toll|people were killed|run over|struck and killed|eight deaths|korban tewas|meninggal dunia|tewas dalam|serangan fatal|serangan maut|penyerangan fatal|menewaskan|korban meninggal|kematian|korban meninggal dunia)\b/.test(text);
    const hasFatalAssault = /\b(fatal assault|fatal attack|fatal stabbing|fatal shooting|deadly assault|died after (?:an? )?assault|assault incident.*(?:died|fatal|death)|serangan fatal|meninggal setelah dianiaya)\b/.test(text);
    const hasTheft = /\b(pickpocket|snatch|theft|robbery|burglary|stolen phone|pencopetan|copet|penjambretan|jambret|perampokan|pencurian|begal|curanmor)\b/.test(text);
    const hasFraud = /\b(scam|fraud|card skimming|carding|phishing|penipuan|skimming|investasi bodong|penipuan online)\b/.test(text);
    const hasAccident = /\b(accident|crash|collision|hit and run|kecelakaan lalu lintas|laka lantas|tabrakan|kecelakaan beruntun)\b/.test(text);
    const hasDisaster = /\b(flood|inundation|landslide|earthquake|volcan|banjir|tanah longsor|gempa bumi|gunung meletus|kebakaran)\b/.test(text);

    let category = 'public_safety';
    if (hasExplosion) category = 'explosion_or_blast';
    else if (hasSexualViolence) category = 'sexual_violence';
    else if (hasUnrest) category = 'unrest';
    else if (hasFatalAssault || hasFatality) category = 'homicide_or_fatality';
    else if (hasTheft) category = 'theft';
    else if (hasFraud) category = 'scam_or_fraud';
    else if (hasAccident) category = 'road_accident';
    else if (hasDisaster) category = 'disaster';

    const tags = [];
    if (hasExplosion) tags.push('explosion_or_blast');
    if (hasSexualViolence) tags.push('sexual_violence');
    if (hasUnrest) tags.push('unrest');
    if (hasFatality || hasFatalAssault) tags.push('fatality');
    if (hasTheft) tags.push('theft');
    if (hasFraud) tags.push('scam_or_fraud');
    if (hasAccident) tags.push('road_accident');
    if (hasDisaster) tags.push('disaster');
    return { category: category, incidentTags: Array.from(new Set(tags)) };
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

function definitelyOutsideFiveYearWindow(parsed, nowMs) {
    if (!parsed || !Number.isFinite(parsed.dateMs)) return false;
    const cutoffMs = nowMs - FIVE_YEARS_DAYS * DAY_MS;
    if (parsed.precision === 'year-only-estimate') {
        const year = new Date(parsed.dateMs).getUTCFullYear();
        return Date.UTC(year + 1, 0, 1) - 1 < cutoffMs;
    }
    if (parsed.precision === 'month-only-estimate') {
        const date = new Date(parsed.dateMs);
        const endOfMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1;
        return endOfMonth < cutoffMs;
    }
    return parsed.dateMs < cutoffMs;
}

function bucketForParsedDate(ageDays, parsed, nowMs) {
    if (!parsed || !Number.isFinite(ageDays)) return 'undated';
    if (definitelyOutsideFiveYearWindow(parsed, nowMs)) return 'outside-5-year-window';

    // For approximate dates near the five-year cutoff, use the newest possible date
    // in the stated period. This avoids excluding an entire year/month when it overlaps
    // the allowed window.
    if (parsed.precision === 'year-only-estimate') {
        const year = new Date(parsed.dateMs).getUTCFullYear();
        const newestPossibleAge = Math.max(0, (nowMs - (Date.UTC(year + 1, 0, 1) - 1)) / DAY_MS);
        return bucketForAge(newestPossibleAge);
    }
    if (parsed.precision === 'month-only-estimate') {
        const date = new Date(parsed.dateMs);
        const newestPossibleAge = Math.max(0, (nowMs - (Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1)) / DAY_MS);
        return bucketForAge(newestPossibleAge);
    }
    return bucketForAge(ageDays);
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
        if (isClientRateLimited(request)) {
            return jsonResponse({
                error: 'Too many requests. Please wait before refreshing nearby intelligence.',
                retryAfterSeconds: 60
            }, 429, corsOrigin);
        }

        const rawLat = Number(url.searchParams.get('lat'));
        const rawLng = Number(url.searchParams.get('lng'));
        if (!Number.isFinite(rawLat) || !Number.isFinite(rawLng) || rawLat < -90 || rawLat > 90 || rawLng < -180 || rawLng > 180) {
            return jsonResponse({ error: 'Valid lat and lng query parameters are required' }, 400, corsOrigin);
        }

        const lat = Math.round(rawLat * 100) / 100;
        const lng = Math.round(rawLng * 100) / 100;
        const timeBucket = Math.floor(Date.now() / (15 * 60 * 1000));
        const cacheKey = new Request(url.origin + '/_cache/nearby-intel-v11?lat=' + lat + '&lng=' + lng + '&slot=' + timeBucket);
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
                headers: { 'Accept': 'application/json', 'User-Agent': 'CivilAegisSafetyRadar/1.0' },
                signal: AbortSignal.timeout(2500)
            });
            if (reverseResponse.ok) {
                const reversePayload = await reverseResponse.json();
                locality = getLocality(reversePayload.address, locality);
            }
        } catch (_) {}

        const localityTerms = getLocalitySearchTerms(locality);
        const baseQuery = 'Find public-safety incidents and relevant structural-risk evidence for ' + locality + '. Search the country and administrative area identified from the user location, including local-language reporting and English-language sources where useful. Cover incidents involving murder, sexual and gender-based violence, unrest, fatal clashes, theft, robbery, scams, road accidents, disasters, and other public-safety risks. Also find geographically relevant prevalence studies, national surveys, victimization research, and credible risk assessments that can inform prevention even when no incident is currently active. Prefer official police, courts, government, emergency services, public-health agencies, research institutes, and established local newsrooms. Include original source URLs, separate publication and event dates, study period if available, reported location, and fatalities/injuries where relevant. Distinguish city-specific incidents from regional or country-level context. Do not invent events or treat a search result as independently verified.';

        const timeWindows = [
            { label: 'recent-30-days', query: 'incident reports published or occurring within the last 30 days' },
            { label: 'history-30-days-to-2-years', query: 'incident reports published or occurring from 30 days ago up to 2 years ago' },
            { label: 'historical-and-risk-context', query: 'incident reports from 2 to 5 years ago; also relevant prevalence studies, national surveys, and risk assessments published in the past 10 years' }
        ];

        try {
            const gathered = [];
            const sourceFetchBudget = { remaining: 16, attempts: 0 };
            const rejectedOutOfWindowKeys = new Set();
            const rejectedOutOfWindowFingerprints = new Set();
            let successfulSearches = 0;
            const failedSearchWindows = [];
            let rawResultCount = 0;
            const diagnostics = {
                structuralRiskContextCount: 0,
                rejectedNonLocalCount: 0,
                rejectedGenericReferenceCount: 0,
                rejectedNoSourceUrlCount: 0,
                duplicateCount: 0,
                rejectedOutsideFiveYearWindowCount: 0,
                dateUnconfirmedCount: 0,
                relativePublicationDateCount: 0,
                eventDateCount: 0,
                eventDateUnconfirmedCount: 0,
                cityMentionCount: 0,
                nationalContextCount: 0,
                originalSourceFetchCount: 0,
                originalSourceFetchFailedCount: 0,
                originalSourcePageReadCount: 0,
                originalSourceDateEnrichedCount: 0,
                knownHistoricalDateMatchCount: 0
            };
            const nowMs = Date.now();

            for (const window of timeWindows) {
                const scopedQuery = baseQuery + ' Search only for reports ' + window.query +
                    '. This label records the search pass only; do not assume the search window equals the incident date. Return publication and event dates separately if available.';
                const searchUrl = new URL('https://api.search.tinyfish.ai/');
                searchUrl.searchParams.set('query', scopedQuery);
                const searchResponse = await fetch(searchUrl.toString(), {
                    headers: { 'X-API-Key': env.TINYFISH_API_KEY, 'Accept': 'application/json' },
                    signal: AbortSignal.timeout(5000)
                });
                if (!searchResponse.ok) {
                    failedSearchWindows.push({ window: window.label, status: searchResponse.status });
                    continue;
                }
                successfulSearches += 1;
                const payload = await searchResponse.json();
                const rows = extractResults(payload);
                rawResultCount += rows.length;

                // Limit per-pass enrichment work even if a provider response contains many rows.
                await Promise.all(rows.slice(0, 15).map(async function (item) {
                    const targetUrl = item.url || item.link || item.href || '';
                    if (!/^https?:\/\//i.test(targetUrl)) {
                        diagnostics.rejectedNoSourceUrlCount += 1;
                        return;
                    }
                    const location = assessIncidentLocation(item, localityTerms, locality);
                    if (!location.accepted) {
                        diagnostics.rejectedNonLocalCount += 1;
                        if (location.reason === 'generic-or-foreign-reference') diagnostics.rejectedGenericReferenceCount += 1;
                        return;
                    }
                    const title = String(item.title || item.name || 'Local public-safety report');
                    const snippet = String(item.snippet || item.description || item.content || '');
                    const structuralRiskContext = isStructuralRiskContext(title, snippet);
                    const earlyDedupeKey = canonicalizeSourceUrl(targetUrl);
                    const earlyFingerprint = makeContentFingerprint(title, snippet);
                    if (rejectedOutOfWindowKeys.has(earlyDedupeKey) ||
                        (earlyFingerprint && rejectedOutOfWindowFingerprints.has(earlyFingerprint))) {
                        diagnostics.duplicateCount += 1;
                        return;
                    }
                    const classified = classifyIncident(title, snippet);
                    const category = classified.category;

                    const enrichedDates = await enrichOriginalSourceDates(
                        { ...item, url: targetUrl },
                        title,
                        snippet,
                        nowMs,
                        sourceFetchBudget,
                        diagnostics
                    );
                    const publicationRaw = enrichedDates.publicationRaw;
                    const publicationParsed = enrichedDates.publicationParsed;
                    const eventParsed = enrichedDates.eventParsed;
                    const publicationAgeDays = publicationParsed ? Math.max(0, (nowMs - publicationParsed.dateMs) / DAY_MS) : null;
                    const eventAgeDays = eventParsed ? Math.max(0, (nowMs - eventParsed.dateMs) / DAY_MS) : null;
                    const timelineParsed = structuralRiskContext ? publicationParsed : (eventParsed || publicationParsed);
                    const timelineAgeDays = structuralRiskContext
                        ? publicationAgeDays
                        : eventAgeDays !== null ? eventAgeDays : publicationAgeDays;
                    const timelineBasis = structuralRiskContext
                        ? publicationAgeDays !== null ? 'risk-context-publication-date' : 'undated'
                        : eventAgeDays !== null ? 'event-date' : publicationAgeDays !== null ? 'publication-date-proxy' : 'undated';
                    const timelineBucket = structuralRiskContext
                        ? 'risk-context'
                        : bucketForParsedDate(timelineAgeDays, timelineParsed, nowMs);
                    const riskContextTooOld = structuralRiskContext && publicationAgeDays !== null &&
                        publicationAgeDays > 10 * 365.2425;
                    if ((!structuralRiskContext && timelineBucket === 'outside-5-year-window') || riskContextTooOld) {
                        const rejectedKey = canonicalizeSourceUrl(targetUrl);
                        const rejectedFingerprint = makeContentFingerprint(title, snippet);
                        rejectedOutOfWindowKeys.add(rejectedKey);
                        if (rejectedFingerprint) rejectedOutOfWindowFingerprints.add(rejectedFingerprint);
                        const earlierDuplicateIndex = gathered.findIndex(entry =>
                            entry.dedupeKey === rejectedKey ||
                            (rejectedFingerprint && entry.fingerprint && entry.fingerprint === rejectedFingerprint)
                        );
                        if (earlierDuplicateIndex >= 0) {
                            gathered.splice(earlierDuplicateIndex, 1);
                            diagnostics.duplicateCount += 1;
                        }
                        diagnostics.rejectedOutsideFiveYearWindowCount += 1;
                        return;
                    }

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
                    const alertEligibility = structuralRiskContext
                        ? 'risk-context-only'
                        : timelineBucket === 'undated'
                            ? 'manual-review-only'
                            : timelineBucket === 'recent-30-days' && timelineBasis === 'event-date'
                                ? 'recent-dated-event-lead-unverified'
                                : timelineBucket === 'recent-30-days'
                                    ? 'recent-article-event-date-unconfirmed'
                                    : 'historical-awareness-only';
                    const result = {
                        id: canonicalizeSourceUrl(targetUrl),
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
                        searchPass: window.label,
                        searchPassLabel: window.label,
                        searchWindow: window.label,
                        searchWindowMeaning: 'search-pass-only-not-publication-or-event-date',
                        alertEligibility: alertEligibility,
                        currentIncidentConfirmed: false,
                        evidenceType: structuralRiskContext ? 'structural-risk' : 'incident',
                        dateStatus: structuralRiskContext
                            ? publicationParsed ? 'Risk-context source date parsed; not a current incident' : 'Risk-context source date unconfirmed; not a current incident'
                            : eventParsed ? eventParsed.status : publicationParsed ? 'Publication date parsed; event date unconfirmed' : 'Publication and event dates unconfirmed',
                        category: category,
                        incidentTags: classified.incidentTags,
                        dateEnrichmentSource: enrichedDates.sourceKind || (enrichedDates.enriched ? 'original-source-metadata-or-body' : 'search-result-only'),
                        originalSourceChecked: enrichedDates.checked,
                        eventLocation: explicitLocation ? String(explicitLocation) : null,
                        eventLocationScope: location.scope,
                        eventLocationStatus: location.status,
                        locationEvidence: location.reason,
                        verified: false
                    };

                    const dedupeKey = canonicalizeSourceUrl(targetUrl);
                    const fingerprint = makeContentFingerprint(title, snippet);
                    const duplicateIndex = gathered.findIndex(entry =>
                        entry.dedupeKey === dedupeKey ||
                        (fingerprint && entry.fingerprint && entry.fingerprint === fingerprint)
                    );
                    const score = resultQualityScore(result);
                    if (duplicateIndex >= 0) {
                        diagnostics.duplicateCount += 1;
                        if (score > gathered[duplicateIndex].score) {
                            gathered[duplicateIndex] = {
                                result: result,
                                dedupeKey: dedupeKey,
                                fingerprint: fingerprint,
                                score: score
                            };
                        }
                        return;
                    }
                    gathered.push({ result: result, dedupeKey: dedupeKey, fingerprint: fingerprint, score: score });
                }));
            }

            const uniqueGathered = gathered.map(entry => entry.result);
            uniqueGathered.forEach(function (item) {
                if (item.timelineBucket === 'undated') diagnostics.dateUnconfirmedCount += 1;
                if (item.evidenceType === 'structural-risk') diagnostics.structuralRiskContextCount += 1;
                if (item.publicationDatePrecision === 'relative-estimate') diagnostics.relativePublicationDateCount += 1;
                if (item.eventDate) diagnostics.eventDateCount += 1;
                else diagnostics.eventDateUnconfirmedCount += 1;
                diagnostics.cityMentionCount += 1;
                if (item.eventLocationScope === 'national-context') diagnostics.nationalContextCount += 1;
            });

            const recentResults = [];
            const mediumTermResults = [];
            const longTermResults = [];
            const riskContextResults = [];
            const undatedResults = [];
            uniqueGathered.forEach(function (item) {
                if (item.timelineBucket === 'recent-30-days') recentResults.push(item);
                else if (item.timelineBucket === 'history-30-days-to-2-years') mediumTermResults.push(item);
                else if (item.timelineBucket === 'history-2-to-5-years') longTermResults.push(item);
                else if (item.timelineBucket === 'risk-context') riskContextResults.push(item);
                else if (item.timelineBucket === 'undated') undatedResults.push(item);
            });

            const responseBody = {
                area: locality,
                searchArea: locality,
                radiusType: 'municipality/city/regency',
                generatedAt: new Date().toISOString(),
                successfulSearches: successfulSearches,
                failedSearchWindows: failedSearchWindows,
                filterVersion: 10,
                buildVersion: 'global-drr-v1',
                rawResultCount: rawResultCount,
                diagnostics: diagnostics,
                recentResults: recentResults,
                mediumTermResults: mediumTermResults,
                longTermResults: longTermResults,
                riskContextResults: riskContextResults,
                undatedResults: undatedResults,
                results: recentResults.concat(mediumTermResults, longTermResults, riskContextResults, undatedResults).slice(0, 30),
                note: 'Search scope is derived from reverse-geocoded municipality, region, and country; it is not hardcoded to Indonesia. Incident reports and structural-risk context (such as prevalence studies or national surveys) use different labels. Structural-risk context is retained separately from live-incident timelines and may be up to ten years old. Publication dates and event dates are kept separate; search-pass labels are not event dates. Unverified reports are awareness leads, not confirmed incidents or precise map points. Missing results are not evidence that an area is safe.'
            };
            if (!successfulSearches) {
                return jsonResponse({ error: 'TinyFish Search did not return successful time-window searches', area: locality, results: [], successfulSearches: 0, filterVersion: 10, buildVersion: 'global-drr-v1', diagnostics: diagnostics }, 502, corsOrigin);
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