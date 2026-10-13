# CivilAegis API, awareness mode, route planning, and offline use

CivilAegis is a static Leaflet application. Python is not required for the current stage.

## Awareness scope: municipality/city/regency

TinyFish reverse-geocodes rounded coordinates and prefers a city, municipality, or regency-level name for search. It avoids neighbourhood, suburb, village, and subdistrict names to reduce an overly narrow search. Address-field quality varies by place, so the returned area is an approximate administrative search scope, not a precise geofence.

The Worker runs three separate searches:
- **Recent:** reports from the last 30 days.
- **Historical:** reports from 30 days to 2 years ago.
- **Older historical context:** reports from 2 to 5 years ago.

Topics include murder/homicide, sexual assault/rape, riots and fatal clashes, pickpocketing/snatching, robbery, theft, scams/card fraud, road accidents, and disasters. It prefers official sources and established local newsrooms. Results retain a source link, approximate area, publication-date status, category, and search-window label where available.

The five-year range is a search horizon, **not a guarantee of comprehensive coverage**. Search may miss incidents. Publication date and event date are stored separately. If only publication age is known, the historical/recent bucket refers to the article's date, not a confirmed incident date. Undated results remain in their own section and are never assumed to be current. Year-only, month-only, and relative dates are explicitly labelled approximate. Search results are leads for awareness, not confirmed incident records.

The Worker applies a municipality-name relevance check to the title and snippet; a city name that appears only in a URL is not sufficient. It distinguishes `city-mentioned-location-unverified`, `city-mentioned-context-unclear`, and `national-context`. These are scope hints, not verified incident coordinates. Diagnostics report duplicate items, missing source URLs, generic/foreign references rejected, out-of-window items rejected, undated items, and failed search windows. Reports containing explosions/blasts and fatality terms are categorized explicitly. When publication and event dates are absent, they stay undated; headline wording such as "BREAKING" is not treated as a reliable timestamp. Hashtag locations and city-headline formats can establish a city mention, but do not establish an exact incident point.

## Timeline enrichment and verification (Worker v5.2.1)

The Worker identifies its logic in the response with `filterVersion: 8` and `buildVersion: "timeline-v5.2.1-context-dates"`. Its cache key is versioned independently to prevent stale v5.2 responses from masking the update. It reads a capped number of public source pages for publication/event metadata and visible article text when search results do not have reliable dates. Redirects are followed manually with URL validation; requests to localhost and private address ranges are rejected. This enrichment is best-effort: blocked platforms, JavaScript-rendered pages, removed links, and incomplete source text can still leave a result undated.

The response diagnostics include `originalSourceFetchCount`, `originalSourceFetchFailedCount`, `originalSourcePageReadCount`, `originalSourceDateEnrichedCount`, `knownHistoricalDateMatchCount`, and `eventDateUnconfirmedCount`. `eventDateCount` counts results with an extracted event date, while `eventDateUnconfirmedCount` counts results without one, regardless of which timeline bucket they occupy. Results may carry `dateEnrichmentSource`, `originalSourceChecked`, and `incidentTags`.

Event and publication dates remain separate. Explicit incident dates are accepted only when the wording matches an incident action; a start date that merely marks the beginning of a wider protest series must not be relabelled as the date of an individual incident. Relative wording such as `yesterday` or `two days ago` is represented as an approximate date. A weekday-only reference can be estimated from an absolute publication date when it points to a clear preceding weekday; if it could mean either today or the previous week, it remains unconfirmed. These are date estimates, not independent verification.

A small set of explicitly recognized historical references covers the January 14, 2016 Jakarta bombings reported by Amnesty International and CNN. These known-history matches take precedence over words such as `yesterday` in their snippets, so an old archive cannot become a current event simply because its text uses relative wording. These narrow matches provide a dated historical classification for those known references; they are not a general-purpose event database and do not replace source verification.

Generic crime statistics, overview pages, and broad crime roundups are filtered separately from reports of concrete incidents. On mobile, the map has a dedicated hide/show control to give the nearby intel panel more room. The confirmed GPS position uses a blue pulsing halo and a high-contrast white ring; the fallback planning point is amber to distinguish it from a real GPS fix. A recurring-crime segment may be rejected unless the title or snippet also contains a specific incident signal such as an arrest, attack, or death. Fatality tags recognize plural language such as `deaths` and `fatalities`, including where an unrest report's primary category remains `unrest`.

The response includes complete timeline bucket arrays; the combined `results` feed is capped at 30 rows. The frontend merges the combined feed and bucket arrays and deduplicates on a stable row key, so it can retain unique records from either representation without duplicating results. The query-pass field (`searchPass` / `searchWindow`) records which search query returned the result. It does not record the incident date or prove that an incident happened within that period.

Undated results use `alertEligibility: "manual-review-only"` and must not be treated as current alerts. `currentIncidentConfirmed` remains false because this pipeline does not independently verify current incidents or local danger.

## Personalized recommendation

Immediately below Personal Safety Overview, the app classifies nearby mapped hazards and TinyFish local search results into themes such as theft/pickpocketing, payment-card fraud, road accidents, floods, fires, and earthquakes. Recommendations include practical next steps and distances to the nearest mapped police station, hospital, or fire station when OpenStreetMap provides those points. Facility opening status and whether it is an appropriate destination are not verified.

Historical reports are contextual awareness, not evidence of active danger. Do not label a neighbourhood or group of people as dangerous based solely on past news.

## Crime data coverage

The free UK Police API (data.police.uk) is used only where supported in a rough England/Wales/Northern Ireland coverage box. Its street-level locations are anonymised/approximate, and records are historical monthly data, not live alerts. It does not supply Indonesian crime incidents.

There is no integrated nationwide open, real-time Indonesian crime-incident API in this implementation. In Indonesia, CivilAegis uses TinyFish news/search leads plus mapped police-station points and clearly marks their verification limits.

## Other feeds

- BMKG — Indonesian earthquake bulletin.
- USGS — global recent earthquakes.
- GDACS — global disaster alert signals.
- PetaBencana — community-submitted disaster reports in Indonesia.
- OpenStreetMap Overpass — nearby police, hospital, and fire-station points.
- Open-Meteo — forecast context; not a flood/road-closure warning.
- OSRM public demo — driving routes and turn instructions.
- Nominatim — explicit destination search.

A failed feed is unavailable data, not evidence that an area is safe.

## Routes and offline use

Use Sekali Jalan for one-way trips or Pulang-Pergi (PP) to calculate PERGI and PULANG. Both legs, route geometry, alternatives, turn instructions, and selected leg are stored locally. Cached reports can be stale. Live alerts and new routes require connectivity.

OpenStreetMap public raster tiles are not cached for offline use. Saved routes and directions may remain available while the base map is blank. Keep a separate offline-capable navigation option.

## Public usage policies

- Nominatim: https://operations.osmfoundation.org/policies/nominatim/
- OSRM demo policy: https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy
- Open-Meteo terms: https://open-meteo.com/en/terms
- GDACS documentation: https://www.gdacs.org/gdacsapi/swagger/index.html
- OpenStreetMap tile policy: https://operations.osmfoundation.org/policies/tiles/
- UK Police crime API: https://data.police.uk/docs/method/crime-street/

## Configure TinyFish through Cloudflare Workers Builds

The repository includes `wrangler.jsonc`, which tells Wrangler to deploy `tinyfish-worker.js` as the Worker entrypoint. For the Git-connected setup:

1. In Cloudflare Workers & Pages, connect the GitHub repository `AnggaConni/aegis` and branch `main`.
2. Use the project name `civilaegis-tinyfish-proxy` to match `wrangler.jsonc`.
3. Leave Build command empty. Keep Deploy command as `npx wrangler deploy`; the Wrangler configuration selects `tinyfish-worker.js`.
4. Deploy the Worker and open its Settings → Variables and Secrets. Add `TINYFISH_API_KEY` as a **Secret** using the real TinyFish API key. Add `ALLOWED_ORIGINS` as a plain variable with value `https://anggaconni.github.io`. Deploy the settings changes.
5. Copy the Worker URL and append `/nearby-intel`.
6. In `index.html`, set `TINYFISH_PROXY_URL` to that full endpoint and commit the change.

A GitHub Repository Secret is not automatically available to GitHub Pages or a Cloudflare Worker. Keep the API key in the Worker secret store; never expose it in browser code.

The public app is an awareness aid, not an emergency dispatch system or a complete crime database. Follow official instructions in an emergency.
