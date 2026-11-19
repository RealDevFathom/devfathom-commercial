/**
 * DEV-957 phase 1: the page side of the counter's offline shell
 * (`public/pharmacy-counter-sw.js`). Only an enrolled counter browser arms it;
 * signing out or revoking the counter clears it. Client-only, best-effort: a
 * browser without service workers still sells online exactly as before.
 */
export const COUNTER_SHELL_SCRIPT = '/pharmacy-counter-sw.js';
export const COUNTER_SHELL_SCOPE = '/pharmacy/counter';
export const COUNTER_SHELL_CACHES = [
  'devfathom-pharmacy-counter-shell-v1',
  'devfathom-pharmacy-counter-assets-v1',
] as const;

function serviceWorkers(): ServiceWorkerContainer | null {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker;
}

/** The build's static files this page is using right now. */
export function counterShellAssets(doc: Document = document): string[] {
  const found = new Set<string>();
  const keep = (href: string | null | undefined) => {
    if (!href) return;
    try {
      const url = new URL(href, doc.baseURI);
      if (url.origin === new URL(doc.baseURI).origin && url.pathname.startsWith('/_next/static/'))
        found.add(url.pathname);
    } catch {
      // Ignore anything that is not a URL.
    }
  };
  doc.querySelectorAll('script[src]').forEach((node) => keep(node.getAttribute('src')));
  doc
    .querySelectorAll('link[href]')
    .forEach((node) => keep((node as HTMLLinkElement).getAttribute('href')));
  if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function')
    for (const entry of performance.getEntriesByType('resource')) keep(entry.name);
  return [...found].sort();
}

function ask(worker: ServiceWorker, message: unknown, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.postMessage(message, [channel.port2]);
  });
}

/** Install the shell for this counter page. Resolves true once the page is stored. */
export async function armCounterShell(): Promise<boolean> {
  const container = serviceWorkers();
  if (!container) return false;
  try {
    const registration = await container.register(COUNTER_SHELL_SCRIPT, {
      scope: COUNTER_SHELL_SCOPE,
    });
    const worker =
      registration.active ??
      (await new Promise<ServiceWorker | null>((resolve) => {
        const pending = registration.installing ?? registration.waiting;
        if (!pending) return resolve(null);
        const timer = setTimeout(() => resolve(null), 30_000);
        pending.addEventListener('statechange', () => {
          if (pending.state === 'activated') {
            clearTimeout(timer);
            resolve(pending);
          }
        });
      }));
    if (!worker) return false;
    const answer = (await ask(worker, { type: 'arm', assets: counterShellAssets() })) as {
      ok?: boolean;
    } | null;
    return answer?.ok === true;
  } catch {
    return false;
  }
}

/** Forget the stored counter page and files, and stop the shell. Never throws. */
export async function clearCounterShell(): Promise<void> {
  try {
    if (typeof caches !== 'undefined')
      await Promise.all(COUNTER_SHELL_CACHES.map((name) => caches.delete(name)));
  } catch {
    // Storage may be blocked; nothing is stored then either.
  }
  const container = serviceWorkers();
  if (!container) return;
  try {
    const registrations = await container.getRegistrations();
    await Promise.all(
      registrations
        .filter((registration) => new URL(registration.scope).pathname === COUNTER_SHELL_SCOPE)
        .map((registration) => registration.unregister())
    );
  } catch {
    // Best-effort: the caches above are already gone.
  }
}
