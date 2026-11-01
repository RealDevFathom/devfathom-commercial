import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
async function captureState(page: Page, name: string) {
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.screenshot({
      caret: 'initial',
      style: 'nextjs-portal { visibility: hidden !important; }',
      path: `/tmp/login-shots/${name}-${width}.png`,
      fullPage: true,
    });
  }
}
const screens = [
  ['neutral-sign-in', '/login'],
  ['pharmacy-sign-in', '/login?vertical=pharmacy'],
  ['restaurant-sign-in', '/login?vertical=restaurant'],
  ['hotel-sign-in', '/login?vertical=hotel'],
  ['agency-sign-in', '/login?vertical=agency'],
  ['studio-sign-in', '/login?vertical=studio'],
  ['forgot-password', '/forgot-password'],
  ['reset-unavailable', '/reset-password/invalid-qa-token'],
  ['invite-unavailable', '/invite/invalid-qa-token'],
  ['workspace-type', '/login/register'],
  ['pharmacy-register', '/login/register?vertical=pharmacy'],
  ['restaurant-register', '/login/register?vertical=restaurant'],
  ['hotel-register', '/login/register?vertical=hotel'],
  ['till-unlock', '/login/till'],
] as const;
for (const theme of ['light', 'dark'] as const)
  for (const width of [375, 768, 1024, 1440]) {
    test(`Studio QA ${theme} ${width}`, async ({ page }) => {
      await mkdir('/tmp/login-shots', { recursive: true });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (e) => {
        if (e.type() !== 'error') return;
        // An unusable invitation deliberately answers NOT_FOUND. Assert that
        // response below; only its exact browser resource message is expected.
        if (
          /\/api\/trpc\/invitations\.get(?:\?|$)/.test(e.location().url) &&
          e.text() ===
            'Failed to load resource: the server responded with a status of 404 (Not Found)'
        )
          return;
        errors.push(e.text());
      });
      await page.setViewportSize({ width, height: 960 });
      await page.addInitScript((theme) => localStorage.setItem('theme', theme), theme);
      for (const [name, route] of screens) {
        await page.emulateMedia({
          reducedMotion: width === 375 || width === 1024 ? 'reduce' : 'no-preference',
        });
        const unavailableInvitation =
          name === 'invite-unavailable'
            ? page.waitForResponse((r) => r.url().includes('/api/trpc/invitations.get'), {
                timeout: 60_000,
              })
            : null;
        // Each unusable token is a distinct fixture: the real per-token flood
        // limit must remain active across the eight matrix cases.
        await page.goto(
          name === 'invite-unavailable' ? `${route}-${theme}-${width}-${Date.now()}` : route
        );
        if (unavailableInvitation) {
          expect((await unavailableInvitation).status()).toBe(404);
          // React Query retries an unavailable invitation before exposing its error state.
          await expect(page.getByRole('heading', { name: 'Invitation unavailable' })).toBeVisible({
            timeout: 60_000,
          });
        }
        if (name === 'reset-unavailable') {
          await expect(page.getByRole('heading', { name: 'Link unavailable' })).toBeVisible();
        }
        await page.waitForFunction(() => {
          const main = document.querySelector('main');
          return main && Object.keys(main).some((key) => key.startsWith('__reactProps$'));
        });
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${route} overflow`
        ).toBe(true);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.keyboard.press('Tab');
        await expect(page.locator(':focus')).toBeVisible();
        expect(
          await page.locator(':focus').evaluate((el) => getComputedStyle(el).outlineStyle)
        ).not.toBe('none');
        await page.keyboard.press('Escape');
        await page.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        });
        if (name === 'hotel-sign-in')
          await expect(page.locator('body')).not.toContainText(/reservations|folios|night audit/i);
        if (width === 375 || width === 1440) {
          const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
          expect(a11y.violations, `${name} accessibility`).toEqual([]);
        }
        await page.screenshot({
          caret: 'initial',
          style: 'nextjs-portal { visibility: hidden !important; }',
          path: `/tmp/login-shots/${name}-${width}-${theme}.png`,
          fullPage: true,
        });
      }
      expect(errors).toEqual([]);
    });
  }

test('request workspace persists in the actual review queue and retains data on errors', async ({
  page,
}) => {
  await page.goto('/login/register?vertical=restaurant');
  await page.getByLabel('Restaurant name', { exact: true }).fill('Playwright review kitchen');
  await page.getByLabel('Branch name', { exact: true }).fill('Gulberg');
  await page.getByLabel('Business day closes at').fill('00:00');
  await page.getByLabel('Address', { exact: true }).fill('Test street');
  await page.getByLabel('Your name', { exact: true }).fill('Review owner');
  await page.getByLabel('Mobile').fill('03001234567');
  await page.getByLabel('Work email').fill('login-qa@example.test');
  await page.getByRole('checkbox', { name: /I own or manage/ }).check();
  await page.route('**/api/workspace-requests', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'We could not save your request. Please try again.' }),
    });
  });
  await page.getByRole('button', { name: 'Request workspace' }).click();
  await expect(page.getByRole('button', { name: 'Saving your request…' })).toBeDisabled();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('could not save');
  await expect(page.getByLabel('Restaurant name', { exact: true })).toHaveValue(
    'Playwright review kitchen'
  );
  await captureState(page, 'restaurant-request-error');
  await page.unroute('**/api/workspace-requests');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/workspace-requests') && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Request workspace' }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const body = await response.json();
  expect(body.status).toBe('pending');
  await expect(page.getByRole('heading', { name: 'Your request is saved' })).toBeVisible();
  const { Client } = await import('pg');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const result = await db.query('SELECT status, source, notes FROM platform_leads WHERE id=$1', [
      body.id,
    ]);
    expect(result.rows[0].status).toBe('NEW');
    expect(JSON.parse(result.rows[0].notes).details.companyName).toBe('Playwright review kitchen');
  } finally {
    await db.end();
  }
  await captureState(page, 'restaurant-request-pending');
});

test('sign-in keeps credential errors, keyboard password reveal and real terminal destination', async ({
  page,
}) => {
  await page.goto('/login?vertical=restaurant');
  await expect(page.locator('form')).toHaveAttribute('data-hydrated', 'true');
  await page.getByLabel('Email', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('input[name=password]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Show password' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeFocused();
  await page.getByLabel('Email', { exact: true }).fill('unknown@example.test');
  await page.locator('input[name=password]').fill('incorrect-password');
  await page.getByRole('button', { name: 'Show password' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('input[name=password]')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Invalid email or password'
  );
  await captureState(page, 'sign-in-error');
  await page.getByRole('link', { name: /Unlock a till with your PIN/ }).click();
  await expect(page.getByRole('link', { name: /Continue to terminal PIN unlock/ })).toHaveAttribute(
    'href',
    '/pos'
  );
  await expect(page.locator('input[type=password]')).toHaveCount(0);
});

test('logical layout reflows in RTL and zoom-equivalent narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  for (const [name, route] of screens) {
    await page.goto(route);
    if (name === 'invite-unavailable')
      await expect(page.getByRole('heading', { name: 'Invitation unavailable' })).toBeVisible({
        timeout: 60_000,
      });
    await page.locator('html').evaluate((el) => el.setAttribute('dir', 'rtl'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  }
});

for (const vertical of ['pharmacy', 'hotel'] as const) {
  test(`${vertical} request saves complete setup evidence`, async ({ page }) => {
    await page.goto(`/login/register?vertical=${vertical}`);
    await page
      .getByLabel(vertical === 'pharmacy' ? 'Legal business name' : 'Property name', {
        exact: true,
      })
      .fill(`Playwright ${vertical}`);
    await page
      .getByLabel(vertical === 'pharmacy' ? 'Premises address' : 'Address', { exact: true })
      .fill('Test street');
    await page.getByLabel('City', { exact: true }).fill('Lahore');
    if (vertical === 'pharmacy') {
      await page.getByLabel('Branch name', { exact: true }).fill('Model Town');
      await page.getByLabel('Licence number', { exact: true }).fill('QA-LIC-001');
      await page.getByLabel('Valid until').fill('2099-01-01');
      await page.getByLabel('Full name', { exact: true }).fill('Qualified pharmacist');
      await page.getByLabel('Registration number', { exact: true }).fill('QA-REG-001');
      await page.getByLabel('Licence copy', { exact: true }).setInputFiles({
        name: 'licence.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.7\nQA licence evidence'),
      });
    } else {
      await page.getByLabel('Rooms', { exact: true }).fill('24');
      await page.getByLabel('Check-in from').fill('14:00');
      await page.getByLabel('Check-out by').fill('12:00');
    }
    await page.getByLabel('Your name', { exact: true }).fill('Review owner');
    await page.getByLabel('Mobile').fill('03001234567');
    await page.getByLabel('Work email').fill(`${vertical}-qa@example.test`);
    await page.getByRole('checkbox', { name: /I own or manage|I’m authorised/ }).check();
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/api/workspace-requests') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Request workspace' }).click();
    const response = await saved;
    expect(response.status()).toBe(201);
    const body = await response.json();
    await expect(page.getByRole('heading', { name: 'Your request is saved' })).toBeVisible();
    const { Client } = await import('pg');
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const result = await db.query('SELECT status, notes FROM platform_leads WHERE id=$1', [
        body.id,
      ]);
      const intake = JSON.parse(result.rows[0].notes);
      expect(result.rows[0].status).toBe('NEW');
      expect(intake.details.vertical).toBe(vertical);
      if (vertical === 'pharmacy')
        expect(Buffer.from(intake.document.base64, 'base64').toString()).toContain(
          'QA licence evidence'
        );
    } finally {
      await db.end();
    }
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.screenshot({
        caret: 'initial',
        style: 'nextjs-portal { visibility: hidden !important; }',
        path: `/tmp/login-shots/${vertical}-request-pending-${width}.png`,
        fullPage: true,
      });
    }
  });
}

test('CRM reviewers can retrieve saved setup details and private licence evidence', async ({
  page,
  baseURL,
}) => {
  const { Client } = await import('pg');
  const { randomBytes, createHash } = await import('node:crypto');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const id = `login-qa-${randomBytes(8).toString('hex')}`;
  const token = randomBytes(32).toString('hex');
  const admin = new URL(baseURL!);
  admin.hostname = 'admin.localhost';
  try {
    await db.query(
      'INSERT INTO platform_users (id, name, email, "passwordHash", role, "updatedAt") VALUES ($1,$2,$3,$4,\'SALES\',NOW())',
      [id, 'Login QA reviewer', `${id}@example.test`, 'unused-test-session']
    );
    await db.query(
      'INSERT INTO platform_sessions (id, "platformUserId", "tokenHash", "expiresAt") VALUES ($1,$2,$3,NOW()+INTERVAL \'1 hour\')',
      [`${id}-session`, id, createHash('sha256').update(token).digest('hex')]
    );
    await page.context().addCookies([
      {
        name: 'df_platform_session',
        value: token,
        url: admin.origin,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
    await page.goto(`${admin.origin}/platform/crm`);
    await expect(page.getByRole('heading', { name: 'Leads', exact: true })).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Download request details' }).first()
    ).toBeVisible();
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.screenshot({
        caret: 'initial',
        style: 'nextjs-portal { visibility: hidden !important; }',
        path: `/tmp/login-shots/crm-review-${width}.png`,
        fullPage: true,
      });
    }
    const docHref = await page
      .getByRole('link', { name: 'Download licence copy' })
      .first()
      .getAttribute('href');
    const document = await page.evaluate(async (path) => {
      const r = await fetch(path!);
      return {
        status: r.status,
        attachment: r.headers.get('content-disposition'),
        text: await r.text(),
      };
    }, docHref);
    expect(document.status).toBe(200);
    expect(document.attachment).toContain('attachment');
    expect(document.text).toContain('QA licence evidence');
    await page.context().clearCookies();
    const denied = await page.evaluate(async (path) => (await fetch(path!)).status, docHref);
    expect(denied).toBe(403);
  } finally {
    await db.query('DELETE FROM platform_users WHERE id=$1', [id]);
    await db.end();
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`long populated passwords reserve reveal space at 375px in ${theme}`, async ({ page }) => {
    await mkdir('/tmp/login-shots', { recursive: true });
    await page.setViewportSize({ width: 375, height: 960 });
    await page.addInitScript((theme) => localStorage.setItem('theme', theme), theme);
    // Valid recovery fixtures expose the actual forms without creating or consuming tokens.
    await page.route('**/api/trpc/passwordReset.validate*', (route) =>
      route.fulfill({
        json: [{ result: { data: { json: { valid: true } } } }],
      })
    );
    await page.route('**/api/trpc/invitations.get*', (route) =>
      route.fulfill({
        json: [
          {
            result: {
              data: {
                json: {
                  name: 'QA Owner',
                  email: 'owner@example.test',
                  role: 'OWNER',
                  organizationName: 'QA',
                  title: 'Owner',
                  department: 'OPERATIONS',
                },
              },
            },
          },
        ],
      })
    );
    const routes = [
      ...screens.filter(([name]) => name.endsWith('sign-in')),
      ['reset-password', '/reset-password/qa-valid-token'],
      ['accept-invite', '/invite/qa-valid-token'],
    ];
    const password = 'Long-Password92!'.repeat(12);
    for (const [name, route] of routes) {
      await page.goto(route);
      if (name.endsWith('sign-in')) {
        const vertical = new URL(route, 'http://localhost').searchParams.get('vertical');
        await expect(page.getByRole('main')).toContainText(
          !vertical
            ? 'Secure workspace access'
            : `${vertical === 'studio' ? 'agency' : vertical} workspace`
        );
      }
      const input = page.locator('input[data-password-reveal]');
      await expect(input).toBeVisible();
      await input.fill(password);
      for (const revealed of [false, true]) {
        await expect(input).toHaveAttribute('type', revealed ? 'text' : 'password');
        await expect(input).toHaveValue(password);
        await input.focus();
        await page.keyboard.press('End');
        const geometry = await input.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const button = el.parentElement!.querySelector('button')!.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            contentEnd:
              rect.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
            buttonStart: button.left,
          };
        });
        expect(
          geometry.contentEnd,
          `${name} ${revealed ? 'revealed' : 'masked'}`
        ).toBeLessThanOrEqual(geometry.buttonStart);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        await page.screenshot({
          path: `/tmp/login-shots/${name}-long-password-${revealed ? 'revealed' : 'masked'}-375-${theme}.png`,
          fullPage: true,
          style: 'nextjs-portal { visibility: hidden !important; }',
        });
        await page
          .getByRole('button', { name: revealed ? 'Hide password' : 'Show password' })
          .click();
      }
      await expect(input).toHaveAttribute('type', 'password');
    }
  });
}
