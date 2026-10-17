# CivilAegis API, awareness mode, route planning, and offline use

CivilAegis is a static Leaflet application. Python is not required for the current stage.

## Global awareness scope: municipality/region/country

TinyFish reverse-geocodes rounded coordinates and builds the search scope from the returned locality, region, and country. It does not default to Indonesia. It avoids relying only on a neighbourhood name so results can include relevant regional or country-level context. Address-field quality varies by country; the returned scope is approximate and is not a precise geofence. If the user denies GPS, CivilAegis does not send the app's old map fallback as if it were the user's actual location.

The Worker runs three separate searches:
- **Recent incidents:** published or occurring within the last 30 days.
- **Historical incidents:** published or occurring from 30 days to 2 years ago.
- **Older incidents plus risk context:** incidents from 2–5 years ago, alongside relevant prevalence studies, national surveys, and risk assessments published within the past 10 years.

Structural-risk context is returned in its own bucket (riskContextResults / timelineBucket: "risk-context"), rather than being labelled as a current incident. It can inform proportionate prevention even when no incident is happening now.

Topics include murder/homicide, sexual assault/rape, riots and fatal clashes, pickpocketing/snatching, robbery, theft, scams/card fraud, road accidents, and disasters. It prefers official sources and established local newsrooms. Results retain a source link, approximate area, publication-date status, category, and search-window label where available.

The five-year incident range and ten-year risk-context range are search horizons, **not guarantees of comprehensive coverage**. Search may miss incidents or studies. Publication date, event date, and study period are stored separately. If only publication age is known, it describes the article, not a confirmed incident date. Undated results remain clearly labelled and are never assumed to be current. Approximate dates are labelled. Historical events and prevalence studies can inform prevention, but do not prove an active incident at the user's exact location. Search results are leads, not independently confirmed incident records.

The Worker checks locality/region/country mentions in result titles and snippets; a place name appearing only in a URL is not sufficient. It distinguishes city-mentioned-location-unverified, city-mentioned-context-unclear, national-context, and country-context. These are geographic-scope hints, not verified incident coordinates. Structural-risk context can be country-level and should not be presented as a precise neighbourhood incident. Diagnostics report duplicate items, missing source URLs, generic/foreign references rejected, out-of-window items rejected, undated items, and failed search windows. Reports containing explosions/blasts and fatality terms are categorized explicitly. When publication and event dates are absent, they stay undated; headline wording such as "BREAKING" is not treated as a reliable timestamp. Hashtag locations and city-headline formats can establish a city mention, but do not establish an exact incident point.

## TinyFish reliability and diagnostics (Global DRR Worker v1.1)

The Worker identifies its logic in the response with `filterVersion: 11` and `buildVersion: "global-drr-v1.1-search-reliability"`. Its cache key is `nearby-intel-v12`, independently versioned to prevent stale responses from masking the update. TinyFish Search requests now have a 12-second per-window timeout, and a failed/slow search window is recorded and skipped so later windows can still succeed. It reads a capped number of public source pages for publication/event metadata and visible article text when search results do not have reliable dates. Redirects are followed manually with URL validation; requests to localhost and private address ranges are rejected. This enrichment is best-effort: blocked platforms, JavaScript-rendered pages, removed links, and incomplete source text can still leave a result undated.

The response diagnostics include `originalSourceFetchCount`, `originalSourceFetchFailedCount`, `originalSourcePageReadCount`, `originalSourceDateEnrichedCount`, `knownHistoricalDateMatchCount`, and `eventDateUnconfirmedCount`. `eventDateCount` counts results with an extracted event date, while `eventDateUnconfirmedCount` counts results without one, regardless of which timeline bucket they occupy. Results may carry `dateEnrichmentSource`, `originalSourceChecked`, and `incidentTags`.

Event and publication dates remain separate. Explicit incident dates are accepted only when the wording matches an incident action; a start date that merely marks the beginning of a wider protest series must not be relabelled as the date of an individual incident. Relative wording such as `yesterday` or `two days ago` is represented as an approximate date. A weekday-only reference can be estimated from an absolute publication date when it points to a clear preceding weekday; if it could mean either today or the previous week, it remains unconfirmed. These are date estimates, not independent verification.

A small set of explicitly recognized historical references covers the January 14, 2016 Jakarta bombings reported by Amnesty International and CNN. These known-history matches take precedence over words such as `yesterday` in their snippets, so an old archive cannot become a current event simply because its text uses relative wording. These narrow matches provide a dated historical classification for those known references; they are not a general-purpose event database and do not replace source verification.

Generic crime overviews and broad roundups are filtered from concrete incident reports. Geographically relevant prevalence studies, national surveys, victimization research, and risk assessments may be retained as a separate structural-risk context type; the source, date, study population, and geographic scope must be reviewed before drawing conclusions. On mobile, the map has a dedicated hide/show control to give the nearby intel panel more room. The confirmed GPS position uses a blue pulsing halo and a high-contrast white ring; the fallback planning point is amber to distinguish it from a real GPS fix. The selected-alert detail panel is moved into a compact strip directly below the header on mobile, reserving real layout space instead of floating over the Nearby Intel content; desktop restores the original panel position. A recurring-crime segment may be rejected unless the title or snippet also contains a specific incident signal such as an arrest, attack, or death. Fatality tags recognize plural language such as `deaths` and `fatalities`, including where an unrest report's primary category remains `unrest`.

The response includes complete timeline bucket arrays; the combined `results` feed is capped at 30 rows. The frontend merges the combined feed and bucket arrays and deduplicates on a stable row key, so it can retain unique records from either representation without duplicating results. The query-pass field (`searchPass` / `searchWindow`) records which search query returned the result. It does not record the incident date or prove that an incident happened within that period.

Undated results use `alertEligibility: "manual-review-only"` and must not be treated as current alerts. `currentIncidentConfirmed` remains false because this pipeline does not independently verify current incidents or local danger.

## Personalized recommendation

Immediately below Personal Safety Overview, the app classifies nearby mapped hazards and TinyFish search results into themes such as theft/pickpocketing, sexual and gender-based violence, payment-card fraud, road accidents, floods, fires, and earthquakes. Recent incident leads, historical incidents, and structural-risk context are ranked and labelled separately; older bombing or violence reports should produce preparedness guidance, not language implying the source is undated or the incident is active. Recommendations include practical next steps and distances to the nearest mapped police station, hospital, or fire station when OpenStreetMap provides those points. Facility opening status and whether it is an appropriate destination are not verified.

Historical reports are contextual awareness, not evidence of active danger. Do not label a neighbourhood or group of people as dangerous based solely on past news.

## Crime data coverage

The free UK Police API (data.police.uk) is used only where supported in a rough England/Wales/Northern Ireland coverage box. Its street-level locations are anonymised/approximate, and records are historical monthly data, not live alerts. It does not supply Indonesian crime incidents.

There is no integrated global open, real-time crime-incident API in this implementation. Coverage from TinyFish depends on search visibility, language, source availability, and the locality/region/country names returned by reverse geocoding. Other feeds also have geographic limits; a global search architecture does not mean every country has comprehensive data.

## Other feeds

- BMKG — Indonesian latest earthquake, recent M5+ earthquake list, and felt-earthquake list. The app only elevates entries with timestamps within 72 hours into live hazard/route data.
- USGS — global M2.5+ earthquakes in the past day; significant/recent records may support regional context when magnitude or felt/intensity metadata warrants it.
- GDACS — global disaster alert signals; currently queried for red/orange alerts over the prior 14 days.
- NASA EONET — global open natural-event metadata over the prior 7 days. The current integration uses point geometries only and skips polygons to avoid treating a polygon centroid as an exact incident location.
- PetaBencana — community-submitted disaster reports in Indonesia, queried over the most recent 6 hours. These are community signals, not official confirmation.
- OpenStreetMap Overpass — nearby police, hospital, and fire-station points.
- Open-Meteo — forecast context; not a flood/road-closure warning.
- OSRM public demo — driving routes and turn instructions.
- Nominatim — explicit destination search.

The overview distinguishes mapped hazards within 10 km from selected regional signals out to 50 km. Regional earthquake signals are shown when recent magnitude, felt-report, tsunami-potential, or intensity metadata warrants context; this is not a local shaking prediction. Current-event freshness checks suppress undated records and older local snapshots from being presented as live signals. The route planner drops stale candidates on refresh and only restores cached candidates when the corresponding feed is unavailable. A failed feed is unavailable data, not evidence that an area is safe.

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


## Free Search pricing and protective limits

TinyFish currently lists Search as free at 30 requests per minute and 500 requests per hour, and Fetch as free at 150 URLs per minute and 1,000 URLs per day. Agent and Browser are separately metered products. Check the current [TinyFish pricing page](https://www.tinyfish.ai/pricing) before relying on any limit.

The Worker keeps the API key server-side. It includes a cache, a timeout for TinyFish Search and reverse geocoding, per-window failure diagnostics, a cap on rows enriched per search pass, and a best-effort per-isolate request guard. The browser waits up to 60 seconds for the three search windows and displays a brief error class such as `Search timeout`, `Rate limited`, `Worker secret missing`, or `API key rejected`; hover/tap title text on the TinyFish status gives window-level details where the browser supports it. The isolate-local guard is not a globally atomic quota; add a Cloudflare edge rate-limiting rule if the endpoint needs stronger abuse protection.

Do not put `TINYFISH_API_KEY` in frontend code or a public GitHub file. GitHub Actions secrets are only made available to workflows that explicitly reference them; they are not private runtime variables for GitHub Pages.


## Shared Site Intelligence route for World Heritage Atlas

The same Worker can serve both CivilAegis's existing safety endpoint and the World Heritage Atlas Site Intelligence dossier. This is an additive route; the existing `/nearby-intel` behaviour is not changed.

- Health: `GET /health`
- Heritage news: `GET /site-intel?scope=news&site=Borobudur%20Temple&country=Indonesia`
- Scholarly metadata: `GET /site-intel?scope=research&site=Borobudur%20Temple&country=Indonesia`

The `news` scope uses the existing `TINYFISH_API_KEY` Worker secret. The `research` scope queries OpenAlex and can use the optional `OPENALEX_API_KEY` secret; the key is not exposed to the browser. Responses include provider status, source URLs and provenance. News items remain unverified source leads, not confirmed claims or incident reports.

The allowed browser origin defaults to `https://anggaconni.github.io`. Add additional origins only when needed, separated by commas in the `ALLOWED_ORIGINS` Worker variable. Site Intelligence uses its own best-effort rate guard and separate edge-cache keys so it does not share result-cache entries with `/nearby-intel`.

### Deploying the route

After this code is merged, deploy the Worker using the deployment method already used for CivilAegis. From a locally authenticated checkout of this repository, run:

```bash
npx wrangler deploy --config wrangler.jsonc
```

The existing `TINYFISH_API_KEY` must remain set as a Cloudflare Worker secret. `OPENALEX_API_KEY` is optional. Do not put either key in the World Heritage Atlas frontend or commit secret values.

Verify `/health` first, then test one `/site-intel?scope=news...` request and one `/site-intel?scope=research...` request. The app should call `https://civilaegis-tinyfish-proxy.conniezz-cool.workers.dev/site-intel`; its original safety integration continues to call `/nearby-intel`.
