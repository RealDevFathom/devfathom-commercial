/*
 * DevFathom pharmacy counter offline shell (DEV-957 phase 1).
 *
 * Registered only by an ENROLLED counter browser, with scope /pharmacy/counter,
 * so it controls the counter pages and nothing else. It keeps exactly two
 * things, and only after the counter page "arms" it:
 *
 *   1. the last counter page (/pharmacy/counter) the signed-in user loaded
 *      online, stored with its own response headers, so the per-request
 *      Content-Security-Policy nonce in the header still matches the nonce in
 *      the page's script tags when it is served offline;
 *   2. the build's immutable static files under /_next/static/ that the page uses.
 *
 * Navigations go to the network first; the stored page is used only when the
 * network cannot be reached at all. It never touches a non-GET request, an API
 * or tRPC call (/api/...), a React Server Component request, another origin, or
 * any other page. Signing out and revoking the counter delete both caches.
 * Tenants are separate origins, so they never share these caches.
 */
'use strict';

const SHELL_CACHE = 'devfathom-pharmacy-counter-shell-v1';
const ASSET_CACHE = 'devfathom-pharmacy-counter-assets-v1';
const SHELL_PATH = '/pharmacy/counter';
const OWN_CACHES = [SHELL_CACHE, ASSET_CACHE];

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

async function storeShell(response) {
  const cache = await self.caches.open(SHELL_CACHE);
  await cache.put(SHELL_PATH, response);
}

async function shellResponse(request) {
  try {
    const response = await fetch(request);
    if (storableShell(response) && (await armed())) await storeShell(response.clone());
    return response;
  } catch (error) {
    const cache = await self.caches.open(SHELL_CACHE);
    const stored = await cache.match(SHELL_PATH);
    if (stored) return stored;
    throw error;
  }
}

async function assetResponse(request) {
  const cache = await self.caches.open(ASSET_CACHE);
  const stored = await cache.match(request);
  if (stored) return stored;
  const response = await fetch(request);
  if (storableAsset(response) && (await armed())) await cache.put(request, response.clone());
  return response;
}

async function arm(assets) {
  const shell = await fetch(SHELL_PATH, { credentials: 'same-origin', cache: 'no-store' });
  if (!storableShell(shell)) return false;
  await storeShell(shell);
  const cache = await self.caches.open(ASSET_CACHE);
  for (const href of Array.isArray(assets) ? assets.slice(0, 400) : []) {
    let url;
    try {
      url = new URL(href, self.location.origin);
    } catch {
      continue;
    }
    if (!sameOrigin(url) || !url.pathname.startsWith('/_next/static/') || url.search) continue;
    if (await cache.match(url.href)) continue;
    try {
      const response = await fetch(url.href, { credentials: 'same-origin' });
      if (storableAsset(response)) await cache.put(url.href, response);
    } catch {
      // A missing asset only means that file is fetched again next time online.
    }
  }
  return true;
}

async function clearAll() {
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
