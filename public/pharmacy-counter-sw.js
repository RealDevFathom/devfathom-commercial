/*
 * DevFathom pharmacy counter offline shell (DEV-957 phase 1).
 *
 * Registered only by an ENROLLED counter browser, with scope /pharmacy/counter,
 * so it controls the counter pages and nothing else. It keeps exactly three
 * things, and only after the counter page "arms" it:
 *
 *   1. the last counter page (/pharmacy/counter) the signed-in user loaded
 *      online, stored with its own response headers, so the per-request
 *      Content-Security-Policy nonce in the header still matches the nonce in
 *      the page's script tags when it is served offline;
 *   2. the build's immutable static files under /_next/static/ that the page uses;
 *   3. DEV-973: the static print page and its script (no data of their own), so a
 *      browser print opens and prints offline as fast as online. They are
 *      served from the store first and refreshed from the network behind it.
 *
 * Navigations go to the network first; the stored page is used only when the
 * network cannot be reached at all. It never touches a non-GET request, an API
 * or tRPC call (/api/...), a React Server Component request, another origin, or
 * any other page. Signing out and revoking the counter delete every cache.
 * Tenants are separate origins, so they never share these caches.
 */
'use strict';

const SHELL_CACHE = 'devfathom-pharmacy-counter-shell-v1';
const ASSET_CACHE = 'devfathom-pharmacy-counter-assets-v1';
const PRINT_CACHE = 'devfathom-pharmacy-counter-print-v1';
const SHELL_PATH = '/pharmacy/counter';
const PRINT_PATHS = ['/pharmacy/counter/print-window.html', '/pharmacy/counter/print-window.js'];
const OWN_CACHES = [SHELL_CACHE, ASSET_CACHE, PRINT_CACHE];
/*
 * Bumped by every clear (sign-out, revocation). A store that started before a
 * clear never writes after it, and one that raced it is undone, so an in-flight
 * fetch can never put the previous person's page back.
 */
let generation = 0;

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function isShellNavigation(request, url) {
  return (
    request.method === 'GET' &&
    request.mode === 'navigate' &&
    sameOrigin(url) &&
    url.pathname === SHELL_PATH
  );
}

function isPrintFile(request, url) {
  return (
    request.method === 'GET' &&
    sameOrigin(url) &&
    PRINT_PATHS.includes(url.pathname) &&
    !url.search &&
    !request.headers.get('range')
  );
}

function isStaticAsset(request, url) {
  return (
    request.method === 'GET' &&
    sameOrigin(url) &&
    url.pathname.startsWith('/_next/static/') &&
    !url.search &&
    !request.headers.get('rsc') &&
    !request.headers.get('range')
  );
}

/** Only a complete, same-origin, non-redirected 200 HTML page is kept. */
function storableShell(response) {
  return (
    Boolean(response) &&
    response.status === 200 &&
    response.type === 'basic' &&
    !response.redirected &&
    (response.headers.get('content-type') || '').includes('text/html')
  );
}

function storableAsset(response) {
  return Boolean(response) && response.status === 200 && response.type === 'basic';
}

async function armed() {
  return self.caches.has(SHELL_CACHE);
}

/** Write only if no clear happened since `started`; undo a write that raced one. */
async function guardedPut(cacheName, key, response, started) {
  if (started !== generation) return false;
  const cache = await self.caches.open(cacheName);
  if (started !== generation) {
    await clearAll();
    return false;
  }
  await cache.put(key, response);
  if (started !== generation) {
    await clearAll();
    return false;
  }
  return true;
}

function storeShell(response, started) {
  return guardedPut(SHELL_CACHE, SHELL_PATH, response, started);
}

async function shellResponse(request) {
  const started = generation;
  try {
    const response = await fetch(request);
    if (storableShell(response) && (await armed()))
      await storeShell(response.clone(), started);
    return response;
  } catch (error) {
    // `has` first: opening a cache creates it, and an existing shell cache is
    // what marks this worker as armed.
    const stored = (await self.caches.has(SHELL_CACHE))
      ? await (await self.caches.open(SHELL_CACHE)).match(SHELL_PATH)
      : undefined;
    if (stored) return stored;
    throw error;
  }
}

async function assetResponse(request) {
  const started = generation;
  const stored = (await self.caches.has(ASSET_CACHE))
    ? await (await self.caches.open(ASSET_CACHE)).match(request)
    : undefined;
  if (stored) return stored;
  const response = await fetch(request);
  if (storableAsset(response) && (await armed()))
    await guardedPut(ASSET_CACHE, request, response.clone(), started);
  return response;
}

/** Stored copy first, so an offline print opens at once; refreshed behind it. */
async function printResponse(request, url) {
  const started = generation;
  const key = url.origin + url.pathname;
  const stored = (await self.caches.has(PRINT_CACHE))
    ? await (await self.caches.open(PRINT_CACHE)).match(key)
    : undefined;
  const refresh = fetch(key, { credentials: 'same-origin' }).then(async (response) => {
    if (storableAsset(response) && (await armed()))
      await guardedPut(PRINT_CACHE, key, response.clone(), started);
    return response;
  });
  if (stored) {
    refresh.catch(() => undefined);
    return stored;
  }
  return refresh;
}

async function arm(assets) {
  const started = generation;
  const shell = await fetch(SHELL_PATH, { credentials: 'same-origin', cache: 'no-store' });
  if (!storableShell(shell)) return false;
  if (!(await storeShell(shell, started))) return false;
  for (const path of PRINT_PATHS) {
    if (started !== generation) return false;
    try {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
      if (storableAsset(response) && !(await guardedPut(PRINT_CACHE, self.location.origin + path, response, started)))
        return false;
    } catch {
      // Fetched again next time online; printing online still works.
    }
  }
  for (const href of Array.isArray(assets) ? assets.slice(0, 400) : []) {
    let url;
    try {
      url = new URL(href, self.location.origin);
    } catch {
      continue;
    }
    if (!sameOrigin(url) || !url.pathname.startsWith('/_next/static/') || url.search) continue;
    if (started !== generation) return false;
    if (await (await self.caches.open(ASSET_CACHE)).match(url.href)) continue;
    try {
      const response = await fetch(url.href, { credentials: 'same-origin' });
      if (storableAsset(response) && !(await guardedPut(ASSET_CACHE, url.href, response, started)))
        return false;
    } catch {
      // A missing asset only means that file is fetched again next time online.
    }
  }
  return started === generation;
}

async function clearAll() {
  generation += 1;
  await Promise.all(OWN_CACHES.map((name) => self.caches.delete(name)));
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await self.caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('devfathom-pharmacy-counter-') && !OWN_CACHES.includes(name))
          .map((name) => self.caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (isShellNavigation(request, url)) {
    event.respondWith(shellResponse(request));
    return;
  }
  if (isPrintFile(request, url)) {
    event.respondWith(printResponse(request, url));
    return;
  }
  if (isStaticAsset(request, url)) {
    event.respondWith(assetResponse(request));
  }
  // Everything else, including every /api/ and tRPC request, goes to the network untouched.
});

self.addEventListener('message', (event) => {
  if (event.origin && event.origin !== self.location.origin) return;
  const data = event.data || {};
  const reply = (value) => event.ports && event.ports[0] && event.ports[0].postMessage(value);
  if (data.type === 'arm') {
    event.waitUntil(
      arm(data.assets).then(
        (ok) => reply({ type: 'armed', ok }),
        () => reply({ type: 'armed', ok: false })
      )
    );
  } else if (data.type === 'clear') {
    event.waitUntil(clearAll().then(() => reply({ type: 'cleared' })));
  }
});
