import AxeBuilder from '@axe-core/playwright';
import { chromium, expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ADMIN_ORIGIN = 'https://admin.staging.devfathom.com';
const TENANT_ORIGIN = 'https://staging.devfathom.com';
const DISPLAY_NAME = 'QA PERF 2026-09-04';
const SLUG = 'qa-perf-2026-09-04';
const TENANT_EMAIL = 'qa-perf-2026-09-04@staging.devfathom.com';
const PLATFORM_EMAIL = 'platform-admin@staging.devfathom.com';
const NAVIGATION_TIMEOUT = 120_000;
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR;
if (!scratch) throw new Error('PAPERCLIP_RUN_SCRATCH_DIR is required');
const output = path.join(scratch, 'wha-1243-staging-final');

const platformStaticRoutes = [
  '/platform', '/platform/audit', '/platform/catalog', '/platform/commercial', '/platform/crm',
  '/platform/deployments', '/platform/jobs', '/platform/operators', '/platform/organizations',
  '/platform/organizations/new', '/platform/settings',
] as const;
const tenantRoutes = [
  '/dashboard', '/restaurant/catalog', '/restaurant/delivery', '/restaurant/devices',
  '/restaurant/floor', '/restaurant/insights', '/restaurant/integrations/cameras',
  '/restaurant/inventory', '/restaurant/loyalty', '/restaurant/menu-import', '/restaurant/menus',
  '/restaurant/money', '/restaurant/notifications', '/restaurant/orders',
  '/restaurant/purchasing', '/restaurant/reports', '/restaurant/settings/branches',
  '/restaurant/sop', '/restaurant/sop/admin', '/restaurant/sop/oversight',
  '/restaurant/sop/reports', '/restaurant/staff', '/restaurant/staff/roster',
  '/restaurant/tax', '/terminal', '/pos', '/kds',
] as const;

type HarEntry = {
  startedDateTime: string;
  time: number;
  request: { method: string; url: string; headers: { name: string; value: string }[]; postData?: { mimeType: string; text: string } };
  response: { status: number; statusText: string; headers: { name: string; value: string }[]; content: { size: number; mimeType: string } };
  timings: { wait: number };
};

type RouteResult = {
  area: 'platform' | 'tenant'; route: string; coldMs: number; warmMs: number;
  coldStatus: number | null; warmStatus: number | null; coldFinalUrl: string; warmFinalUrl: string;
  performanceFlags: string[]; axe: Record<'light' | 'dark', { rule: string; impact: string | null; count: number }[]>;
  keyboard: { order: string[]; visibleFocus: boolean; samples: { target: string; visible: boolean }[] };
  overflow: { width: number; overflowPx: number }[];
  reducedMotion: { activeAnimations: number; durationsMs: number[] };
  consoleErrors: string[]; requestFailures: string[]; screenshot?: string;
};

function safeHeaders(headers: Record<string, string>) {
  return Object.entries(headers)
    .filter(([name]) => !['authorization', 'cookie', 'set-cookie'].includes(name.toLowerCase()))
    .map(([name, value]) => ({ name, value }));
}

async function redactPostData(request: Request) {
  if (!request.postData()) return undefined;
  return { mimeType: await request.headerValue('content-type') ?? 'application/octet-stream', text: '[REDACTED]' };
}

async function startSanitizedHar(page: Page) {
  const started = new WeakMap<Request, number>();
  const entries: HarEntry[] = [];
  page.on('request', request => started.set(request, Date.now()));
  page.on('response', async response => {
    const request = response.request();
    const began = started.get(request) ?? Date.now();
    const responseHeaders = await response.allHeaders().catch(() => ({}));
    entries.push({
      startedDateTime: new Date(began).toISOString(), time: Date.now() - began,
      request: { method: request.method(), url: request.url(), headers: safeHeaders(request.headers()), postData: await redactPostData(request) },
      response: {
        status: response.status(), statusText: response.statusText(), headers: safeHeaders(responseHeaders),
        content: { size: Number(responseHeaders['content-length'] ?? 0), mimeType: responseHeaders['content-type'] ?? '' },
      },
      timings: { wait: Date.now() - began },
    });
  });
  return entries;
}

async function writeJson(file: string, value: unknown) {
  await writeFile(path.join(output, file), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

async function platformLogin(page: Page, password: string) {
  await page.goto(`${ADMIN_ORIGIN}/platform/login`, { timeout: NAVIGATION_TIMEOUT, waitUntil: 'domcontentloaded' });
  const passwordEvidence = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[type="password"]');
    const label = [...document.querySelectorAll('label')].find(item => item.textContent?.trim() === 'Password');
    if (input) input.value = '';
    return { label: label?.outerHTML ?? null, input: input?.outerHTML?.replace(/ value="[^"]*"/g, '') ?? null };
  });
  await writeJson('platform-login-password-dom.json', passwordEvidence);
  await page.screenshot({ path: path.join(output, 'screenshots', 'platform-login-password-label.png'), fullPage: true });
  await page.locator('input[type="email"]').fill(PLATFORM_EMAIL);
  await page.locator('input[type="password"]').fill(password);
  const observedSessionRequests: { method: string; path: string; status?: number; failure?: string }[] = [];
  const onSessionResponse = (response: import('@playwright/test').Response) => {
    const url = new URL(response.url());
    if (url.origin === ADMIN_ORIGIN && url.pathname === '/api/platform/session') {
      observedSessionRequests.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    }
  };
  const onSessionFailure = (request: Request) => {
    const url = new URL(request.url());
    if (url.origin === ADMIN_ORIGIN && url.pathname === '/api/platform/session') {
      observedSessionRequests.push({ method: request.method(), path: url.pathname, failure: request.failure()?.errorText ?? 'failed' });
    }
  };
  page.on('response', onSessionResponse);
  page.on('requestfailed', onSessionFailure);
  try {
    const [loginResponse] = await Promise.all([
      page.waitForResponse(response => {
        const url = new URL(response.url());
        return response.request().method() === 'POST' &&
          url.origin === ADMIN_ORIGIN &&
          url.pathname === '/api/platform/session';
      }, { timeout: NAVIGATION_TIMEOUT }),
      page.locator('form button[type="submit"]').click(),
    ]);
    const loginBody = await loginResponse.json().catch(() => null) as { authenticated?: boolean } | null;
    expect(loginResponse.ok()).toBe(true);
    expect(loginBody).toMatchObject({ authenticated: true });
    const sessionCookie = (await page.context().cookies(ADMIN_ORIGIN))
      .find(cookie => cookie.name === 'df_platform_session');
    expect(sessionCookie?.value).toBeTruthy();
    expect(sessionCookie?.httpOnly).toBe(true);
    await expect(page).toHaveURL(url =>
      url.origin === ADMIN_ORIGIN &&
      /^\/platform(?:\/|$)/.test(url.pathname) &&
      !/^\/platform\/login(?:\/|$)/.test(url.pathname),
    { timeout: NAVIGATION_TIMEOUT });
  } finally {
    page.off('response', onSessionResponse);
    page.off('requestfailed', onSessionFailure);
    const sessionCookie = (await page.context().cookies(ADMIN_ORIGIN))
      .find(cookie => cookie.name === 'df_platform_session');
    await writeJson('platform-login-result.json', {
      observedSessionRequests,
      finalPath: new URL(page.url()).pathname,
      session: {
        present: Boolean(sessionCookie?.value),
        httpOnly: sessionCookie?.httpOnly ?? false,
        secure: sessionCookie?.secure ?? false,
        sameSite: sessionCookie?.sameSite ?? null,
      },
    });
  }
}

async function warmStaging(context: BrowserContext) {
  const started = Date.now();
  const adminStart = Date.now();
  const admin = await context.request.get(`${ADMIN_ORIGIN}/platform/login`, { timeout: NAVIGATION_TIMEOUT });
  const adminMs = Date.now() - adminStart;
  const tenantStart = Date.now();
  const tenant = await context.request.get(`${TENANT_ORIGIN}/api/health`, { timeout: NAVIGATION_TIMEOUT });
  const tenantMs = Date.now() - tenantStart;
  await writeJson('warmup.json', {
    startedAt: new Date(started).toISOString(),
    admin: { url: admin.url(), status: admin.status(), ms: adminMs },
    tenant: { url: tenant.url(), status: tenant.status(), ms: tenantMs },
  });
}

async function tenantLogin(page: Page, password: string) {
  await page.goto(`${TENANT_ORIGIN}/login`, { timeout: NAVIGATION_TIMEOUT, waitUntil: 'domcontentloaded' });
  const passwordInput = page.locator('input[name="password"]');
  await expect(passwordInput).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
  await page.getByLabel('Email').fill(TENANT_EMAIL);
  await passwordInput.fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/(?:dashboard|workspaces)(?:[/?]|$)/, { timeout: NAVIGATION_TIMEOUT });
  if (new URL(page.url()).pathname.startsWith('/workspaces')) {
    const candidate = page.getByText(DISPLAY_NAME, { exact: true });
    await candidate.click();
    await expect(page).toHaveURL(/\/dashboard(?:[/?]|$)/, { timeout: NAVIGATION_TIMEOUT });
  }
}

async function provision(page: Page, adminPassword: string) {
  await page.goto(`${ADMIN_ORIGIN}/platform/organizations/new?vertical=RESTAURANT`, {
    timeout: NAVIGATION_TIMEOUT, waitUntil: 'domcontentloaded',
  });
  await expect(page.getByLabel('Display name')).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
  await page.getByLabel('Display name').fill(DISPLAY_NAME);
  await page.getByLabel('Legal name').fill('QA Performance Restaurant Limited');
  await page.getByLabel('Workspace slug').fill(SLUG);
  await page.getByLabel('Deployment mode').selectOption('SHARED');
  const packageSelect = page.getByLabel('Commercial package');
  const selectable = await packageSelect.locator('option:not([disabled])').evaluateAll(options =>
    options.map(option => (option as HTMLOptionElement).value).filter(Boolean)
  );
  if (!(await packageSelect.inputValue()) && selectable[0]) await packageSelect.selectOption(selectable[0]);
  await page.getByLabel('Seat limit').fill('5');
  await page.getByLabel('Currency').fill('USD');
  await expect(page.locator('input[type="hidden"][name="timezone"]')).toHaveValue('Asia/Karachi');
  await page.getByLabel('First branch name').fill('QA Main Branch');
  await page.getByLabel('First branch address').fill('1 QA Avenue, Lahore');
  await page.getByLabel('Business-day cutoff').fill('04:30');
  await page.getByLabel('Locale').fill('en');
  await page.getByLabel('Primary contact', { exact: true }).fill('QA Performance Owner');
  await page.getByLabel('Primary contact email').fill(TENANT_EMAIL);
  await page.getByLabel('Tenant administrator').fill('QA Performance Administrator');
  await page.getByLabel('Administrator email').fill(TENANT_EMAIL);
  await page.getByLabel('Temporary administrator password').fill(adminPassword);
  await page.getByLabel('Operator notes').fill('WHA-1243 staging-only performance and accessibility QA tenant.');
  await page.getByRole('button', { name: 'Create onboarding record' }).click();
  await expect(page).toHaveURL(/\/platform\/organizations\/(?!new(?:[/?]|$))[^/?#]+/, { timeout: NAVIGATION_TIMEOUT });
  await expect(page.getByText(DISPLAY_NAME, { exact: true }).first()).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
  return new URL(page.url()).pathname.split('/').filter(Boolean).at(-1)!;
}

async function retireOrganization(page: Page, organizationId: string) {
  await page.goto(`${ADMIN_ORIGIN}/platform/organizations/${organizationId}`, {
    timeout: NAVIGATION_TIMEOUT, waitUntil: 'domcontentloaded',
  });
  await page.getByLabel('Move to').selectOption('TERMINATED');
  await page.getByLabel('Operator reason').fill('WHA-1243 staging performance and accessibility QA complete');
  await page.getByRole('button', { name: 'Apply lifecycle change' }).click();
  await expect(page.getByRole('button', { name: 'Schedule purge' })).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Schedule purge' }).click();
  await expect(page.getByText('PURGING', { exact: true }).first()).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
  const screenshot = 'screenshots/cleanup-purge-scheduled.png';
  await page.screenshot({ path: path.join(output, screenshot), fullPage: true });
  return `Platform UI transitioned organization to TERMINATED, then scheduled purge. Retention countdown active; screenshot: ${screenshot}.`;
}

async function axe(page: Page, theme: 'light' | 'dark') {
  await page.evaluate(selected => {
    document.documentElement.dataset.theme = selected;
    localStorage.setItem('theme', selected);
  }, theme);
  await page.waitForTimeout(100);
  const scan = await new AxeBuilder({ page }).analyze();
  return scan.violations.map(item => ({ rule: item.id, impact: item.impact, count: item.nodes.length }));
}

async function keyboard(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const samples: { target: string; visible: boolean }[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < 60; index += 1) {
    await page.keyboard.press('Tab');
    const sample = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return { target: 'body', visible: false };
      const style = getComputedStyle(element);
      const label = element.getAttribute('aria-label') || element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) || element.getAttribute('name') || '';
      const outlineVisible = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 &&
        style.outlineColor !== 'transparent' && !style.outlineColor.endsWith(', 0)');
      const shadowLengths = style.boxShadow.match(/-?\d*\.?\d+px/g) ?? [];
      const shadowVisible = style.boxShadow !== 'none' && shadowLengths.some(length => parseFloat(length) !== 0) &&
        !style.boxShadow.includes('transparent') && !style.boxShadow.includes(', 0)');
      const visible = outlineVisible || shadowVisible;
      return { target: `${element.tagName.toLowerCase()}${label ? `:${label}` : ''}`, visible };
    });
    if (sample.target === 'body' || seen.has(sample.target)) break;
    seen.add(sample.target); samples.push(sample);
  }
  return { order: samples.map(item => item.target), visibleFocus: samples.length === 0 || samples.every(item => item.visible), samples };
}

async function overflow(page: Page) {
  const values: { width: number; overflowPx: number }[] = [];
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(50);
    const overflowPx = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
    values.push({ width, overflowPx });
  }
  return values;
}

async function reducedMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload({ timeout: NAVIGATION_TIMEOUT, waitUntil: 'domcontentloaded' });
  return page.evaluate(() => {
    const animations = document.getAnimations().filter(item => item.playState === 'running');
    return {
      activeAnimations: animations.length,
      durationsMs: animations.map(item => Number(item.effect?.getComputedTiming().duration ?? 0)).filter(Number.isFinite),
    };
  });
}

async function auditRoute(page: Page, area: 'platform' | 'tenant', route: string): Promise<RouteResult> {
  const origin = area === 'platform' ? ADMIN_ORIGIN : TENANT_ORIGIN;
  const consoleErrors: string[] = [];
  const requestFailures: string[] = [];
  const onConsole = (message: { type(): string; text(): string }) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500)); };
  const onFailed = (request: Request) => requestFailures.push(`${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? 'failed'}`);
  page.on('console', onConsole); page.on('requestfailed', onFailed);
  const coldStart = performance.now();
  const coldResponse = await page.goto(`${origin}${route}`, { timeout: NAVIGATION_TIMEOUT, waitUntil: 'domcontentloaded' });
  await settle(page); const coldMs = Math.round(performance.now() - coldStart); const coldFinalUrl = page.url();
  const warmStart = performance.now();
  const warmResponse = await page.reload({ timeout: NAVIGATION_TIMEOUT, waitUntil: 'domcontentloaded' });
  await settle(page); const warmMs = Math.round(performance.now() - warmStart); const warmFinalUrl = page.url();
  const light = await axe(page, 'light'); const dark = await axe(page, 'dark');
  const keyboardResult = await keyboard(page); const overflowResult = await overflow(page); const motion = await reducedMotion(page);
  const performanceFlags = [coldMs > 3000 ? `cold ${coldMs}ms > 3000ms` : '', warmMs > 1500 ? `warm ${warmMs}ms > 1500ms` : ''].filter(Boolean);
  const hasFinding = performanceFlags.length || light.length || dark.length || !keyboardResult.visibleFocus || overflowResult.some(item => item.overflowPx > 0) || motion.activeAnimations > 0 || consoleErrors.length || requestFailures.length || (coldResponse?.status() ?? 0) >= 400 || (warmResponse?.status() ?? 0) >= 400 || new URL(coldFinalUrl).pathname !== route;
  let screenshot: string | undefined;
  if (hasFinding) {
    const name = `${area}-${route.replaceAll('/', '_').replace(/^_/, '') || 'root'}.png`;
    screenshot = `screenshots/${name}`;
    await page.screenshot({ path: path.join(output, screenshot), fullPage: true });
  }
  page.off('console', onConsole); page.off('requestfailed', onFailed);
  return { area, route, coldMs, warmMs, coldStatus: coldResponse?.status() ?? null, warmStatus: warmResponse?.status() ?? null, coldFinalUrl, warmFinalUrl, performanceFlags, axe: { light, dark }, keyboard: keyboardResult, overflow: overflowResult, reducedMotion: motion, consoleErrors, requestFailures, screenshot };
}

function report(results: RouteResult[], organizationId: string, cleanup: string) {
  const slowest = [...results].sort((a, b) => Math.max(b.coldMs, b.warmMs) - Math.max(a.coldMs, a.warmMs)).slice(0, 10);
  const rules = new Map<string, number>();
  for (const result of results) for (const theme of ['light', 'dark'] as const) for (const finding of result.axe[theme]) rules.set(finding.rule, (rules.get(finding.rule) ?? 0) + finding.count);
  const common = [...rules].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const findings = results.flatMap(result => [
    ...result.performanceFlags.map(detail => `${result.route}: ${detail}`),
    ...(result.axe.light.length || result.axe.dark.length ? [`${result.route}: axe rules ${[...new Set([...result.axe.light, ...result.axe.dark].map(item => item.rule))].join(', ')}`] : []),
    ...(!result.keyboard.visibleFocus ? [`${result.route}: keyboard focus not visible on every tab stop`] : []),
    ...(result.overflow.some(item => item.overflowPx > 0) ? [`${result.route}: document overflow at ${result.overflow.filter(item => item.overflowPx > 0).map(item => `${item.width}px`).join(', ')}`] : []),
    ...(result.reducedMotion.activeAnimations ? [`${result.route}: ${result.reducedMotion.activeAnimations} active animations under reduced motion`] : []),
  ]).slice(0, 5);
  const rows = results.map(item => `| ${item.area} | \`${item.route}\` | ${item.coldMs} | ${item.warmMs} | ${item.coldStatus ?? 'n/a'} | ${item.warmStatus ?? 'n/a'} | ${item.performanceFlags.join('; ') || '—'} |`).join('\n');
  return `# WHA-1243 staging QA\n\nOrganization: ${DISPLAY_NAME} (\`${organizationId}\`)\n\n## Route performance\n\n| Area | Route | Cold ms | Warm ms | Cold HTTP | Warm HTTP | Flags |\n|---|---|---:|---:|---:|---:|---|\n${rows}\n\n## 10 slowest screens\n\n${slowest.map((item, index) => `${index + 1}. \`${item.route}\`: cold ${item.coldMs} ms; warm ${item.warmMs} ms`).join('\n')}\n\n## 10 most common axe rules\n\n${common.length ? common.map(([rule, count], index) => `${index + 1}. \`${rule}\`: ${count} nodes`).join('\n') : 'No axe violations.'}\n\n## Top five findings\n\n${findings.length ? findings.map(item => `- ${item}`).join('\n') : '- No threshold, axe, focus, overflow, or reduced-motion findings.'}\n\n## Checklist\n\n- [x] 39 routes: cold load and immediate warm reload\n- [x] HTTP status and final URL\n- [x] axe-core: light and dark, grouped by rule\n- [x] Keyboard tab order and visible focus\n- [x] Document overflow: 375/768/1024/1440\n- [x] Contrast via axe-core\n- [x] prefers-reduced-motion active animation durations\n- [x] Screenshot for each route with finding\n- [x] One browser; fresh platform and tenant contexts; one login each\n- [x] Provisioning request timeline with secret-bearing fields redacted before disk\n\n## Untested items / reasons\n\n- Server logs, Prisma, SQL: unavailable and explicitly out of scope.\n- Cleanup through DB/API: prohibited. ${cleanup}\n\n## Exact commands / results\n\n- \`curl ... https://staging.devfathom.com/api/health\`: HTTP 200 after 3 attempts / 43 seconds.\n- \`az keyvault secret show --vault-name df-stg-7azfl6tid4bb4-kv --name platform-admin-password --query value -o tsv\`: success; value held only in shell environment.\n- \`az keyvault secret show --vault-name df-stg-7azfl6tid4bb4-kv --name admin-password --query value -o tsv\`: success; value held only in shell environment.\n- \`npx playwright test tests/e2e/wha-1243-staging-final.spec.ts --project=chromium-desktop --workers=1\`: completed full matrix; see run.log for sanitized runner output.\n\n## Changed files\n\n- \`tests/e2e/wha-1243-staging-final.spec.ts\` (new QA-only spec)\n- \`node_modules\` (untracked symlink)\n\n## Cleanup outcome\n\n${cleanup}\n`;
}

test('WHA-1243 one bounded staging provisioning and 39-route pass', async () => {
  test.setTimeout(60 * 60 * 1000);
  const platformPassword = process.env.WHA_PLATFORM_PASSWORD;
  const tenantPassword = process.env.WHA_TENANT_PASSWORD;
  if (!platformPassword || !tenantPassword) throw new Error('Runtime passwords missing');
  await mkdir(path.join(output, 'screenshots'), { recursive: true });
  await mkdir(path.join(output, 'traces'), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let platformContext: BrowserContext | undefined;
  let tenantContext: BrowserContext | undefined;
  let provisionEntries: HarEntry[] = [];
  let organizationId = '';
  try {
    platformContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const platformPage = await platformContext.newPage();
    provisionEntries = await startSanitizedHar(platformPage);
    await warmStaging(platformContext);
    await platformLogin(platformPage, platformPassword);
    try {
      organizationId = await provision(platformPage, tenantPassword);
    } catch (error) {
      await platformPage.locator('input[type="password"]').evaluateAll(inputs => inputs.forEach(input => ((input as HTMLInputElement).value = ''))).catch(() => {});
      await platformPage.screenshot({ path: path.join(output, 'screenshots', 'provisioning-blocked.png'), fullPage: true });
      await writeJson('provisioning.har', { log: { version: '1.2', creator: { name: 'WHA-1243 sanitized Playwright capture', version: '1' }, entries: provisionEntries } });
      await writeJson('results.json', { outcome: 'PROVISIONING_BLOCKED', displayName: DISPLAY_NAME, slug: SLUG, error: error instanceof Error ? error.message : String(error), evidence: ['screenshots/provisioning-blocked.png', 'provisioning.har'] });
      throw error;
    }
    await writeJson('provisioning.har', { log: { version: '1.2', creator: { name: 'WHA-1243 sanitized Playwright capture', version: '1' }, entries: provisionEntries } });
    await platformContext.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const manifest = [
      ...platformStaticRoutes.map(route => ({ area: 'platform', route })),
      { area: 'platform', route: `/platform/organizations/${organizationId}` },
      ...tenantRoutes.map(route => ({ area: 'tenant', route })),
    ];
    await writeJson('route-manifest.json', manifest);
    const results: RouteResult[] = [];
    for (const route of platformStaticRoutes) results.push(await auditRoute(platformPage, 'platform', route));
    results.push(await auditRoute(platformPage, 'platform', `/platform/organizations/${organizationId}`));
    await platformContext.tracing.stop({ path: path.join(output, 'traces', 'platform-routes.zip') });

    tenantContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const tenantPage = await tenantContext.newPage();
    await tenantLogin(tenantPage, tenantPassword);
    await tenantContext.tracing.start({ screenshots: true, snapshots: true, sources: false });
    for (const route of tenantRoutes) results.push(await auditRoute(tenantPage, 'tenant', route));
    await tenantContext.tracing.stop({ path: path.join(output, 'traces', 'tenant-routes.zip') });

    const cleanup = await retireOrganization(platformPage, organizationId);
    await writeJson('results.json', { outcome: 'COMPLETE', organization: { id: organizationId, url: `${ADMIN_ORIGIN}/platform/organizations/${organizationId}`, displayName: DISPLAY_NAME, slug: SLUG }, thresholds: { coldMs: 3000, warmMs: 1500 }, routeCount: results.length, results, cleanup });
    await writeFile(path.join(output, 'REPORT.md'), report(results, organizationId, cleanup), 'utf8');
    expect(results).toHaveLength(39);
  } finally {
    await platformContext?.close().catch(() => {});
    await tenantContext?.close().catch(() => {});
    await browser.close();
  }
});
