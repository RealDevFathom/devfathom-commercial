import { describe, expect, it, vi } from 'vitest';

import {
  APPLE_WALLET_SETTING_DECLARATIONS,
  APPLE_WALLET_SETTING_KEYS,
  loadAppleWalletCredentials,
  type AppleSetting,
} from './apple-config';

describe('Apple issuer secret binding', () => {
  it('declares all private material sensitive and public identifiers non-sensitive', () => {
    const flags = Object.fromEntries(
      APPLE_WALLET_SETTING_DECLARATIONS.map((row) => [row.key, row.sensitive])
    );
    expect(flags[APPLE_WALLET_SETTING_KEYS.passCertificate]).toBe(true);
    expect(flags[APPLE_WALLET_SETTING_KEYS.passPrivateKey]).toBe(true);
    expect(flags[APPLE_WALLET_SETTING_KEYS.apnsPrivateKey]).toBe(true);
    expect(flags[APPLE_WALLET_SETTING_KEYS.wwdrCertificate]).toBe(false);
    expect(flags[APPLE_WALLET_SETTING_KEYS.passTypeIdentifier]).toBe(false);
  });

  it('decrypts issuer material without exposing it through errors', async () => {
    const secret = 'PRIVATE-KEY-SENSITIVE';
    const rows = new Map<string, AppleSetting>([
      [
        APPLE_WALLET_SETTING_KEYS.passCertificate,
        {
          key: APPLE_WALLET_SETTING_KEYS.passCertificate,
          sensitive: true,
          value: { encrypted: 'v1.cert' },
        },
      ],
      [
        APPLE_WALLET_SETTING_KEYS.passPrivateKey,
        {
          key: APPLE_WALLET_SETTING_KEYS.passPrivateKey,
          sensitive: true,
          value: { encrypted: 'v1.key' },
        },
      ],
      [
        APPLE_WALLET_SETTING_KEYS.wwdrCertificate,
        { key: APPLE_WALLET_SETTING_KEYS.wwdrCertificate, sensitive: false, value: 'WWDR' },
      ],
      [
        APPLE_WALLET_SETTING_KEYS.passTypeIdentifier,
        {
          key: APPLE_WALLET_SETTING_KEYS.passTypeIdentifier,
          sensitive: false,
          value: 'pass.com.devfathom.loyalty',
        },
      ],
      [
        APPLE_WALLET_SETTING_KEYS.teamIdentifier,
        { key: APPLE_WALLET_SETTING_KEYS.teamIdentifier, sensitive: false, value: 'DEVFATH0M1' },
      ],
    ]);
    const decrypt = vi.fn((value: string) => JSON.stringify(value === 'v1.key' ? secret : 'CERT'));
    const loaded = await loadAppleWalletCredentials({
      readSetting: async (key) => rows.get(key) ?? null,
      decrypt,
      isEncryptionConfigured: () => true,
    });
    expect(loaded.passPrivateKeyPem).toBe(secret);
    expect(decrypt).toHaveBeenCalledTimes(2);

    await expect(
      loadAppleWalletCredentials({
        readSetting: async () => rows.get(APPLE_WALLET_SETTING_KEYS.passPrivateKey)!,
        decrypt: () => {
          throw new Error(secret);
        },
        isEncryptionConfigured: () => true,
      })
    ).rejects.not.toThrow(secret);
  });
});
