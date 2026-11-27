import 'server-only';

import { decryptSecret, encryptionConfigured } from '@/lib/secret-crypto';

export const APPLE_WALLET_SETTING_KEYS = {
  passCertificate: 'wallet.apple.passCert',
  passPrivateKey: 'wallet.apple.passKey',
  wwdrCertificate: 'wallet.apple.wwdrCert',
  passTypeIdentifier: 'wallet.apple.passTypeIdentifier',
  teamIdentifier: 'wallet.apple.teamIdentifier',
  apnsPrivateKey: 'wallet.apple.apnsKey',
  apnsKeyIdentifier: 'wallet.apple.apnsKeyId',
} as const;

export const APPLE_WALLET_SETTING_DECLARATIONS = [
  [APPLE_WALLET_SETTING_KEYS.passCertificate, true],
  [APPLE_WALLET_SETTING_KEYS.passPrivateKey, true],
  [APPLE_WALLET_SETTING_KEYS.wwdrCertificate, false],
  [APPLE_WALLET_SETTING_KEYS.passTypeIdentifier, false],
  [APPLE_WALLET_SETTING_KEYS.teamIdentifier, false],
  [APPLE_WALLET_SETTING_KEYS.apnsPrivateKey, true],
  [APPLE_WALLET_SETTING_KEYS.apnsKeyIdentifier, false],
].map(([key, sensitive]) => ({ key, category: 'wallet', sensitive })) as readonly {
  key: string;
  category: 'wallet';
  sensitive: boolean;
}[];

export type AppleWalletCredentials = {
  passCertificatePem: string;
  passPrivateKeyPem: string;
  wwdrCertificatePem: string;
  passTypeIdentifier: string;
  teamIdentifier: string;
};

export type AppleSetting = { key: string; value: unknown; sensitive: boolean };
export type AppleWalletSecretBinding = {
  readSetting(key: string): Promise<AppleSetting | null>;
  decrypt?: (ciphertext: string) => string;
  isEncryptionConfigured?: () => boolean;
};

export class AppleWalletConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleWalletConfigError';
  }
}

function valueOf(row: AppleSetting | null, binding: AppleWalletSecretBinding): string {
  if (!row) throw new AppleWalletConfigError('Apple Wallet issuer settings are not configured.');
  if (!row.sensitive) {
    if (typeof row.value !== 'string' || !row.value.trim())
      throw new AppleWalletConfigError(`Platform setting "${row.key}" is empty.`);
    return row.value.trim();
  }
  const encrypted =
    row.value && typeof row.value === 'object' && 'encrypted' in row.value
      ? (row.value as { encrypted?: unknown }).encrypted
      : null;
  if (typeof encrypted !== 'string' || !(binding.isEncryptionConfigured ?? encryptionConfigured)())
    throw new AppleWalletConfigError('Apple Wallet issuer secrets cannot be decrypted.');
  try {
    const plain = (binding.decrypt ?? decryptSecret)(encrypted);
    const parsed = JSON.parse(plain) as unknown;
    if (typeof parsed !== 'string' || !parsed.trim()) throw new Error('invalid');
    return parsed.trim();
  } catch {
    throw new AppleWalletConfigError('An Apple Wallet issuer secret is invalid.');
  }
}

export async function loadAppleWalletCredentials(
  binding: AppleWalletSecretBinding
): Promise<AppleWalletCredentials> {
  const keys = APPLE_WALLET_SETTING_KEYS;
  const rows = await Promise.all([
    binding.readSetting(keys.passCertificate),
    binding.readSetting(keys.passPrivateKey),
    binding.readSetting(keys.wwdrCertificate),
    binding.readSetting(keys.passTypeIdentifier),
    binding.readSetting(keys.teamIdentifier),
  ]);
  const values = rows.map((row) => valueOf(row, binding));
  const [
    passCertificatePem,
    passPrivateKeyPem,
    wwdrCertificatePem,
    passTypeIdentifier,
    teamIdentifier,
  ] = values as [string, string, string, string, string];
  if (!/^pass\.[A-Za-z0-9.-]+$/.test(passTypeIdentifier) || !/^[A-Z0-9]{10}$/.test(teamIdentifier))
    throw new AppleWalletConfigError('Apple Wallet public issuer identifiers are invalid.');
  return {
    passCertificatePem,
    passPrivateKeyPem,
    wwdrCertificatePem,
    passTypeIdentifier,
    teamIdentifier,
  };
}
