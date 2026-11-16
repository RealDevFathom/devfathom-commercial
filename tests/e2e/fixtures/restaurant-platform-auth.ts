import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

// Only keys returned by the real enrollment UI are retained, in this worker's memory.
// A fresh disposable database is expected for each spec; no database auth state is rewritten.
const authenticators = new Map<string, string>();
const identityKey = (origin: string, email: string) => `${origin}:${email.toLowerCase()}`;

export function fixtureTotp(secret: string, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of secret.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid fixture authenticator setup key.');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  if (!bytes.length) throw new Error('Missing fixture authenticator setup key.');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac('sha1', bytes).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function platformActorCode(origin: string, email: string) {
  const secret = authenticators.get(identityKey(origin, email));
  if (!secret) throw new Error('Sign in through the fixture enrollment UI before requesting OTP.');
  return fixtureTotp(secret);
}

/** Password + real enrollment/TOTP, never a session injection or MFA bypass. */
export async function signInPlatformActor(page: Page, email: string) {
  const origin = new URL(page.url()).origin;
  const key = identityKey(origin, email);
  const secret = authenticators.get(key);
  if (secret)
    await page.getByLabel('Authentication code', { exact: true }).fill(fixtureTotp(secret));
  const session = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/platform/session' &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Continue to control desk' }).click();
  const response = await session;
  // Do not include authentication response bodies in failure output.
  expect(response.status(), 'Platform sign-in must accept the fixture credentials and OTP').toBe(
    200
  );
  const result = (await response.json()) as { enrollmentRequired?: boolean };
  if (!result.enrollmentRequired) return;

  const enrollment = page.getByRole('region', { name: 'Authenticator enrollment' });
  await enrollment.getByRole('button', { name: 'Set up authenticator' }).click();
  const setupKey = enrollment.locator('code');
  await expect(setupKey).toBeVisible();
  const enrolledSecret = (await setupKey.textContent())?.trim();
  if (!enrolledSecret) throw new Error('Authenticator enrollment did not provide a setup key.');
  await enrollment
    .getByLabel('Authentication code', { exact: true })
    .fill(fixtureTotp(enrolledSecret));
  const confirmed = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === '/api/platform/mfa' &&
      candidate.request().method() === 'POST'
  );
  await enrollment.getByRole('button', { name: 'Verify authenticator' }).click();
  expect((await confirmed).status(), 'Authenticator enrollment must succeed').toBe(200);
  await expect(enrollment.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  authenticators.set(key, enrolledSecret);
  await enrollment.getByRole('button', { name: 'I saved my codes — continue' }).click();
}
