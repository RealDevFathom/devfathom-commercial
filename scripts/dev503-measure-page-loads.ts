/**
 * DEV-503: local page-load measurement for /pharmacy/medicines and /pharmacy/counter.
 * Every figure it prints is local, synthetic data, not staging.
 *
 * Drives a production build (`next start`) with headless Chromium against the guarded
 * pharmacy E2E database, seeded by scripts/seed-pharmacy-e2e.ts and
 * scripts/dev503-synthetic-medicines.ts. Method and results: docs/qa/dev-503/performance.md.
 *
 *   PHARMACY_E2E=1 PHARMACY_E2E_DATABASE_URL=… DATABASE_URL=<same> \
 *   PHARMACY_E2E_ADMIN_EMAIL=… PHARMACY_E2E_ADMIN_PASSWORD=… AUTH_SECRET=<local value> \
 *   bunx tsx scripts/dev503-measure-page-loads.ts <label> <built-checkout> <port> <runs> <out.json>
 *
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE optionally points at a preinstalled Chromium.
 *
 * Three modes, each the median of <runs> loads per URL:
 *   cold        a fresh `next start` process and an empty browser cache for every load;
 *   coldBrowser one started, idle, primed server; an empty browser cache for every load;
 *   warm        one server and one browser context, primed by two loads of each URL.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';

import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import pg from 'pg';

import { PHARMACY_E2E } from '../tests/e2e/pharmacy-counter-fixture';
import { pharmacyE2eEnvironment } from './pharmacy-e2e-environment';

const env = pharmacyE2eEnvironment();
const [label = 'run', checkout = '.', portArg = '4400', runsArg = '7', outJson = 'dev503.json'] =
  process.argv.slice(2);
const port = Number(portArg);
const runs = Number(runsArg);
const origin = `http://127.0.0.1:${port}`;
if (!env.AUTH_SECRET) throw new Error('AUTH_SECRET is required (any local value).');

type Ready = 'medicines' | 'counter';
type Sample = Record<'ttfb' | 'lcp' | 'usable' | 'load' | 'longTaskMs' | 'transferKb', number>;
const MODES = ['cold', 'coldBrowser', 'warm'] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const portBusy = () =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
const expectedNext = (
  JSON.parse(readFileSync(`${checkout}/node_modules/next/package.json`, 'utf8')) as {
    version: string;
  }
).version;

/** The newest staged batch, so one URL names its selection the way a pagination link does. */
async function latestBatch() {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [
        PHARMACY_E2E.organizationId,
      ]);
      const { rows } = await client.query<{ id: string; sourceId: string }>(
        `SELECT id, "sourceId" FROM pharmacy_migration_batches
          WHERE "organizationId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
        [PHARMACY_E2E.organizationId]
      );
      await client.query('COMMIT');
      if (!rows[0]) throw new Error('No staged batch: run dev503-synthetic-medicines.ts first.');
      return rows[0];
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function startServer() {
  if (await portBusy()) throw new Error(`Port ${port} is already in use.`);
  const child = spawn(
    'bunx',
    ['next', 'start', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: checkout,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        NODE_ENV: 'production',
        AUTH_TRUST_HOST: 'true',
        AUTH_URL: origin,
        SHARED_APP_HOSTS: '127.0.0.1,www.localhost',
        PLATFORM_BASE_DOMAIN: 'localhost',
        TRUSTED_PROXY_HOPS: '1',
      },
    }
  );
  let log = '';
  child.stdout?.on('data', (chunk) => (log += chunk));
  child.stderr?.on('data', (chunk) => (log += chunk));
  for (let i = 0; i < 600; i++) {
    if (/Ready in/.test(log)) {
      const version = /Next\.js (\d+\.\d+\.\d+)/.exec(log)?.[1];
      // A leftover server from another checkout would otherwise be measured silently.
      if (version !== expectedNext)
        throw new Error(`Expected Next.js ${expectedNext}, got ${version}`);
      return child;
    }
    if (child.exitCode !== null) throw new Error(`next start exited:\n${log}`);
    await sleep(100);
  }
  throw new Error(`next start did not become ready:\n${log}`);
}

async function stopServer(child: ChildProcess) {
  try {
    process.kill(-child.pid!, 'SIGTERM');
  } catch {}
  // next-server can outlive the bunx wrapper; wait until the port is really free.
  for (let i = 0; i < 100 && (await portBusy()); i++) {
    if (i === 25) spawnSync('pkill', ['-f', 'next-server']);
    await sleep(200);
  }
  if (await portBusy()) throw new Error('The server did not stop.');
}

async function signIn(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/login`);
  // Same hydration proof as the counter spec: the password toggle only works once hydrated.
  const password = page.getByRole('textbox', { name: 'Password' });
  for (let i = 0; i < 50 && (await password.getAttribute('type')) !== 'text'; i++) {
    await page
      .getByRole('button', { name: 'Show password' })
      .click()
      .catch(() => {});
    await sleep(200);
  }
  await page.getByLabel('Email').fill(env.PHARMACY_E2E_ADMIN_EMAIL!);
  await password.fill(env.PHARMACY_E2E_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const chooser = page.getByText('Choose a workspace', { exact: true });
  if (await chooser.isVisible({ timeout: 8000 }).catch(() => false))
    await page.getByRole('button', { name: /Fathom Pharmacy E2E/i }).click();
  await page.waitForURL(/\/(dashboard|pharmacy)/, { timeout: 60_000 });
  const state = await context.storageState();
  await context.close();
  return state;
}

async function measure(context: BrowserContext, path: string, ready: Ready): Promise<Sample> {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { __lcp: number; __longTasks: number[] };
    w.__lcp = 0;
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__lcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__longTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
  });
  await page.goto(origin + path, { waitUntil: 'commit', timeout: 120_000 });
  // Usable: the page's first control is on screen, enabled and hydrated by React.
  // Medicines: the first staged row link. Counter: the opening-cash field, which is
  // the first step on a counter device with no open drawer.
  await page.waitForFunction(
    (which) => {
      const element =
        which === 'medicines'
          ? document.querySelector('a[href*="rowId="]')
          : document.getElementById('counter-opening-cash');
      const usable =
        !!element &&
        !(element as HTMLInputElement).disabled &&
        Object.keys(element).some((key) => key.startsWith('__reactProps$'));
      const w = window as unknown as { __usable?: number };
      if (usable) w.__usable ??= performance.now();
      return usable;
    },
    ready,
    { polling: 'raf', timeout: 120_000 }
  );
  await page.waitForLoadState('load');
  await sleep(1500); // let LCP settle and long tasks report
  const { landed, ...sample } = await page.evaluate(() => {
    const w = window as unknown as { __lcp: number; __usable: number; __longTasks: number[] };
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    return {
      landed: location.pathname,
      ttfb: nav.responseStart,
      lcp: w.__lcp,
      usable: w.__usable,
      load: nav.loadEventEnd,
      longTaskMs: w.__longTasks.reduce((sum, duration) => sum + duration, 0),
      transferKb: resources.reduce((sum, r) => sum + r.transferSize, nav.transferSize) / 1024,
    };
  });
  await page.close();
  if (!path.startsWith(landed)) throw new Error(`${path} landed on ${landed}`);
  return sample;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

async function main() {
  const batch = await latestBatch();
  const pages: Record<string, { path: string; ready: Ready }> = {
    medicines: { path: '/pharmacy/medicines', ready: 'medicines' },
    medicinesPaged: {
      path: `/pharmacy/medicines?${new URLSearchParams({
        branchId: PHARMACY_E2E.branchId,
        sourceId: batch.sourceId,
        batchId: batch.id,
        page: '2',
      })}`,
      ready: 'medicines',
    },
    counter: { path: '/pharmacy/counter', ready: 'counter' },
  };
  const names = Object.keys(pages);
  const results = Object.fromEntries(
    MODES.map((mode) => [mode, Object.fromEntries(names.map((name) => [name, [] as Sample[]]))])
  ) as Record<(typeof MODES)[number], Record<string, Sample[]>>;
  const run = (context: BrowserContext, name: string) =>
    measure(context, pages[name]!.path, pages[name]!.ready);

  // Optional: a preinstalled Chromium when it differs from the one this Playwright pins.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  let server = await startServer();
  const state = await signIn(browser);
  await stopServer(server);

  for (let i = 0; i < runs; i++)
    for (const name of names) {
      server = await startServer();
      const context = await browser.newContext({ storageState: state });
      results.cold[name]!.push(await run(context, name));
      await context.close();
      await stopServer(server);
    }

  server = await startServer();
  await sleep(10_000); // let the startup preload of every route finish
  const primer = await browser.newContext({ storageState: state });
  for (const name of names) for (let i = 0; i < 2; i++) await run(primer, name);
  await primer.close();
  for (let i = 0; i < runs; i++)
    for (const name of names) {
      const context = await browser.newContext({ storageState: state });
      results.coldBrowser[name]!.push(await run(context, name));
      await context.close();
    }
  await stopServer(server);

  server = await startServer();
  const context = await browser.newContext({ storageState: state });
  for (const name of names) for (let i = 0; i < 2; i++) await run(context, name);
  for (let i = 0; i < runs; i++)
    for (const name of names) results.warm[name]!.push(await run(context, name));
  await context.close();
  await stopServer(server);
  await browser.close();

  const summary = Object.fromEntries(
    MODES.flatMap((mode) =>
      names.map((name) => {
        const samples = results[mode][name]!;
        const keys = Object.keys(samples[0]!) as (keyof Sample)[];
        return [
          `${mode}.${name}`,
          Object.fromEntries(keys.map((k) => [k, Math.round(median(samples.map((s) => s[k])))])),
        ];
      })
    )
  );
  const report = {
    label,
    note: 'local, synthetic data, not staging',
    next: expectedNext,
    runs,
    summary,
    results,
  };
  writeFileSync(outJson, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ label, next: expectedNext, summary }, null, 1));
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  }
);
