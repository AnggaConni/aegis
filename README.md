# CivilAegis

CivilAegis is a static, browser-based personal-safety awareness map and route-planning PWA.

## Free-only architecture

This repository build does not require TinyFish, a paid search API key, Cloudflare Workers, or a backend service. The frontend loads public feeds directly from the browser. Public services can change availability, rate limits, and terms; this project does not guarantee those services will always be available.

## Features

- Leaflet-based map and nearby public-safety/disaster signals
- GPS location when permission is granted, with an explicit fallback state
- One-way and round-trip driving route planning
- Route corridor warnings based on the data currently available to the app
- Saved reports and locally stored trip plans
- PDF export for saved reports
- PWA shell and selected vendor-resource caching for limited offline use

## Data sources and limitations

The frontend integrates public sources including BMKG, USGS, GDACS, PetaBencana, OpenStreetMap/Overpass, Open-Meteo, OSRM's public demo service, and the UK Police API where supported.

Coverage, freshness, and geographic precision vary by provider. The UK Police API does not provide Indonesian crime incidents. This free-only build disables external local-news/OSINT search, so it does not provide TinyFish-powered local news results.

A missing report is **not evidence that an area is safe**. Cached reports and saved routes can become stale; live feeds and new routes require connectivity. This is an awareness aid, not an emergency dispatch system or a source of official warnings. In an emergency, follow instructions from local authorities.

## Run locally

Serve this folder through a local static HTTP server or deploy it with GitHub Pages. Geolocation and service-worker features require a secure context (HTTPS, or localhost in local development). No API secret needs to be placed in the frontend.

## Checks

The GitHub Actions workflow checks the service-worker syntax and runs the frontend regression tests:

```sh
node --check sw.js
node --test tests/frontend-script-syntax.test.mjs
```

## Privacy and secrets

The app uses browser geolocation only to center the map and query relevant public feeds. Do not commit API keys to this public repository or inject them into client-side JavaScript: anything shipped to the browser can be inspected by visitors. GitHub Actions secrets are available to workflows that explicitly reference them, not as private runtime configuration for a static GitHub Pages frontend.

## License

No license file is currently included. Add a license before inviting others to reuse or redistribute the project.
