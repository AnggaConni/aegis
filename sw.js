const SHELL_CACHE = 'civilaegis-shell-v10';
const VENDOR_CACHE = 'civilaegis-vendor-v1';
const APP_SHELL = ['./', './index.html', './manifest.json', './icon.svg'];
const VENDOR_HOSTS = new Set([
    'cdn.tailwindcss.com',
    'unpkg.com',
    'cdnjs.cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
]);

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        await Promise.allSettled(APP_SHELL.map(path => cache.add(path)));
        self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter(name => name.startsWith('civilaegis-') && ![SHELL_CACHE, VENDOR_CACHE].includes(name))
            .map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

async function networkFirst(request, fallbackRequest) {
    try {
        const response = await fetch(request);
        if (response && (response.ok || response.type === 'opaque')) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put(fallbackRequest || request, response.clone()).catch(() => {});
        }
        return response;
    } catch (error) {
        const cached = await caches.match(request) || (fallbackRequest ? await caches.match(fallbackRequest) : null);
        if (cached) return cached;
        throw error;
    }
}

async function cacheVendorResource(request) {
    const cached = await caches.match(request, { ignoreVary: true });
    try {
        const response = await fetch(request);
        if (response && (response.ok || response.type === 'opaque')) {
            const cache = await caches.open(VENDOR_CACHE);
            cache.put(request, response.clone()).catch(() => {});
        }
        return response;
    } catch (error) {
        if (cached) return cached;
        throw error;
    }
}

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin === self.location.origin) {
        if (request.mode === 'navigate') {
            event.respondWith(networkFirst(request, new URL('./index.html', self.location.href).toString()));
            return;
        }

        // Only cache same-origin app assets. API responses are deliberately not intercepted or cached here.
        if (/\.(?:html|json|svg|css|js)$/.test(url.pathname) || url.pathname.endsWith('/')) {
            event.respondWith((async () => {
                const cached = await caches.match(request);
                if (cached) {
                    // Refresh app assets in the background so future offline sessions have the latest copy.
                    fetch(request).then(async response => {
                        if (response && response.ok) {
                            const cache = await caches.open(SHELL_CACHE);
                            await cache.put(request, response.clone());
                        }
                    }).catch(() => {});
                    return cached;
                }
                return networkFirst(request);
            })());
        }
        return;
    }

    // Cache essential vendor scripts/styles/fonts after their first successful online load.
    // Public map tiles and live safety/routing API responses are intentionally excluded.
    if (VENDOR_HOSTS.has(url.hostname)) {
        event.respondWith(cacheVendorResource(request));
    }
});
