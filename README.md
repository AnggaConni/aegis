# CivilAegis

CivilAegis is a static, browser-based personal-safety awareness map and route-planning PWA with TinyFish Search integration for location-aware incident reports and structural-risk context worldwide.

## Architecture

- **Frontend:** static HTML, Tailwind CSS, Leaflet, and browser storage; deployable on GitHub Pages.
- **TinyFish Search:** free web-search API used to find locally relevant incident reports and structural-risk context for the reverse-geocoded country, region and locality (not hardcoded to Indonesia). The current published free limits are 30 Search requests/minute and 500/hour.
- **Cloudflare Worker:** a lightweight proxy that keeps `TINYFISH_API_KEY` out of public browser code, validates inputs/origins, caches results, filters/deduplicates news leads, and exposes date/location confidence labels.
- **Other public data feeds:** BMKG, USGS, GDACS, NASA EONET, PetaBencana, OpenStreetMap/Overpass, Open-Meteo, OSRM public demo, and the UK Police API where supported.

TinyFish Search and Fetch are currently listed as free; paid Agent/Browser services are separate. Always check the current [TinyFish pricing page](https://www.tinyfish.ai/pricing). Cloudflare Workers Free currently lists 100,000 inbound requests/day; see [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## Features

- Interactive map and GPS location (permission required)
- Nearby public hazard and disaster feeds, with separate local (10 km) and qualifying regional (up to 50 km) context
- Location-aware incident reports and separate risk/prevalence context with publication/event dates, source URLs, geographic-scope labels, and verification limits
- One-way and round-trip driving route planning
- Route corridor checks against currently available mapped hazard data
- Saved reports, trip plans, and PDF export
- PWA shell and selected vendor-resource caching for limited offline use

## Safety and data limitations

Search results are evidence leads, not automatically verified reports of active incidents. CivilAegis separates (1) recently reported incidents, (2) historical incidents that can inform preparedness, and (3) structural-risk context such as prevalence studies and national surveys. A historical incident or prevalence study can justify proportionate prevention without proving an active event at the user's exact location. Undated information is labelled for review; publication dates, event dates, and study periods are not interchangeable. A missing report is not evidence that an area is safe.

The UK Police API is only queried where its geographic coverage applies; it is not a global police-crime feed. Hazard sources use different freshness windows: for example, USGS day-feed earthquakes, recent BMKG entries, PetaBencana community reports, GDACS alert records, and open NASA EONET event metadata. A regional signal is contextual and does not predict local impact. Points from NASA EONET polygons are intentionally excluded rather than misplotted as exact incident locations. Public feed availability, data coverage, rate limits, and terms can change. A missing report is **not evidence that an area is safe**. Cached data and saved routes can become stale, and live data/new routes require connectivity. CivilAegis is an awareness aid, not an emergency dispatch system or an official warning source.

## Configure TinyFish and Cloudflare Worker

1. Create a TinyFish account and copy its API key from the official dashboard.
2. Deploy `tinyfish-worker.js` to Cloudflare Workers using `wrangler.jsonc` or a Git-connected Worker project.
3. In Worker Settings → Variables and Secrets, add `TINYFISH_API_KEY` as a **secret** and `ALLOWED_ORIGINS` as a plain variable set to `https://anggaconni.github.io`.
4. Confirm the Worker endpoint ends in `/nearby-intel`.
5. Set `TINYFISH_PROXY_URL` in `index.html` to that endpoint and deploy the static site.

**Never put the TinyFish API key in `index.html`, a public JSON file, a GitHub Pages build, or any other client-side asset.** GitHub Actions secrets can be used only by workflows that explicitly reference them; they do not act as private runtime variables for a static website. See [GitHub's Actions secret documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).

The Worker includes a best-effort per-isolate request guard and response caching. Isolate-local rate limits are not a globally atomic quota; for higher-risk public exposure, add a Cloudflare edge rate-limiting rule and monitor usage.

## Run locally

Serve the repository through a local static HTTP server or deploy it via GitHub Pages. Browser geolocation and service-worker features require HTTPS or localhost.

## Tests

The GitHub Actions workflow checks Worker and service-worker syntax, frontend inline JavaScript syntax, and Worker regression tests:

```sh
node --check --input-type=module < tinyfish-worker.js
node --check sw.js
node --test tests/*.test.mjs
```

## License

No license file is currently included. Add a license before inviting others to reuse or redistribute the project.
