/* CivilAegis service worker — GitHub Pages + offline-first cache.
 * Cached alerts may be stale. Offline mode does not verify live conditions.
 */
const APP_VERSION = 'v17';
const CACHE_PREFIX = 'civilaegis-';
const SHELL_CACHE = CACHE_PREFIX + 'shell-' + APP_VERSION;
const RUNTIME_CACHE = CACHE_PREFIX + 'runtime-' + APP_VERSION;
const VENDOR_CACHE = CACHE_PREFIX + 'vendor-' + APP_VERSION;
const TILE_CACHE = CACHE_PREFIX + 'tiles-' + APP_VERSION;
const DATA_CACHE = CACHE_PREFIX + 'data-' + APP_VERSION;

const BASE_PATH = new URL('./', self.location.href);
const APP_SHELL = [
  new URL('./', BASE_PATH).href,
  new URL('./index.html', BASE_PATH).href,
  new URL('./manifest.json', BASE_PATH).href,
  new URL('./icon.svg', BASE_PATH).href,
  new URL('./icon/launchericon-48x48.png', BASE_PATH).href,
  new URL('./icon/launchericon-72x72.png', BASE_PATH).href,
  new URL('./icon/launchericon-96x96.png', BASE_PATH).href,
  new URL('./icon/launchericon-144x144.png', BASE_PATH).href,
  new URL('./icon/launchericon-192x192.png', BASE_PATH).href,
  new URL('./icon/launchericon-512x512.png', BASE_PATH).href,
  new URL('./icon/screenshot-laptop.png', BASE_PATH).href,
  new URL('./icon/Mobile%20screenshot%20375x830.png', BASE_PATH).href
];

const VENDOR_HOSTS = new Set([
  'cdn.tailwindcss.com',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
]);
const TILE_HOSTS = new Set(['tile.openstreetmap.org']);
const DATA_HOSTS = new Set([
  'data.bmkg.go.id',
  'earthquake.usgs.gov',
  'www.gdacs.org',
  'gdacs.org',
  'eonet.gsfc.nasa.gov',
  'api.petabencana.id',
  'overpass-api.de',
  'nominatim.openstreetmap.org',
  'api.open-meteo.com',
  'router.project-osrm.org',
  'police.uk',
  'data.police.uk',
  'civilaegis-tinyfish-proxy.conniezz-cool.workers.dev'
]);

const MAX_TILE_ENTRIES = 350;
const MAX_DATA_ENTRIES = 100;
const MAX_RUNTIME_ENTRIES = 80;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // An optional asset failing should not prevent the app shell from installing.
    await Promise.allSettled(APP_SHELL.map(async url => {
      const response = await fetch(url, { cache: 'reload' });
      if (response.ok) await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, RUNTIME_CACHE, VENDOR_CACHE, TILE_CACHE, DATA_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith(CACHE_PREFIX) && !keep.has(key))
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

function isCacheable(response) {
  return !!response && (response.ok || response.type === 'opaque');
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    await Promise.all(keys.slice(0, keys.length - maxEntries).map(key => cache.delete(key)));
  }
}

async function cacheFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) {
    // Return local copy immediately; refresh quietly for the next visit.
    fetch(request).then(async response => {
      if (isCacheable(response)) {
        await cache.put(request, response.clone());
        if (maxEntries) await trimCache(cacheName, maxEntries);
      }
    }).catch(() => {});
    return cached;
  }
  const response = await fetch(request);
  if (isCacheable(response)) {
    await cache.put(request, response.clone());
    if (maxEntries) await trimCache(cacheName, maxEntries);
  }
  return response;
}

async function networkFirst(request, fallbackUrl, cacheName = RUNTIME_CACHE, maxEntries = MAX_RUNTIME_ENTRIES) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      await cache.put(request, response.clone());
      if (fallbackUrl) await cache.put(fallbackUrl, response.clone());
      if (maxEntries) await trimCache(cacheName, maxEntries);
    }
    return response;
  } catch (error) {
    const direct = await cache.match(request, { ignoreVary: true });
    if (direct) return direct;
    const fallback = fallbackUrl ? await caches.match(fallbackUrl, { ignoreVary: true }) : null;
    if (fallback) return fallback;
    throw error;
  }
}

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isTileRequest(url) {
  return TILE_HOSTS.has(url.hostname) &&
    /\/(?:\d+)\/(?:\d+)\/(?:\d+)(?:\.png|\.jpg|\.webp)?$/i.test(url.pathname);
}

function isLikelyDataRequest(url, request) {
  if (['document', 'script', 'style', 'font', 'image'].includes(request.destination)) return false;
  if (DATA_HOSTS.has(url.hostname)) return true;
  return /\.(?:geojson|json)$/i.test(url.pathname);
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Network-first document with a reliable app-shell fallback.
  if (request.mode === 'navigate' && isSameOrigin(url)) {
    event.respondWith(networkFirst(
      request,
      new URL('./index.html', BASE_PATH).href,
      RUNTIME_CACHE,
      MAX_RUNTIME_ENTRIES
    ));
    return;
  }

  if (isSameOrigin(url)) {
    if (url.pathname.endsWith('/manifest.json') ||
        /\.(?:html|js|css|json|svg|png|webp|ico)$/i.test(url.pathname)) {
      event.respondWith(cacheFirst(request, SHELL_CACHE, 100));
    } else {
      event.respondWith(networkFirst(request, null, RUNTIME_CACHE, MAX_RUNTIME_ENTRIES));
    }
    return;
  }

  // Store only tiles the person has actually viewed while online.
  if (isTileRequest(url)) {
    event.respondWith(cacheFirst(request, TILE_CACHE, MAX_TILE_ENTRIES));
    return;
  }

  if (VENDOR_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(request, VENDOR_CACHE, 60));
    return;
  }

  // Public GET feeds use network-first and fall back to the latest cached response.
  // Browser CORS rules remain in force; the service worker cannot bypass them.
  if (isLikelyDataRequest(url, request)) {
    event.respondWith(networkFirst(request, null, DATA_CACHE, MAX_DATA_ENTRIES));
  }
});
