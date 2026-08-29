import { describe, expect, it } from 'vitest';

import {
  isWalletAlias,
  mintWalletAlias,
  WALLET_ALIAS_PATTERN,
  walletAliasFingerprint,
} from './alias';

describe('wallet alias', () => {
  it('mints lowercase Crockford aliases with 128-bit output shape', () => {
    const aliases = Array.from({ length: 1_000 }, mintWalletAlias);

    expect(aliases.every((alias) => WALLET_ALIAS_PATTERN.test(alias))).toBe(true);
    expect(new Set(aliases)).toHaveLength(aliases.length);
    expect(aliases.every((alias) => '01234567'.includes(alias[4]))).toBe(true);
  });

  it('rejects malformed and ambiguous aliases', () => {
    expect(isWalletAlias('wla_3g7v9k2m5q8r1t4w6y0zb3d5f7')).toBe(true);
    expect(isWalletAlias('wla_illlooouuu2m5q8r1t4w6y0zb3')).toBe(false);
    expect(isWalletAlias('wla_3G7V9K2M5Q8R1T4W6Y0ZB3D5F7')).toBe(false);
    expect(isWalletAlias('wla_short')).toBe(false);
  });

  it('fingerprints without returning the raw alias', () => {
    const alias = 'wla_3g7v9k2m5q8r1t4w6y0zb3d5f7';
    const fingerprint = walletAliasFingerprint(alias);

    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint).not.toContain(alias);
    expect(walletAliasFingerprint(alias)).toBe(fingerprint);
  });
});
