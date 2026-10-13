# CivilAegis API setup

CivilAegis is a static Leaflet application. **Python is not required for the current stage.**

## Public feeds used by index.html

- **BMKG** — latest Indonesian earthquake bulletin.
- **USGS** — global recent earthquake feed.
- **GDACS** — global disaster alerts for earthquake, tropical cyclone, flood, volcano, and wildfire event types, filtered to recent red/orange alerts.
- **PetaBencana** — recent community-submitted disaster reports in Indonesia.
- **OpenStreetMap Overpass** — nearby police, hospital, and fire-station locations.
- **Open-Meteo** — forecast rainfall, rain probability, and wind at the planned destination. This is weather context only, not a flood or road-closure alert.
- **OSRM public demo** — driving route alternatives, estimated duration, and turn instructions.
- **OpenStreetMap Nominatim** — destination geocoding when the user explicitly submits a search.

The app shows source status in the sidebar. A failed feed should be treated as unavailable data, not as evidence that an area is safe.

## Route and hazard checking

The user can search for a place or choose a destination on the map. The app requests a driving route from OSRM, then checks mapped incident points against a configurable 500 m / 1 km / 2 km corridor. GDACS and recent USGS/PetaBencana points can be considered where their coordinates fall near the route. The app presents route options and counts of mapped reports; it does **not** compute a guaranteed safe route.

The current implementation is a route-planning prototype, not continuous turn-by-turn navigation: it does not continuously track progress, automatically reroute, report live road closures, or receive every local crime/accident report. Open Google Maps for a navigation fallback and check official instructions before travelling through a possible hazard area.

Free public services are best-effort and have usage rules:
- Nominatim requires explicit user-initiated searches, no autocomplete, a maximum of 1 request/second, and attribution: https://operations.osmfoundation.org/policies/nominatim/
- OSRM's public demo has no SLA and can be withdrawn or rate-limited: https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy
- Open-Meteo's free API is for open-source/non-commercial use and requires attribution: https://open-meteo.com/en/terms
- GDACS requests source attribution and has a data-use disclaimer: https://www.gdacs.org/gdacsapi/swagger/index.html

## Enable TinyFish local-news search

TinyFish Search is used for **media/web signals**, not an authoritative structured incident feed. Keep its API key out of index.html.

1. Deploy tinyfish-worker.js as a Cloudflare Worker.
2. Add TINYFISH_API_KEY as a **Cloudflare Worker secret**.
3. Set ALLOWED_ORIGINS as a Worker variable to https://anggaconni.github.io. For a local test, add a local origin as a comma-separated value, such as https://anggaconni.github.io,http://localhost:8000.
4. Deploy the Worker and copy its endpoint, for example https://your-worker.workers.dev/nearby-intel.
5. In index.html, set TINYFISH_PROXY_URL to that deployed endpoint, then commit the change.

**Important:** A secret stored in GitHub repository settings or GitHub Actions is not readable by a public GitHub Pages frontend. The TinyFish Worker secret is separate. The Worker rounds coordinates and uses a coarse locality before searching; its results appear under News & OSINT as source-linked, unverified media signals and are not plotted as exact incident points.

## Future free/low-cost sources

- Official local police, municipality, and BPBD feeds where structured public endpoints exist.
- NASA FIRMS for satellite fire hotspots (free key required).
- Open-Meteo Flood API and marine/air-quality products for additional environmental context.
- Traffic incident providers such as TomTom or HERE only after verifying Indonesia coverage and terms.

Crime and road-accident coverage is not yet a complete, verified, real-time feed. Community reports and media signals are leads for awareness and human review—not a substitute for official emergency notifications.
