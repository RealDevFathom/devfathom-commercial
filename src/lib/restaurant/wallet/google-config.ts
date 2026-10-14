import 'server-only';

import { decryptSecret, encryptionConfigured } from '@/lib/secret-crypto';

/**
 * Wallet lane L3 (WHA-269) — the Google issuer CONFIG BINDING.
 *
 * Governing spec: `industry-specific-docs/restaurants/wallet-passes-architecture-
 * and-security.md` §8 (Google) and §14 (secret-store handling).
 *
 * Two rules shape this file and both come straight from §14:
 *
 *  1. THERE IS EXACTLY ONE ISSUER, AND IT IS THE PLATFORM'S. No per-tenant
 *     issuer credential exists anywhere in this codebase. Tenants are separated
 *     inside the single issuer by an opaque per-org class suffix (§6), never by
 *     a credential.
 *  2. ISSUER MATERIAL IS A *SETTING*, NOT AN ENV VAR. It lives in sensitive
 *     `PlatformSetting` rows under the existing AES-256-GCM envelope, so ops can
 *     rotate a signing key without a redeploy. This module therefore introduces
 *     no new environment variable; the only env it depends on transitively is
 *     the pre-existing `PLATFORM_ENCRYPTION_KEY`.
 *
 * The reader is a SEAM (`GoogleWalletSecretBinding`), not a Prisma import. This
 * lane owns no schema and no query: the caller supplies "how do I read a
 * platform setting", and this module owns "what does a valid Google issuer
 * credential look like, and what happens when it is missing".
 */

/** Setting keys for the platform Google Wallet issuer (§14). */
export const GOOGLE_WALLET_SETTING_KEYS = {
  /** Sensitive. The full service-account JSON, including its private key. */
  serviceAccount: 'wallet.google.serviceAccount',
  /** Not sensitive. The numeric Google Wallet issuer id — public on every pass. */
  issuerId: 'wallet.google.issuerId',
} as const;

export const GOOGLE_WALLET_SETTING_CATEGORY = 'wallet';

/**
 * Declarative registry of the settings this lane needs. Platform settings are
 * free-form key/category/value rows, so the `sensitive` flag is the only thing
 * standing between a private key and a plaintext column — declaring it here (and
 * asserting it in tests) keeps that flag from being set by hand and mis-set.
 */
export const GOOGLE_WALLET_SETTING_DECLARATIONS = [
  {
    key: GOOGLE_WALLET_SETTING_KEYS.serviceAccount,
    category: GOOGLE_WALLET_SETTING_CATEGORY,
    sensitive: true,
    description:
      'Google Wallet issuer service-account JSON (signs save-link JWTs and mints OAuth2 tokens).',
  },
  {
    key: GOOGLE_WALLET_SETTING_KEYS.issuerId,
    category: GOOGLE_WALLET_SETTING_CATEGORY,
    sensitive: false,
    description: 'Google Wallet issuer id. Public — it prefixes every class and object id.',
  },
] as const;

/**
 * The ops prerequisite this lane cannot satisfy itself (§20-D1). Recorded as a
 * constant so the live test can *report* it rather than silently skipping, which
 * is the difference between "not proven" and "proven absent".
 */
export const GOOGLE_WALLET_PROVISIONING_PREREQUISITE = {
  issue: 'WHA-268',
  title: 'Wallet prerequisite — Google issuer account provisioning',
  /** Observed on the board at implementation time (2026-08-28). */
  statusAtImplementation: 'blocked',
  delivers: [
    GOOGLE_WALLET_SETTING_KEYS.issuerId,
    GOOGLE_WALLET_SETTING_KEYS.serviceAccount,
  ] as readonly string[],
  note:
    'Until WHA-268 registers the issuer account and writes the two settings above, no live ' +
    'Google Wallet call can succeed. Every mocked contract test in this lane runs regardless.',
} as const;

/** Scope required to read and write loyalty classes/objects. */
export const GOOGLE_WALLET_OAUTH_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

export type GoogleWalletConfigErrorReason =
  /** No setting row, or an empty one. The issuer has never been provisioned. */
  | 'NOT_CONFIGURED'
  /** A row exists but cannot be decrypted or does not parse as a service account. */
  | 'INVALID_CREDENTIALS';

export class GoogleWalletConfigError extends Error {
  constructor(
    message: string,
    readonly reason: GoogleWalletConfigErrorReason
  ) {
    super(message);
    this.name = 'GoogleWalletConfigError';
  }
}

/** Exactly what the adapter needs to sign and call. Nothing tenant-scoped. */
export type GoogleWalletCredentials = {
  /** Numeric Google issuer id; prefixes every class and object id. */
  issuerId: string;
  /** Service-account address — the `iss` claim of both JWTs we sign. */
  clientEmail: string;
  /** PKCS#8 PEM private key. Held in memory only for the duration of a signature. */
  privateKey: string;
  /** Token endpoint from the service account, so a test double stays self-consistent. */
  tokenUri: string;
};

/** The shape `PlatformSetting` rows come back in. Deliberately not a Prisma type. */
export type PlatformSettingRecord = {
  key: string;
  value: unknown;
  sensitive: boolean;
};

/**
 * The secret binding. `readSetting` is the caller's platform-scoped read; the
 * crypto hooks default to the real ones and exist so a test never needs a live
 * `PLATFORM_ENCRYPTION_KEY`.
 */
export type GoogleWalletSecretBinding = {
  readSetting: (key: string) => Promise<PlatformSettingRecord | null>;
  decrypt?: (ciphertext: string) => string;
  isEncryptionConfigured?: () => boolean;
};

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** Google issuer ids are numeric. Reject anything else before it reaches a URL. */
const ISSUER_ID_PATTERN = /^\d{10,25}$/;

/**
 * Unwrap a stored setting value. Sensitive rows are written by
 * `platform.settings` as `{ encrypted: '<v1 envelope>' }` over a JSON-stringified
 * value; non-sensitive rows hold the value directly.
 */
function unwrapSettingValue(record: PlatformSettingRecord, binding: GoogleWalletSecretBinding) {
  if (!record.sensitive) return record.value;

  const envelope =
    record.value && typeof record.value === 'object' && 'encrypted' in record.value
      ? (record.value as { encrypted?: unknown }).encrypted
      : null;

  if (typeof envelope !== 'string' || envelope.length === 0) {
    throw new GoogleWalletConfigError(
      `Platform setting "${record.key}" is marked sensitive but carries no encrypted envelope.`,
      'INVALID_CREDENTIALS'
    );
  }

  const isConfigured = binding.isEncryptionConfigured ?? encryptionConfigured;
  if (!isConfigured()) {
    // A missing encryption key is a deployment fault, not a bad credential — say
    // so precisely, because the two have completely different remedies.
    throw new GoogleWalletConfigError(
      'PLATFORM_ENCRYPTION_KEY is not configured, so the Google Wallet issuer credential ' +
        'cannot be decrypted.',
      'NOT_CONFIGURED'
    );
  }

  let plaintext: string;
  try {
    plaintext = (binding.decrypt ?? decryptSecret)(envelope);
  } catch {
    // Never echo the ciphertext or the underlying crypto error: a decrypt
    // failure message is an oracle about key state.
    throw new GoogleWalletConfigError(
      `Platform setting "${record.key}" could not be decrypted with the current encryption key.`,
      'INVALID_CREDENTIALS'
    );
  }

  try {
    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new GoogleWalletConfigError(
      `Platform setting "${record.key}" did not decrypt to valid JSON.`,
      'INVALID_CREDENTIALS'
    );
  }
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Validate a Google service-account document. Accepts the object or the raw JSON
 * string, because ops paste either into a settings field.
 */
export function parseServiceAccount(raw: unknown): {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
} {
  let source = raw;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      throw new GoogleWalletConfigError(
        'The Google Wallet service account is not valid JSON.',
        'INVALID_CREDENTIALS'
      );
    }
  }

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new GoogleWalletConfigError(
      'The Google Wallet service account must be a JSON object.',
      'INVALID_CREDENTIALS'
    );
  }

  const record = source as Record<string, unknown>;
  const type = readString(record, 'type');
  if (type !== null && type !== 'service_account') {
    throw new GoogleWalletConfigError(
      `The Google Wallet credential is a "${type}" document, not a service account.`,
      'INVALID_CREDENTIALS'
    );
  }

  const clientEmail = readString(record, 'client_email');
  const privateKeyRaw = readString(record, 'private_key');
  if (!clientEmail || !privateKeyRaw) {
    throw new GoogleWalletConfigError(
      'The Google Wallet service account is missing client_email or private_key.',
      'INVALID_CREDENTIALS'
    );
  }

  // JSON-embedded PEMs routinely arrive with literal backslash-n sequences.
  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');
  if (!privateKey.includes('BEGIN') || !privateKey.includes('PRIVATE KEY')) {
    throw new GoogleWalletConfigError(
      'The Google Wallet service account private_key is not a PEM private key.',
      'INVALID_CREDENTIALS'
    );
  }

  return {
    clientEmail,
    privateKey,
    tokenUri: readString(record, 'token_uri') ?? DEFAULT_TOKEN_URI,
  };
}

/**
 * Resolve the platform issuer credential through the binding.
 *
 * Throws `NOT_CONFIGURED` when the issuer has never been provisioned — the
 * expected state until WHA-268 lands — and `INVALID_CREDENTIALS` when something
 * is present but wrong. Callers act on those two very differently: the first is
 * "feature off", the second is "page someone".
 */
export async function resolveGoogleWalletCredentials(
  binding: GoogleWalletSecretBinding
): Promise<GoogleWalletCredentials> {
  const [issuerRecord, serviceAccountRecord] = await Promise.all([
    binding.readSetting(GOOGLE_WALLET_SETTING_KEYS.issuerId),
    binding.readSetting(GOOGLE_WALLET_SETTING_KEYS.serviceAccount),
  ]);

  const missing: string[] = [];
  if (!issuerRecord) missing.push(GOOGLE_WALLET_SETTING_KEYS.issuerId);
  if (!serviceAccountRecord) missing.push(GOOGLE_WALLET_SETTING_KEYS.serviceAccount);

  if (missing.length > 0) {
    throw new GoogleWalletConfigError(
      `The Google Wallet issuer is not provisioned (missing: ${missing.join(', ')}). ` +
        `See ${GOOGLE_WALLET_PROVISIONING_PREREQUISITE.issue}.`,
      'NOT_CONFIGURED'
    );
  }

  const issuerValue = unwrapSettingValue(issuerRecord!, binding);
  const issuerId = typeof issuerValue === 'string' ? issuerValue.trim() : String(issuerValue ?? '');
  if (!ISSUER_ID_PATTERN.test(issuerId)) {
    throw new GoogleWalletConfigError(
      'The Google Wallet issuer id must be the numeric issuer id from the Google Pay & Wallet console.',
      'INVALID_CREDENTIALS'
    );
  }

  const serviceAccount = parseServiceAccount(unwrapSettingValue(serviceAccountRecord!, binding));

  return { issuerId, ...serviceAccount };
}

/** What a live call needs, and what is missing right now. */
export type GoogleWalletReadiness = {
  ready: boolean;
  /** Setting keys (or `PLATFORM_ENCRYPTION_KEY`) that are absent or unusable. */
  missing: string[];
  /** Present only when something is configured but invalid. */
  invalidReason: GoogleWalletConfigErrorReason | null;
  prerequisite: typeof GOOGLE_WALLET_PROVISIONING_PREREQUISITE;
  /** A single line safe to print in CI output — contains no credential material. */
  summary: string;
};

/**
 * Non-throwing readiness probe. This is what a live/integration check calls so it
 * can REPORT the prerequisite state instead of skipping — a skipped test and a
 * passing test are indistinguishable in a summary line, and this lane's whole
 * live path is gated on an ops action owned by another issue.
 */
export async function describeGoogleWalletReadiness(
  binding: GoogleWalletSecretBinding
): Promise<GoogleWalletReadiness> {
  const prerequisite = GOOGLE_WALLET_PROVISIONING_PREREQUISITE;
  try {
    await resolveGoogleWalletCredentials(binding);
    return {
      ready: true,
      missing: [],
      invalidReason: null,
      prerequisite,
      summary: `Google Wallet issuer configured; live issuance available (${prerequisite.issue} satisfied).`,
    };
  } catch (error) {
    if (!(error instanceof GoogleWalletConfigError)) throw error;

    const missing: string[] = [];
    const match = /missing: ([^)]+)\)/.exec(error.message);
    if (match) missing.push(...match[1].split(', '));
    else if (error.message.includes('PLATFORM_ENCRYPTION_KEY'))
      missing.push('PLATFORM_ENCRYPTION_KEY');

    return {
      ready: false,
      missing,
      invalidReason: error.reason,
      prerequisite,
      summary:
        `Google Wallet issuer NOT ready (${error.reason}). ` +
        `Prerequisite ${prerequisite.issue} "${prerequisite.title}" was ` +
        `${prerequisite.statusAtImplementation} at implementation time. ` +
        `Live issuance cannot be exercised; mocked contract tests are authoritative.`,
    };
  }
}
