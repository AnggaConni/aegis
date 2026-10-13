# CivilAegis API, awareness mode, route planning, and offline use

CivilAegis is a static Leaflet application. Python is not required for the current stage.

## Awareness mode and personalized recommendations

The app opens in **Awareness** mode so someone can view nearby reports, services, and web intelligence without planning a route. Choose **Plan a route** to open the routing controls. Switching back to Awareness removes route overlays from the map but does not delete the saved trip.

Immediately below **Personal Safety Overview**, the app displays a personalized recommendation. It classifies available nearby mapped hazards and TinyFish local search results into themes such as theft/pickpocketing, payment-card fraud, road accidents, floods, fires, and earthquakes. Recommendations include practical next steps and distances to the nearest mapped police station, hospital, or fire station when those POIs are available from OpenStreetMap. The POI distance is calculated from the user's current location; facility opening status and whether it is an appropriate destination are not verified.

TinyFish items are **unverified search/media leads**, not confirmed incidents. The recommendation shows source context, keeps the original source link, and avoids declaring a location unsafe from a headline alone. Missing reports are not proof of safety.

The Feed has four primary views:
- **Recommendations** — English-language guidance for phone security, pickpocketing, payment-card skimming/card-not-present fraud, evacuation preparation, and information verification.
- **All signals** — recommendations plus currently available reports and TinyFish web signals.
- **Incident reports** — mapped alerts, facility points, and eligible crime records.
- **News & OSINT** — source-linked TinyFish results, labelled as unverified leads.

When a mapped hazard report is within about 10 km, the app presents contextual guidance. For floods, it advises avoiding floodwater and following official evacuation guidance. It can open the route planner so the user can choose an official evacuation centre or another verified safer destination. The app must not claim that an arbitrary nearby facility is safe or open.

## Public feeds used by index.html

- **BMKG** — latest Indonesian earthquake bulletin.
- **USGS** — global recent earthquake feed.
- **GDACS** — global disaster alert signals.
- **PetaBencana** — recent community-submitted disaster reports in Indonesia.
- **OpenStreetMap Overpass** — nearby police, hospital, and fire-station locations.
- **Open-Meteo** — forecast rainfall, rain probability, and wind at the planned destination. This is weather context only, not a flood or road-closure alert.
- **OSRM public demo** — driving route alternatives, estimated duration, and turn instructions.
- **OpenStreetMap Nominatim** — destination search when the user explicitly submits a query.
- **TinyFish Search** — optional local news/web signals through a Cloudflare Worker.
- **UK Police API (data.police.uk)** — free street-level recorded-crime data only in its supported UK coverage. The API's crime locations are anonymised/approximate and the records are historical monthly data, not live alerts. CivilAegis calls it only when the user's coordinates fall inside a rough England/Wales/Northern Ireland coverage box. The geographic guard is conservative but is not an official boundary check; the API is not treated as a complete source for Scotland. It does not provide Indonesian crime incidents.

There is no integrated nationwide open, real-time Indonesian crime-incident API in this implementation. For Indonesia, CivilAegis uses TinyFish local news/search leads plus mapped police-station POIs, and explicitly labels the gap rather than presenting unverified news as official crime data.

A failed feed is unavailable data, not evidence that an area is safe.

## One-way and round-trip plans

Use **Sekali Jalan** to plan a single route. Use **Pulang-Pergi (PP)** to calculate both:
- **PERGI** — the saved origin to the destination.
- **PULANG** — the saved destination back to the original starting point.

Both legs, route geometry, alternatives, estimated durations, turn instructions, destination, selected leg, and saved weather context are stored in browser storage on the device. Select PERGI or PULANG later to switch legs without requesting a new route.

The Refresh action updates public reports and re-checks saved route corridors when online. Routes are checked against mapped hazard points within the selected 500 m / 1 km / 2 km corridor. Cached reports are labelled and may be stale.

## Offline limitations

After the app has loaded and cached its shell while online, it can reopen the page and saved trip data without connectivity. Turn instructions and route line geometry remain on-device. Live alerts, fresh route calculations, and weather refreshes still require a connection. OpenStreetMap public raster tiles are intentionally not cached for offline use; without an approved offline tile provider/package, the base map may be blank while saved route lines and directions remain stored.

For a real trip, open CivilAegis online before departure, let it finish loading, then reload it once online so the service worker can cache the app shell and vendor assets. Keep a separate offline-capable map/navigation option as backup.

The current route planner is a prototype, not full live navigation: it does not continuously track the user's movement, automatically reroute, provide spoken instructions, or receive every local crime/accident report. Open Google Maps for a navigation fallback and follow official instructions during an emergency.

## Public-service usage policies

- Nominatim requires explicit user-initiated searches, no autocomplete, usage-rate limits and attribution: https://operations.osmfoundation.org/policies/nominatim/
- OSRM's public demo has no SLA and can be withdrawn or rate-limited: https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy
- Open-Meteo's free API is for open-source/non-commercial use and requires attribution: https://open-meteo.com/en/terms
- GDACS data uses attribution and data-use terms: https://www.gdacs.org/gdacsapi/swagger/index.html
- OpenStreetMap public raster tiles do not provide an offline-download service: https://operations.osmfoundation.org/policies/tiles/
- UK Police open crime API documentation and its approximate street-level location model: https://data.police.uk/docs/method/crime-street/

## Enable TinyFish News & OSINT

TinyFish Search is used for **media/web signals**, not an authoritative structured incident feed. Keep its API key out of index.html.

1. Deploy tinyfish-worker.js as a Cloudflare Worker.
2. Add TINYFISH_API_KEY as a **Cloudflare Worker secret**.
3. Set ALLOWED_ORIGINS as a Worker variable to https://anggaconni.github.io. For local testing, add a local origin as a comma-separated value.
4. Deploy the Worker and copy its endpoint, for example https://your-worker.workers.dev/nearby-intel.
5. In index.html, set TINYFISH_PROXY_URL to that endpoint and commit the change.

A TINYFISH_API_KEY stored only in GitHub repository secrets is not readable by GitHub Pages or by a Cloudflare Worker automatically. The Worker requires its own secret unless a deployment workflow explicitly provisions it. The Feed displays an explanatory message when the proxy URL has not been configured.

## Future free/low-cost sources

- Official local police, municipality, and BPBD feeds where structured public endpoints exist.
- NASA FIRMS for satellite fire hotspots (free key required).
- Open-Meteo Flood API and other environmental products for additional context.
- Traffic incident providers such as TomTom or HERE only after checking Indonesia coverage, limits, and terms.

Crime and road-accident coverage is not a complete verified real-time feed. Community reports and media signals are leads for awareness and human review—not substitutes for official emergency notifications.
