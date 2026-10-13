# CivilAegis API setup

CivilAegis is a static Leaflet application. **Python is not required for the current stage.**

## Public feeds already called by index.html

- BMKG open earthquake JSON
- USGS earthquake GeoJSON
- PetaBencana recent community disaster reports
- OpenStreetMap Overpass emergency facilities

The app shows live source status in the sidebar. Public feeds may fail because of temporary rate limits, CORS, or provider changes; the dashboard should not be treated as an emergency dispatch service.

## Enable TinyFish local-news search (optional)

TinyFish API keys must not be placed in this repository or in browser JavaScript. Deploy tinyfish-worker.js as a Cloudflare Worker.

1. In Cloudflare, create a Worker and paste the contents of tinyfish-worker.js.
2. Add TINYFISH_API_KEY as a **Worker secret**. Use the key from your TinyFish account.
3. Set ALLOWED_ORIGINS as a Worker variable to https://anggaconni.github.io. For a local test, add the local origin as a comma-separated value, such as https://anggaconni.github.io,http://localhost:8000.
4. Deploy the Worker and note its URL, for example https://your-worker.workers.dev.
5. Open index.html and set the following constant to your actual Worker endpoint:

   const TINYFISH_PROXY_URL = 'https://your-worker.workers.dev/nearby-intel';

6. Commit that change to main and reload the GitHub Pages site.

The Worker rounds the user coordinates before reverse-geocoding and sends a coarse locality to TinyFish, not the exact GPS coordinate. Results appear under News & OSINT as source-linked search signals. They are intentionally **not plotted as incident markers** because a news article does not by itself establish an exact event coordinate or confirm that the event happened as described.

## Next sources to consider

- TomTom or HERE Traffic Incidents for road disruptions, after checking Indonesia coverage and plan limits.
- NASA FIRMS for satellite fire hotspots (API key required).
- Official local police, city, and BPBD feeds where structured public endpoints are available.

Crime and road-accident coverage is not yet a complete, verified, real-time feed. TinyFish search results are leads for human review—not an official incident registry.
