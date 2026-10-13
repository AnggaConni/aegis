# CivilAegis API, route planning, and offline use

CivilAegis is a static Leaflet application. **Python is not required for the current stage.**

## Public feeds used by index.html

- **BMKG** — latest Indonesian earthquake bulletin.
- **USGS** — global recent earthquake feed.
- **GDACS** — global disaster alert signals.
- **PetaBencana** — recent community-submitted disaster reports in Indonesia.
- **OpenStreetMap Overpass** — nearby police, hospital, and fire-station locations.
- **Open-Meteo** — forecast rainfall, rain probability, and wind at the planned destination. This is weather context only, not a flood or road-closure alert.
- **OSRM public demo** — driving route alternatives, estimated duration, and turn instructions.
- **OpenStreetMap Nominatim** — destination search when the user explicitly submits a query.
- **TinyFish Search** — optional local news/web signals through a Cloudflare Worker; not an official incident registry.

The app shows source status in the sidebar. A failed feed is unavailable data, not evidence that an area is safe.

## One-way and round-trip plans

Use **Sekali Jalan** to plan a single route. Use **Pulang-Pergi (PP)** to calculate both:
- **PERGI** — the saved origin to the destination.
- **PULANG** — the saved destination back to the original starting point.

The two legs, route geometry, alternatives, estimated durations, turn instructions, destination and selected leg are saved in browser storage on the device. Select PERGI or PULANG later to switch legs without requesting a new route. The planned trip also persists after closing and reopening the app on the same browser/device.

The Refresh action updates public reports and re-checks saved route corridors when online. Routes are checked against mapped hazard points within the selected 500 m / 1 km / 2 km corridor. The app can surface cached alerts too; cached items are labelled, and their original timestamps should be checked.

**Offline limitations:** after the app has loaded and cached its shell while online, it can reopen the page and saved trip data without connectivity. Turn instructions and route line geometry remain on-device. Live alerts, fresh route calculations, and weather refreshes still require a connection. OpenStreetMap's public raster tile service is not cached for offline map use; without an approved offline tile provider/package, the base map may be blank while saved route lines and directions remain stored. For a real trip, open CivilAegis online before departure, let it finish loading, then reload it once online so the service worker can cache vendor scripts/styles and the app shell. Keep a separate offline-capable map/navigation option as backup.

The current route planner is a prototype, not full live navigation: it does not continuously track the user's movement along the route, automatically reroute, provide spoken instructions, or receive every local crime/accident report. Open Google Maps for a navigation fallback and follow official guidance during an emergency.

## Public-service usage policies

- Nominatim requires explicit user-initiated searches, no autocomplete, usage-rate limits and attribution: https://operations.osmfoundation.org/policies/nominatim/
- OSRM's public demo has no SLA and can be withdrawn or rate-limited: https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy
- Open-Meteo's free API is for open-source/non-commercial use and requires attribution: https://open-meteo.com/en/terms
- GDACS data uses attribution and data-use terms: https://www.gdacs.org/gdacsapi/swagger/index.html
- OpenStreetMap public raster tiles do not provide an offline-download service: https://operations.osmfoundation.org/policies/tiles/

## Enable TinyFish local-news search

TinyFish Search is used for **media/web signals**, not an authoritative structured incident feed. Keep its API key out of index.html.

1. Deploy tinyfish-worker.js as a Cloudflare Worker.
2. Add TINYFISH_API_KEY as a **Cloudflare Worker secret**.
3. Set ALLOWED_ORIGINS as a Worker variable to https://anggaconni.github.io. For a local test, add a local origin as a comma-separated value.
4. Deploy the Worker and copy its endpoint, for example https://your-worker.workers.dev/nearby-intel.
5. In index.html, set TINYFISH_PROXY_URL to that deployed endpoint and commit the change.

A TINYFISH_API_KEY value stored only in GitHub repository secrets is not readable by the public GitHub Pages frontend or by a Cloudflare Worker automatically. The Worker needs its own secret unless a deployment workflow is explicitly configured to provision it. Worker search results appear under News & OSINT as source-linked, unverified media leads and are not plotted as exact incident points.

## Future free/low-cost sources

- Official local police, municipality, and BPBD feeds where structured public endpoints exist.
- NASA FIRMS for satellite fire hotspots (free key required).
- Open-Meteo Flood API and other environmental products for additional context.
- Traffic incident providers such as TomTom or HERE only after checking Indonesia coverage, limits and terms.

Crime and road-accident coverage is not yet a complete, verified, real-time feed. Community reports and media signals are leads for awareness and human review—not substitutes for official emergency notifications.
