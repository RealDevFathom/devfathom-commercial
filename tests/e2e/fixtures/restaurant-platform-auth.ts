import { createHash, createHmac } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRestaurantE2eDatabaseUrl } from '../../../scripts/restaurant-e2e-database';
import { expect, type Page } from '@playwright/test';

// Retain only keys returned by the real enrollment UI. A private temporary cache
// survives Playwright worker restarts, scoped to the disposable database and actor.
// No database authentication state is rewritten, and no key enters test artifacts.
const authenticators = new Map<string, string>();
const identityKey = (origin: string, email: string) => `${origin}:${email.toLowerCase()}`;

function authenticatorFile(origin: string, email: string) {
  if (!process.env.RESTAURANT_E2E_DATABASE_URL) return null;
  const database = resolveRestaurantE2eDatabaseUrl();
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(database).hostname)) {
    throw new Error('Authenticator cache requires a loopback disposable database.');
  }
  const digest = createHash('sha256')
    .update(`${database}:${identityKey(origin, email)}`)
    .digest('hex');
  const directory = join(tmpdir(), `restaurant-e2e-auth-${digest}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) {
    throw new Error('Authenticator cache directory must be private.');
  }
  return join(directory, 'authenticator');
}

function readAuthenticator(origin: string, email: string) {
  const cached = authenticators.get(identityKey(origin, email));
  if (cached) return cached;
  const file = authenticatorFile(origin, email);
  if (!file || !existsSync(file)) return undefined;
  const info = lstatSync(file);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
    throw new Error('Authenticator cache file must be private.');
  }
  return readFileSync(file, 'utf8');
}

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
  const secret = readAuthenticator(origin, email);
  if (!secret) throw new Error('Sign in through the fixture enrollment UI before requesting OTP.');
  return fixtureTotp(secret);
}

/** Password + real enrollment/TOTP, never a session injection or MFA bypass. */
export async function signInPlatformActor(page: Page, email: string) {
  const origin = new URL(page.url()).origin;
  const key = identityKey(origin, email);
  const secret = readAuthenticator(origin, email);
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
  const file = authenticatorFile(origin, email);
  if (file) writeFileSync(file, enrolledSecret, { mode: 0o600, flag: 'wx' });
  authenticators.set(key, enrolledSecret);
  await enrollment.getByRole('button', { name: 'I saved my codes — continue' }).click();
}
