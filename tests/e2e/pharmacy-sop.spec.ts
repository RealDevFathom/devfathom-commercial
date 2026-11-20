import { expect, test, type Browser, type Page, type Request } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

import { PHARMACY_E2E } from './pharmacy-counter-fixture';

/**
 * DEV-751 — pharmacy procedures (SOP) in a real browser, on desktop and on a phone.
 *
 * The component tests prove the upload and history logic against a fake
 * XMLHttpRequest and jsdom's history. This lane proves the same promises
 * against the real server, storage and browser:
 *
 * - an upload cut off before it reached the server is retried with the same
 *   photo and saved once, without choosing the file again;
 * - an upload the server saved but whose answer was lost is never sent twice:
 *   the retry re-reads the procedure, finds the photo and stops;
 * - leaving a procedure (the in-app link or the browser Back button) returns
 *   to the list, and the browser Back button never reopens it.
 *
 * It also walks the DEVFATHOM-STUDIO §12 visual QA matrix for the workspace
 * and the open procedure: four widths, both themes, reduced motion, no
 * document overflow, one h1 and no console errors.
 *
 * Procedures are set up through the same API the setup screen calls, signed in
 * as the seeded procedures manager — never by writing rows directly.
 */

const SOP = PHARMACY_E2E.sop;
const BRANCH = PHARMACY_E2E.branchId;
const TIMEZONE = 'Asia/Karachi';
const CLOSING = 'Pharmacy — closing';
const PHOTO_STEP = 'Once closed, send a photo of the locked premises';
const EVIDENCE_PATH = '/api/pharmacy/sop/evidence';
const OUTPUT = path.join('playwright-artifacts', 'pharmacy-sop-visual-qa');

/** CRC-32 as PNG chunks need it. */
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A small valid PNG of one flat colour. Each seed gives different bytes: the
 * server treats identical bytes on one step as the same proof, and this spec
 * needs two distinct photos.
 */
function photo(seed: number) {
  const size = 16;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(size * 3, Buffer.from([(seed * 70) % 256, 90, 140])),
  ]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  const buffer = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return { name: `locked-premises-${seed}.png`, mimeType: 'image/png', buffer };
}

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  // Prove the client form is hydrated before entering credentials: a native
  // pre-hydration submit otherwise posts back to /login and loses the draft.
  await expect(async () => {
    const passwordControl = page.getByRole('textbox', { name: 'Password' });
    if ((await passwordControl.getAttribute('type')) === 'password')
      await page.getByRole('button', { name: 'Show password' }).click();
    await expect(passwordControl).toHaveAttribute('type', 'text');
  }).toPass({ timeout: 15_000 });
  await page.getByLabel('Email').fill(email);
  await page
    .getByRole('textbox', { name: 'Password' })
    .fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const chooser = page.getByText('Choose a workspace', { exact: true });
  if (await chooser.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await page.getByRole('button', { name: /Fathom Pharmacy E2E/i }).click();
  }
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

type TrpcEnvelope<T> = { result: { data: { json: T } } };

async function trpcMutation<T>(page: Page, procedure: string, json: unknown): Promise<T> {
  const response = await page.request.post(`/api/trpc/pharmacySop.${procedure}`, {
    data: { json },
  });
  expect(response.ok(), `${procedure}: ${await response.text()}`).toBe(true);
  return ((await response.json()) as TrpcEnvelope<T>).result.data.json;
}

async function trpcQuery<T>(page: Page, procedure: string, json?: unknown): Promise<T> {
  const input = json === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify({ json }))}`;
  const response = await page.request.get(`/api/trpc/pharmacySop.${procedure}${input}`);
  expect(response.ok(), `${procedure}: ${await response.text()}`).toBe(true);
  return ((await response.json()) as TrpcEnvelope<T>).result.data.json;
}

/** The branch's local date and minute of the day, a few minutes from now. */
function dueSoon(minutesAhead: number) {
  const at = new Date(Date.now() + minutesAhead * 60_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** The closing procedures on the signed-in person's own list. */
async function myClosingProcedures(page: Page): Promise<string[]> {
  const board = await trpcQuery<{ mine: Array<{ occurrenceId: string; templateName: string }> }>(
    page,
    'board',
    { pharmacyBranchId: BRANCH }
  );
  return board.mine
    .filter((item) => item.templateName === CLOSING)
    .map((item) => item.occurrenceId);
}

/**
 * As the procedures manager (in a separate browser context): turn procedures
 * on at the branch, add the library, give the pharmacist the qualified-person
 * role and create one closing procedure for them. Every call but the schedule
 * is idempotent; the schedule is a one-off, so each run (and each browser
 * project) gets its own fresh procedure. `pharmacist` must already be signed
 * in; returns the new procedure's id as it appears on their list.
 */
async function prepareClosingProcedure(browser: Browser, pharmacist: Page): Promise<string> {
  const before = new Set(await myClosingProcedures(pharmacist).catch(() => []));
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(page, SOP.managerEmail);
    await trpcMutation(page, 'enableSite', { pharmacyBranchId: BRANCH, timezone: TIMEZONE });
    await trpcMutation(page, 'installLibrary', undefined);
    const templates = await trpcQuery<Array<{ id: string; name: string }>>(page, 'templates');
    const closing = templates.find((template) => template.name === CLOSING);
    expect(closing, 'the closing pack is installed').toBeTruthy();
    await trpcMutation(page, 'setRoleHolding', {
      pharmacyBranchId: BRANCH,
      userId: SOP.pharmacistId,
      roleKey: 'pharmacy-qualified-person',
      held: true,
    });
    const due = dueSoon(5);
    await trpcMutation(page, 'createAssignment', {
      pharmacyBranchId: BRANCH,
      templateId: closing!.id,
      target: { type: 'PERSON', userId: SOP.pharmacistId },
      frequency: 'ONCE',
      startDate: due.date,
      endDate: due.date,
      dueTimeMinutes: due.minutes,
    });
    await trpcMutation(page, 'generate', { pharmacyBranchId: BRANCH });
  } finally {
    await context.close();
  }
  const created = (await myClosingProcedures(pharmacist)).filter((id) => !before.has(id));
  expect(created, 'exactly one new closing procedure').toHaveLength(1);
  return created[0]!;
}

function isEvidencePost(request: Request) {
  return request.method() === 'POST' && new URL(request.url()).pathname === EVIDENCE_PATH;
}

async function openWorkspace(page: Page) {
  await page.goto('/pharmacy/sop');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('list', { name: 'My work' })).toBeVisible({ timeout: 30_000 });
}

async function openProcedure(page: Page, occurrenceId: string) {
  const open = page.locator(`#sop-open-${occurrenceId}`);
  await expect(open).toBeVisible();
  await open.click();
  await expect(page).toHaveURL(new RegExp(`occurrence=${occurrenceId}`));
  await expect(page.getByRole('heading', { level: 2, name: CLOSING })).toBeVisible();
}

test.describe('pharmacy procedures on desktop and phone', () => {
  test.describe.configure({ mode: 'serial' });

  test('interrupted photo uploads retry once and never save twice; back returns to the list', async ({
    browser,
    page,
  }) => {
    test.slow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await signIn(page, SOP.pharmacistEmail);
    const occurrenceId = await prepareClosingProcedure(browser, page);
    await openWorkspace(page);
    const landedAt = page.url();
    await openProcedure(page, occurrenceId);
    await page.getByRole('button', { name: 'Start', exact: true }).click();

    const input = page.getByLabel(`Photo for ${PHOTO_STEP}`);
    await expect(input).toBeEnabled();
    const step = page.locator('section[aria-label="Steps"]');
    const posts: Request[] = [];
    page.on('request', (request) => {
      if (isEvidencePost(request)) posts.push(request);
    });

    // 1. The connection drops before the photo reaches the server.
    await page.route(`**${EVIDENCE_PATH}`, (route) => route.abort('connectionreset'), {
      times: 1,
    });
    await input.setInputFiles(photo(1));
    const alert = step.getByRole('alert').filter({ hasText: 'The upload was interrupted' });
    await expect(alert).toBeVisible();
    await expect(page.getByText('Photo · required')).toBeVisible();
    // Retrying sends the same photo; nothing is chosen again.
    await alert.getByRole('button', { name: 'Retry upload' }).click();
    await expect(page.getByText('Photo saved.')).toBeVisible();
    await expect(page.getByText('Photo · added')).toBeVisible();
    expect(posts).toHaveLength(2);
    // The procedure, re-read from the server, holds exactly one photo.
    const history = page.getByRole('region', { name: 'History' });
    const proofs = history.getByRole('link', { name: /^View / });
    await expect(proofs).toHaveCount(1);

    // 2. The server saves the next photo but the answer never arrives.
    posts.length = 0;
    await page.route(
      `**${EVIDENCE_PATH}`,
      async (route) => {
        const delivered = await route.fetch();
        expect(delivered.ok()).toBe(true);
        await route.abort('connectionreset');
      },
      { times: 1 }
    );
    await page.getByLabel(`Photo for ${PHOTO_STEP}`).setInputFiles(photo(2));
    const lost = step.getByRole('alert').filter({ hasText: 'The upload was interrupted' });
    await expect(lost).toBeVisible();
    await lost.getByRole('button', { name: 'Retry upload' }).click();
    await expect(page.getByText('Photo saved.')).toBeVisible();
    // The retry re-read the procedure, found the photo and sent nothing.
    expect(posts).toHaveLength(1);
    await expect(proofs).toHaveCount(2);

    // 3. Browser Back from the open procedure returns to the list…
    await page.goBack();
    await expect(page).not.toHaveURL(/occurrence=/);
    await expect(page.getByRole('list', { name: 'My work' })).toBeVisible();
    // …and the photo is still there when the procedure is opened again.
    await openProcedure(page, occurrenceId);
    await expect(page.getByText('Photo · added')).toBeVisible();
    await expect(proofs).toHaveCount(2);

    // 4. The in-app link goes back the way the person came: browser Back then
    // leaves the workspace instead of reopening the procedure.
    await page.getByRole('button', { name: "Back to today's work" }).click();
    await expect(page.getByRole('list', { name: 'My work' })).toBeVisible();
    await expect(page).not.toHaveURL(/occurrence=/);
    expect(page.url()).toBe(landedAt);
    await page.goBack();
    await expect(page).not.toHaveURL(/occurrence=/);
    await expect(page.getByRole('heading', { level: 2, name: CLOSING })).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('Studio visual QA matrix for the workspace and an open procedure', async ({
    browser,
    page,
  }, testInfo) => {
    // The matrix sets its own widths; run it once, from the desktop project.
    test.skip(testInfo.project.name !== 'pharmacy-sop-desktop', 'Runs once, from desktop');
    test.slow();
    await mkdir(OUTPUT, { recursive: true });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await signIn(page, SOP.pharmacistEmail);
    const occurrenceId = await prepareClosingProcedure(browser, page);
    const viewports = [
      { name: '375', width: 375, height: 812 },
      { name: '768', width: 768, height: 1024 },
      { name: '1024', width: 1024, height: 768 },
      { name: '1440', width: 1440, height: 900 },
    ];
    for (const theme of ['light', 'dark'] as const) {
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion });
        await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);
        for (const viewport of viewports) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          const cell = `${theme}-${reducedMotion}-${viewport.name}`;
          for (const [screen, url] of [
            ['board', '/pharmacy/sop'],
            ['procedure', `/pharmacy/sop?view=board&occurrence=${occurrenceId}`],
          ] as const) {
            await page.goto(url);
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
            await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
            if (screen === 'board') {
              await expect(page.getByRole('list', { name: 'My work' })).toBeVisible();
            } else {
              await expect(page.getByRole('heading', { level: 2, name: CLOSING })).toBeVisible();
              // Keyboard: the in-app back link takes focus and shows it.
              const back = page.getByRole('button', { name: "Back to today's work" });
              await back.focus();
              await expect(back).toBeFocused();
            }
            const overflows = await page.evaluate(
              () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
            );
            expect(overflows, `${screen} ${cell} overflows horizontally`).toBe(false);
            await page.screenshot({
              path: path.join(OUTPUT, `${screen}-${cell}.png`),
              fullPage: true,
            });
          }
        }
      }
    }
    expect(errors).toEqual([]);
  });
});
