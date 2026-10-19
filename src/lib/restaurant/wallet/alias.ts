import { createHash, randomBytes } from 'node:crypto';

const CROCKFORD_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export const WALLET_ALIAS_PATTERN = /^wla_[0-9a-hjkmnp-tv-z]{26}$/;

/** Mint a non-reversible wallet identifier from exactly 128 CSPRNG bits. */
export function mintWalletAlias(): string {
  const entropy = randomBytes(16);
  const bits = Array.from(entropy, (byte) => byte.toString(2).padStart(8, '0')).join('');
  let encoded = '';

  // 26 base32 symbols hold 130 bits; the leading symbol therefore uses only
  // two bits. Padding preserves leading zeroes without reducing entropy.
  const paddedBits = bits.padStart(130, '0');
  for (let index = 0; index < paddedBits.length; index += 5) {
    encoded += CROCKFORD_ALPHABET[Number.parseInt(paddedBits.slice(index, index + 5), 2)];
  }

  return `wla_${encoded}`;
}

/** Safe diagnostic handle. Never log or embed the raw alias in an error. */
export function walletAliasFingerprint(alias: string): string {
  return createHash('sha256').update(alias).digest('hex').slice(0, 8);
}

export function isWalletAlias(value: string): boolean {
  return WALLET_ALIAS_PATTERN.test(value);
}
