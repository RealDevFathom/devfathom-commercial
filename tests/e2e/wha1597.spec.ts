import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';

function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', bytes).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}

test('enroll first, then expose required reason forms across viewport and theme states', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/platform/login');
  await page.getByLabel('Work email').fill('admin1597@example.com');
  await page.getByLabel('Password', { exact: true }).fill('local-fixture-only-1597');
  await page.locator('button[type=submit]').click();
  await expect(page.getByRole('region', { name: 'Authenticator enrollment' })).toBeVisible();
  // Restricted cookie cannot open an authenticated API.
  const denied = await page.request.get('/api/platform/session');
  expect((await denied.json()).authenticated).toBe(false);
  for (const width of [375, 768, 1024, 1440]) {
    for (const theme of ['light', 'dark']) {
      for (const reducedMotion of ['reduce', 'no-preference'] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion });
        await page.evaluate(
          (value) => document.documentElement.setAttribute('data-theme', value),
          theme
        );
        await expect(page.getByRole('button', { name: 'Set up authenticator' })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        if (reducedMotion === 'reduce')
          await page.screenshot({ path: info.outputPath(`enrollment-${width}-${theme}.png`) });
      }
    }
  }
  await page.getByRole('button', { name: 'Set up authenticator' }).focus();
  await expect(page.getByRole('button', { name: 'Set up authenticator' })).toBeFocused();
  await page.keyboard.press('Enter');
  const secret = await page
    .locator('section[aria-label="Authenticator enrollment"] code')
    .innerText();
  await page.getByLabel('Authentication code', { exact: true }).fill(totp(secret));
  await page.getByRole('button', { name: 'Verify authenticator' }).click();
  await expect(page.getByText('Save your recovery codes')).toBeVisible();
  await page.getByRole('button', { name: 'I saved my codes — continue' }).click();
  await page.waitForURL('**/platform');
  await page.goto('/platform/organizations/org_devfathom');
  await page.locator('#people details summary').first().click();
  for (const label of ['Reset password', 'Add identity connection', 'Create token']) {
    const form = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: label, exact: true }) })
      .first();
    await expect(form.getByRole('textbox', { name: 'Reason (required)' })).toHaveAttribute(
      'minlength',
      '10'
    );
  }
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Create token', exact: true }) });
  await form.getByLabel('Token name').fill('Browser fixture');
  await form.getByRole('textbox', { name: 'Reason (required)' }).fill('short');
  await form.getByRole('button').click();
  expect(
    await form
      .getByRole('textbox', { name: 'Reason (required)' })
      .evaluate((el: HTMLTextAreaElement) => el.validity.tooShort)
  ).toBe(true);
  for (const width of [375, 768, 1024, 1440]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme
      );
      await form.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await form.screenshot({ path: info.outputPath(`reason-${width}-${theme}.png`) });
    }
  }
  expect(errors).toEqual([]);
});
