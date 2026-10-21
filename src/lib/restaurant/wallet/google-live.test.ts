/**
 * Wallet lane L3 (WHA-269) — the LIVE Google issuer check.
 *
 * This file exists because "we could not test it" and "it works" must not look
 * the same in a CI summary. There is no `.skip` here and there never will be:
 * the suite ALWAYS runs and always prints where the prerequisite stands.
 *
 * Two modes, both of which assert something real:
 *
 *  - PREREQUISITE-NOT-MET (the default, and the state at implementation time):
 *    the readiness probe must report NOT ready, name the exact settings that are
 *    missing, and name WHA-268 as the owner. That is a genuine assertion — it
 *    fails if the adapter ever starts claiming readiness it does not have.
 *  - LIVE (opt-in): with `WALLET_GOOGLE_LIVE=1` and an issuer credential in the
 *    environment, the test mints a real OAuth2 access token against Google. That
 *    is read-only by construction — it creates no class and no object, so a live
 *    run leaves nothing behind in the issuer account.
 *
 * The env variables below are a TEST affordance only. The runtime path reads
 * issuer material exclusively from sensitive `PlatformSetting` rows (§14); this
 * lane introduces no production environment variable.
 */
import { describe, expect, it } from 'vitest';

import { createGoogleWalletClient } from './google';
import {
  GOOGLE_WALLET_PROVISIONING_PREREQUISITE,
  GOOGLE_WALLET_SETTING_KEYS,
  describeGoogleWalletReadiness,
  parseServiceAccount,
  type GoogleWalletSecretBinding,
  type PlatformSettingRecord,
} from './google-config';

const LIVE_ENABLED = process.env.WALLET_GOOGLE_LIVE === '1';
const LIVE_ISSUER_ID = process.env.WALLET_GOOGLE_LIVE_ISSUER_ID ?? null;
const LIVE_SERVICE_ACCOUNT = process.env.WALLET_GOOGLE_LIVE_SERVICE_ACCOUNT ?? null;

/**
 * A binding over the live opt-in environment. Values are supplied as plaintext
 * here (never encrypted), which is exactly why this path is test-only.
 */
function liveBinding(): GoogleWalletSecretBinding {
  const rows: Record<string, PlatformSettingRecord | null> = {
    [GOOGLE_WALLET_SETTING_KEYS.issuerId]: LIVE_ISSUER_ID
      ? { key: GOOGLE_WALLET_SETTING_KEYS.issuerId, value: LIVE_ISSUER_ID, sensitive: false }
      : null,
    [GOOGLE_WALLET_SETTING_KEYS.serviceAccount]: LIVE_SERVICE_ACCOUNT
      ? {
          key: GOOGLE_WALLET_SETTING_KEYS.serviceAccount,
          value: LIVE_SERVICE_ACCOUNT,
          sensitive: false,
        }
      : null,
  };
  return { readSetting: async (key) => rows[key] ?? null };
}

describe('Google Wallet live issuance prerequisite', () => {
  it('reports the prerequisite status explicitly instead of skipping', async () => {
    const readiness = await describeGoogleWalletReadiness(liveBinding());

    // Raw, unconditional output: the reason this file is not a `.skip`.
    console.info(
      [
        '',
        '── Google Wallet live issuance — prerequisite report ──',
        `  live mode requested : ${LIVE_ENABLED ? 'yes (WALLET_GOOGLE_LIVE=1)' : 'no'}`,
        `  issuer ready        : ${readiness.ready ? 'yes' : 'no'}`,
        `  missing settings    : ${readiness.missing.length > 0 ? readiness.missing.join(', ') : '(none)'}`,
        `  prerequisite issue  : ${GOOGLE_WALLET_PROVISIONING_PREREQUISITE.issue} — ${GOOGLE_WALLET_PROVISIONING_PREREQUISITE.title}`,
        `  its status observed : ${GOOGLE_WALLET_PROVISIONING_PREREQUISITE.statusAtImplementation} (at implementation time, 2026-08-28)`,
        `  it delivers         : ${GOOGLE_WALLET_PROVISIONING_PREREQUISITE.delivers.join(', ')}`,
        `  verdict             : ${readiness.summary}`,
        '───────────────────────────────────────────────────────',
        '',
      ].join('\n')
    );

    // The report must always name the owning issue, ready or not — a green line
    // with no attribution is how a blocked dependency gets forgotten.
    expect(GOOGLE_WALLET_PROVISIONING_PREREQUISITE.issue).toBe('WHA-268');
    expect(GOOGLE_WALLET_PROVISIONING_PREREQUISITE.delivers).toEqual([
      GOOGLE_WALLET_SETTING_KEYS.issuerId,
      GOOGLE_WALLET_SETTING_KEYS.serviceAccount,
    ]);
    expect(readiness.prerequisite).toBe(GOOGLE_WALLET_PROVISIONING_PREREQUISITE);
    expect(readiness.summary).toContain('WHA-268');

    if (!LIVE_ENABLED) {
      // The asserted state of the world right now: no issuer, and the adapter
      // says so rather than pretending. This fails loudly the day someone makes
      // readiness optimistic.
      expect(readiness.ready).toBe(false);
      expect(readiness.missing).toEqual([
        GOOGLE_WALLET_SETTING_KEYS.issuerId,
        GOOGLE_WALLET_SETTING_KEYS.serviceAccount,
      ]);
      return;
    }

    // Live mode was asked for, so the credential must actually be there.
    expect(readiness.missing).toEqual([]);
    expect(readiness.ready).toBe(true);
  });

  it('mints a real access token when, and only when, the issuer is provisioned', async () => {
    if (!LIVE_ENABLED) {
      // Not a skip: this asserts that the live path is correctly unreachable.
      // A misconfigured opt-in would leave one of these two env vars set.
      expect(LIVE_ISSUER_ID === null || LIVE_SERVICE_ACCOUNT === null).toBe(true);
      console.info(
        `  live token exchange : NOT RUN — blocked on ${GOOGLE_WALLET_PROVISIONING_PREREQUISITE.issue} ` +
          `(${GOOGLE_WALLET_PROVISIONING_PREREQUISITE.statusAtImplementation}). Mocked contract tests in ` +
          'google.test.ts cover the same code path.'
      );
      return;
    }

    const serviceAccount = parseServiceAccount(LIVE_SERVICE_ACCOUNT!);
    const client = createGoogleWalletClient({
      credentials: { issuerId: LIVE_ISSUER_ID!, ...serviceAccount },
    });

    // Read-only: a token mint proves the credential without touching the issuer's
    // classes or objects.
    const token = await client.getAccessToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    console.info('  live token exchange : OK — issuer credential accepted by Google.');
  }, 30_000);
});
