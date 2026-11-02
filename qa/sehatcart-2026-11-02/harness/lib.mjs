// QA harness: per-role sessions, tRPC caller, page capture.
// Credentials are read from secrets/creds.json and are never printed.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const REPO = process.env.QA_REPO ?? '/home/user/devfathom-commercial';
const require = createRequire(`${REPO}/package.json`);
const { chromium, request: pwRequest } = require('playwright');

// Working dir for session state and raw outputs. Never inside the repo: it holds session cookies.
export const SCRATCH = process.env.QA_SCRATCH ?? '/tmp/claude-0/-home-user-devfathom-commercial/bd6f7ae8-902c-5eda-9008-d081b386469b/scratchpad';
export const EVIDENCE = process.env.QA_EVIDENCE ?? `${REPO}/qa-evidence`;
// Credentials file (never committed): {baseUrl, owner|cashier|manager|pharmacist: {email, password}}
const CREDS = JSON.parse(fs.readFileSync(process.env.QA_CREDS ?? path.join(SCRATCH, 'secrets/creds.json'), 'utf8'));
export const BASE = CREDS.baseUrl;
export const ROLES = ['owner', 'cashier', 'manager', 'pharmacist'];
const STATE_DIR = path.join(SCRATCH, 'state');
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(EVIDENCE, { recursive: true });

export function pkt(d = new Date()) {
  return new Date(d.getTime() + 5 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' PKT';
}

export function statePath(role) {
  return path.join(STATE_DIR, `${role}.json`);
}

let _browser;
export async function browser() {
  if (!_browser) _browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--headless=new', '--no-sandbox'] });
  return _browser;
}
export async function closeBrowser() {
  if (_browser) await _browser.close();
  _browser = undefined;
}

/** Log in through the real form and persist the session cookies. */
export async function login(role, { force = false } = {}) {
  if (!force && fs.existsSync(statePath(role))) {
    const age = Date.now() - fs.statSync(statePath(role)).mtimeMs;
    if (age < 45 * 60e3) return statePath(role);
  }
  const b = await browser();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form[data-hydrated="true"]', { timeout: 30000 }).catch(() => {});
  await page.fill('#email', CREDS[role].email);
  await page.fill('#password', CREDS[role].password);
  const t0 = Date.now();
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45000 }),
    page.click('button[type="submit"]'),
  ]);
  const ms = Date.now() - t0;
  await ctx.storageState({ path: statePath(role) });
  const landed = page.url();
  await ctx.close();
  return { state: statePath(role), landed, ms };
}

/**
 * New browser context for a role with optional viewport/theme/locale settings.
 *
 * The app ignores `prefers-color-scheme`: its theme comes only from
 * `localStorage['theme']` (src/components/theme-provider.tsx,
 * src/components/preference-bootstrap.tsx). So a dark run must also store the
 * app theme before any page script runs. `opts.theme` overrides the stored
 * theme; otherwise it follows `opts.colorScheme`.
 */
export async function roleContext(role, opts = {}) {
  const b = await browser();
  const colorScheme = opts.colorScheme ?? 'light';
  const ctx = await b.newContext({
    storageState: role ? statePath(role) : undefined,
    viewport: opts.viewport ?? { width: 1440, height: 900 },
    colorScheme,
    reducedMotion: opts.reducedMotion ?? 'no-preference',
    deviceScaleFactor: 1,
    ...(opts.extra ?? {}),
  });
  const theme = opts.theme ?? (colorScheme === 'dark' ? 'dark' : 'light');
  await ctx.addInitScript((value) => {
    try {
      window.localStorage.setItem('theme', value);
    } catch {}
  }, theme);
  return ctx;
}

/** Attach console/network capture to a page. */
export function capture(page) {
  const log = { console: [], failed: [], http: [], slow: [] };
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      log.console.push({ type: m.type(), text: m.text().slice(0, 400) });
    }
  });
  page.on('pageerror', (e) => log.console.push({ type: 'pageerror', text: String(e).slice(0, 400) }));
  page.on('requestfailed', (r) =>
    log.failed.push({ url: r.url().slice(0, 300), err: r.failure()?.errorText })
  );
  const starts = new Map();
  page.on('request', (r) => starts.set(r, Date.now()));
  page.on('response', async (r) => {
    const req = r.request();
    const t = starts.get(req);
    const ms = t ? Date.now() - t : null;
    const u = r.url();
    if (r.status() >= 400) {
      let body = '';
      try {
        body = (await r.text()).slice(0, 600);
      } catch {}
      log.http.push({ status: r.status(), method: req.method(), url: u.slice(0, 400), body, at: pkt() });
    }
    if (ms !== null && ms > 2000 && !u.includes('/_next/static')) {
      log.slow.push({ ms, status: r.status(), url: u.slice(0, 300) });
    }
  });
  return log;
}

/** tRPC call as a role using an API request context sharing the role's cookies. */
const _api = new Map();
export async function api(role) {
  if (!_api.has(role)) {
    _api.set(
      role,
      await pwRequest.newContext({
        baseURL: BASE,
        storageState: role ? statePath(role) : undefined,
        extraHTTPHeaders: { origin: BASE, referer: `${BASE}/pharmacy` },
      })
    );
  }
  return _api.get(role);
}
export async function disposeApis() {
  for (const a of _api.values()) await a.dispose();
  _api.clear();
}

let _sj;
async function sj() {
  if (!_sj) _sj = (await import(`${REPO}/node_modules/superjson/dist/index.js`)).default;
  return _sj;
}
export async function trpc(role, procPath, input, type = 'query') {
  const a = await api(role);
  const S = await sj();
  const t0 = Date.now();
  let res;
  const enc = input === undefined ? undefined : S.serialize(input);
  if (type === 'query') {
    const q = enc === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(enc))}`;
    res = await a.get(`/api/trpc/${procPath}${q}`);
  } else {
    res = await a.post(`/api/trpc/${procPath}`, {
      data: enc === undefined ? {} : enc,
      headers: { 'content-type': 'application/json' },
    });
  }
  const ms = Date.now() - t0;
  let body;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 500);
  }
  const err = body?.error?.json ?? body?.error;
  return {
    status: res.status(),
    ms,
    ok: res.status() < 400 && !err,
    code: err?.data?.code ?? null,
    message: err?.message ?? null,
    data: body?.result?.data?.json ?? body?.result?.data ?? null,
    raw: body,
    at: pkt(),
  };
}

export function short(r, n = 300) {
  const d = r.ok ? JSON.stringify(r.data) : `${r.code}: ${r.message}`;
  return `${r.status} ${r.ms}ms ${String(d).slice(0, n)}`;
}

export async function shot(page, name, opts = {}) {
  const p = path.join(EVIDENCE, `${name}.png`);
  await page.screenshot({ path: p, fullPage: opts.fullPage ?? false });
  return `qa-evidence/${name}.png`;
}

export function save(name, data) {
  const p = path.join(SCRATCH, 'out', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return p;
}
