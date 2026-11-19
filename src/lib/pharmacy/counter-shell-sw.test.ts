// @vitest-environment node
/**
 * DEV-957 phase 1: the counter's service worker (public/pharmacy-counter-sw.js),
 * run as written against an in-memory Cache Storage and a scripted network.
 * With the network cut it opens the counter page it stored (with that page's
 * own CSP header, so the nonce in the page still matches), never stores or
 * serves an API, tRPC or other page, keeps nothing before it is armed, and
 * forgets everything when cleared (sign-out, revocation).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { beforeEach, describe, expect, it } from 'vitest';

const ORIGIN = 'https://tenant.test';
const source = readFileSync(path.join(process.cwd(), 'public/pharmacy-counter-sw.js'), 'utf8');

class MemoryCache {
  rows = new Map<string, Response>();
  key(request: RequestInfo | URL) {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
    return new URL(url, ORIGIN).href;
  }
  async match(request: RequestInfo | URL) {
    return this.rows.get(this.key(request))?.clone();
  }
  async put(request: RequestInfo | URL, response: Response) {
    this.rows.set(this.key(request), response.clone());
  }
}

function harness() {
  const stores = new Map<string, MemoryCache>();
  const caches = {
    has: async (name: string) => stores.has(name),
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new MemoryCache());
      return stores.get(name)!;
    },
    delete: async (name: string) => stores.delete(name),
    keys: async () => [...stores.keys()],
  };
  let online = true;
  let nonce = 0;
  let counterAnswer: 'page' | 'redirect' | 'error' = 'page';
  let hold: Promise<void> | null = null;
  const fetched: string[] = [];
  const network = async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, ORIGIN);
    fetched.push(url.pathname);
    if (hold) await hold;
    if (!online) throw new TypeError('Failed to fetch');
    if (url.pathname === '/pharmacy/counter' && counterAnswer !== 'page') {
      const answer = new Response(counterAnswer === 'redirect' ? 'sign in' : 'oops', {
        status: counterAnswer === 'redirect' ? 200 : 500,
        headers: { 'content-type': 'text/html' },
      });
      Object.defineProperty(answer, 'type', { value: 'basic' });
      Object.defineProperty(answer, 'redirected', { value: counterAnswer === 'redirect' });
      return answer;
    }
    if (url.pathname === '/pharmacy/counter') {
      nonce += 1;
      const page = new Response(`<html><script nonce="n${nonce}"></script>counter for user</html>`, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': `script-src 'self' 'nonce-n${nonce}'`,
        },
      });
      Object.defineProperty(page, 'type', { value: 'basic' });
      return page;
    }
    const other = new Response(`body of ${url.pathname}`, {
      status: 200,
      headers: { 'content-type': url.pathname.startsWith('/_next/') ? 'text/javascript' : 'application/json' },
    });
    Object.defineProperty(other, 'type', { value: 'basic' });
    return other;
  };
  const listeners = new Map<string, (event: unknown) => void>();
  const self = {
    location: new URL(`${ORIGIN}/pharmacy-counter-sw.js`),
    caches,
    clients: { claim: async () => undefined },
    skipWaiting: () => undefined,
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
  };
  vm.runInNewContext(source, { self, fetch: network, URL, Response, Request, Promise, Array, Boolean, TypeError });

  async function request(url: string, init: { mode?: string; method?: string; headers?: Record<string, string> } = {}) {
    const req = {
      url: new URL(url, ORIGIN).href,
      method: init.method ?? 'GET',
      mode: init.mode ?? 'cors',
      headers: new Headers(init.headers ?? {}),
    };
    let responded: Promise<Response> | null = null;
    listeners.get('fetch')!({ request: req, respondWith: (value: Promise<Response>) => (responded = value) });
    if (!responded) return { handled: false as const, response: await network(req.url) };
    return { handled: true as const, response: await responded };
  }
  async function message(data: unknown) {
    return send(data).done;
  }
  function send(data: unknown) {
    let waited: Promise<unknown> = Promise.resolve();
    let reply: unknown = null;
    listeners.get('message')!({
      origin: ORIGIN,
      data,
      ports: [{ postMessage: (value: unknown) => (reply = value) }],
      waitUntil: (value: Promise<unknown>) => (waited = value),
    });
    return { done: waited.then(() => reply) };
  }
  return {
    stores,
    fetched,
    request,
    message,
    send,
    setOnline: (value: boolean) => (online = value),
    answerCounterWith: (value: typeof counterAnswer) => (counterAnswer = value),
    holdNetwork: () => {
      let release!: () => void;
      hold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

let sw: ReturnType<typeof harness>;
beforeEach(() => {
  sw = harness();
});

describe('DEV-957 counter service worker', () => {
  it('stores nothing until the enrolled counter arms it', async () => {
    await sw.request('/pharmacy/counter', { mode: 'navigate' });
    await sw.request('/_next/static/chunks/app.js');
    expect(sw.stores.size).toBe(0);
    sw.setOnline(false);
    await expect(sw.request('/pharmacy/counter', { mode: 'navigate' })).rejects.toThrow();
    // An offline miss must not create the shell cache, which would arm the worker.
    expect(sw.stores.size).toBe(0);
    sw.setOnline(true);
    await sw.request('/pharmacy/counter', { mode: 'navigate' });
    expect(sw.stores.size).toBe(0);
  });

  it('never lets a store that was in flight during a clear put the page back', async () => {
    await sw.message({ type: 'arm', assets: [] });
    // A navigation's refresh is on the wire when the person signs out.
    const release = sw.holdNetwork();
    const navigation = sw.request('/pharmacy/counter', { mode: 'navigate' });
    const arming = sw.send({ type: 'arm', assets: ['/_next/static/chunks/app.js'] });
    expect(await sw.message({ type: 'clear' })).toEqual({ type: 'cleared' });
    release();
    await navigation;
    expect(await arming.done).toEqual({ type: 'armed', ok: false });
    expect(sw.stores.has('devfathom-pharmacy-counter-shell-v1')).toBe(false);
    expect(sw.stores.has('devfathom-pharmacy-counter-assets-v1')).toBe(false);
    sw.setOnline(false);
    await expect(sw.request('/pharmacy/counter', { mode: 'navigate' })).rejects.toThrow();
  });

  it('opens the stored counter page with no connection, with its own CSP header and nonce', async () => {
    expect(await sw.message({ type: 'arm', assets: ['/_next/static/chunks/app.js', 'https://cdn.test/x.js', '/api/trpc/x'] })).toEqual({ type: 'armed', ok: true });
    sw.setOnline(false);
    const { response } = await sw.request('/pharmacy/counter?branchId=b1', { mode: 'navigate' });
    const html = await response.text();
    const csp = response.headers.get('content-security-policy')!;
    const nonce = /nonce="([^"]+)"/.exec(html)![1];
    expect(csp).toContain(`'nonce-${nonce}'`);
    const asset = await sw.request('/_next/static/chunks/app.js');
    expect(asset.handled).toBe(true);
    expect(await asset.response.text()).toBe('body of /_next/static/chunks/app.js');
    // Only same-origin build files were stored, never a foreign or API URL.
    const assets = [...sw.stores.get('devfathom-pharmacy-counter-assets-v1')!.rows.keys()];
    expect(assets).toEqual([`${ORIGIN}/_next/static/chunks/app.js`]);
  });

  it('goes to the network first and refreshes the stored page while online', async () => {
    await sw.message({ type: 'arm', assets: [] });
    const first = await (await sw.request('/pharmacy/counter', { mode: 'navigate' })).response.text();
    sw.setOnline(false);
    const offline = await (await sw.request('/pharmacy/counter', { mode: 'navigate' })).response.text();
    expect(offline).toBe(first);
  });

  it('never handles API, tRPC, RSC, non-GET or other pages', async () => {
    await sw.message({ type: 'arm', assets: [] });
    for (const [url, init] of [
      ['/api/trpc/pharmacySales.counterSearch', {}],
      ['/api/pharmacy/counter/snapshot', { method: 'POST' }],
      ['/pharmacy/counter', { headers: { rsc: '1' } }],
      ['/pharmacy/counter/close', { mode: 'navigate' }],
      ['/pharmacy/counterfeit', { mode: 'navigate' }],
      ['/dashboard', { mode: 'navigate' }],
      ['/_next/static/chunks/app.js', { method: 'POST' }],
      ['/_next/static/chunks/app.js?v=2', {}],
      ['https://other.test/_next/static/chunks/app.js', {}],
    ] as const) {
      const result = await sw.request(url, init as never);
      expect(result.handled, url).toBe(false);
    }
    const shell = [...sw.stores.get('devfathom-pharmacy-counter-shell-v1')!.rows.keys()];
    expect(shell).toEqual([`${ORIGIN}/pharmacy/counter`]);
  });

  it('does not store a redirect to sign-in or an error page as the counter', async () => {
    await sw.message({ type: 'arm', assets: [] });
    const stored = await (await sw.request('/pharmacy/counter', { mode: 'navigate' })).response.text();
    for (const answer of ['redirect', 'error'] as const) {
      sw.answerCounterWith(answer);
      const passed = await sw.request('/pharmacy/counter', { mode: 'navigate' });
      expect(passed.handled).toBe(true);
      expect(await passed.response.text()).toBe(answer === 'redirect' ? 'sign in' : 'oops');
    }
    sw.setOnline(false);
    const offline = await (await sw.request('/pharmacy/counter', { mode: 'navigate' })).response.text();
    expect(offline).toBe(stored);
    // Arming against a sign-in redirect stores nothing new and says so.
    sw.setOnline(true);
    sw.answerCounterWith('redirect');
    expect(await sw.message({ type: 'arm', assets: [] })).toEqual({ type: 'armed', ok: false });
  });

  it('forgets the stored page and files when cleared', async () => {
    await sw.message({ type: 'arm', assets: ['/_next/static/chunks/app.js'] });
    expect(await sw.message({ type: 'clear' })).toEqual({ type: 'cleared' });
    expect(sw.stores.has('devfathom-pharmacy-counter-shell-v1')).toBe(false);
    expect(sw.stores.has('devfathom-pharmacy-counter-assets-v1')).toBe(false);
    sw.setOnline(false);
    await expect(sw.request('/pharmacy/counter', { mode: 'navigate' })).rejects.toThrow();
  });
});
