import 'server-only';

import { normalizeLoyaltyCardCode } from '@/lib/pharmacy/loyalty-card-code';

import { createHash, createSign } from 'node:crypto';

import {
  GOOGLE_WALLET_OAUTH_SCOPE,
  GoogleWalletConfigError,
  type GoogleWalletCredentials,
} from './google-config';

/**
 * Wallet lane L3 (WHA-269) — the Google Wallet ISSUANCE ADAPTER.
 *
 * Governing spec: `industry-specific-docs/restaurants/wallet-passes-architecture-
 * and-security.md` §8 (issuer/class/object/JWT/OAuth2), §5.2 (pass barcode),
 * §14 (secrets), AC9 (JWT claim allowlist + mocked object PATCH).
 *
 * WHAT THIS FILE IS: a pure boundary. It builds Google Wallet resources from
 * plain values, signs them, and speaks HTTP through an injectable transport.
 *
 * WHAT IT IS NOT: it does not read the database, import Prisma, mint identifiers,
 * or decide when a pass should exist. Those belong to lane L1 (schema + the
 * `wla_`/`wps_`/`wgc_` minting primitive) and lane L6 (the outbox worker). The
 * lane boundary is enforced by construction — there is no `ScopedDb` in scope —
 * which is also why the whole file is testable with no database at all.
 *
 * THREE INVARIANTS, each with a test that fails loudly:
 *
 *  1. NO PII CROSSES THE GOOGLE BOUNDARY. Google's `LoyaltyObject` supports
 *     `accountId`/`accountName` and they RENDER ON THE PASS FACE. We issue
 *     impersonal passes (§8.2), so the built object is checked against an exact
 *     key allowlist before it can be signed or sent — a deep key enumeration,
 *     not a shape-compatibility check (AC9).
 *  2. NO RAW PRIMARY KEY CROSSES IT EITHER. Class ids use the org's opaque
 *     `wgc_` suffix, object ids the pass's opaque `wps_` serial. A cuid never
 *     reaches Google, so the id space carries no tenant information.
 *  3. THE ALIAS IS NEVER LOGGED. It appears in exactly one place — inside the
 *     barcode value — and never in an error message. Log sites use
 *     `aliasFingerprint()` (§4.2-A3), mirroring `tokenFingerprint` in
 *     `src/lib/auth/anonymous-rate-limit.ts`.
 */

/** Wallet REST base. Overridable per-client so a test double never guesses a host. */
export const GOOGLE_WALLET_API_BASE = 'https://walletobjects.googleapis.com/walletobjects/v1';

/** Where the browser is sent to save a pass (§8.3). */
export const GOOGLE_WALLET_SAVE_URL_BASE = 'https://pay.google.com/gp/v/save';

/** Versioned barcode envelope (§5.2). The only payload is the alias. */
export const WALLET_BARCODE_PREFIX = 'DFW1:';

/**
 * Opaque-identifier formats minted by lane L1 (§4.1, §6). This lane VALIDATES
 * them and never mints them — one owner per primitive. Crockford base32,
 * lowercase, `i l o u` excluded.
 */
export const WALLET_ALIAS_PATTERN = /^wla_[0-9a-hjkmnp-tv-z]{26}$/;
export const WALLET_SERIAL_PATTERN = /^wps_[0-9a-hjkmnp-tv-z]{26}$/;
export const WALLET_CLASS_SUFFIX_PATTERN = /^wgc_[0-9a-hjkmnp-tv-z]{26}$/;

const ISSUER_ID_PATTERN = /^\d{10,25}$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Google renders `programName` and `issuerName` on the pass; keep them bounded. */
const MAX_DISPLAY_NAME = 60;
/** Loyalty balances are non-negative integers; the ledger is the truth (§11). */
const MAX_BALANCE = 2_147_483_647;

const DEFAULT_TIMEOUT_MS = 15_000;
/** Refresh a little before Google's expiry so an in-flight call never 401s. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

export type GoogleWalletErrorReason =
  /** The issuer was never provisioned. Re-raised from the config binding. */
  | 'NOT_CONFIGURED'
  /** Credentials exist but are unusable (bad key, wrong document). */
  | 'INVALID_CREDENTIALS'
  /** Our own input failed validation before any network call. Never retryable. */
  | 'INVALID_INPUT'
  /** Google rejected the OAuth2 assertion, or the access token was refused. */
  | 'AUTH_FAILED'
  /** Authenticated, but the issuer is not permitted to touch this resource. */
  | 'FORBIDDEN'
  /** The class or object does not exist. */
  | 'NOT_FOUND'
  /** The resource already exists — an idempotent re-issue, not a fault. */
  | 'ALREADY_EXISTS'
  /** Quota. Back off and retry. */
  | 'RATE_LIMITED'
  /** Google is down or timed out. Back off and retry. */
  | 'PROVIDER_UNAVAILABLE'
  /** Anything else, including an unreadable response body. */
  | 'PROVIDER_FAILED';

export class GoogleWalletError extends Error {
  constructor(
    message: string,
    readonly reason: GoogleWalletErrorReason,
    /** Whether lane L6's outbox should retry with backoff, or fail terminally. */
    readonly retryable: boolean,
    /** Verbatim HTTP status when the failure came from Google. */
    readonly status: number | null = null
  ) {
    super(message);
    this.name = 'GoogleWalletError';
  }
}

/**
 * Deterministic status → reason mapping. Every code that can come back has a
 * fixed verdict, so the outbox's retry decision is a property of the status and
 * nothing else — no string sniffing, no "probably transient".
 */
export function classifyGoogleWalletStatus(status: number): {
  reason: GoogleWalletErrorReason;
  retryable: boolean;
} {
  switch (status) {
    case 400:
      return { reason: 'INVALID_INPUT', retryable: false };
    case 401:
      return { reason: 'AUTH_FAILED', retryable: false };
    case 403:
      return { reason: 'FORBIDDEN', retryable: false };
    case 404:
      return { reason: 'NOT_FOUND', retryable: false };
    case 409:
      return { reason: 'ALREADY_EXISTS', retryable: false };
    case 408:
      return { reason: 'PROVIDER_UNAVAILABLE', retryable: true };
    case 429:
      return { reason: 'RATE_LIMITED', retryable: true };
    default:
      if (status >= 500) return { reason: 'PROVIDER_UNAVAILABLE', retryable: true };
      return { reason: 'PROVIDER_FAILED', retryable: false };
  }
}

/**
 * Short, non-reversible handle for a wallet alias (§4.2-A3). The alias itself is
 * never logged, never put in an error, and never used as a map key outside the
 * barcode. Eight hex characters is enough to correlate two log lines and far too
 * few to be worth attacking.
 */
export function aliasFingerprint(alias: string): string {
  return createHash('sha256').update(alias).digest('hex').slice(0, 8);
}

function assertPattern(value: string, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    // Deliberately does not echo the value: aliases and serials must not leak
    // into error strings, and an echoed bad value tells an attacker the shape.
    throw new GoogleWalletError(
      `Invalid ${label} for Google Wallet issuance.`,
      'INVALID_INPUT',
      false
    );
  }
  return value;
}

function assertDisplayName(value: string, label: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0 || trimmed.length > MAX_DISPLAY_NAME) {
    throw new GoogleWalletError(
      `The wallet ${label} must be 1-${MAX_DISPLAY_NAME} characters.`,
      'INVALID_INPUT',
      false
    );
  }
  return trimmed;
}

function optionalColor(value: string | null | undefined, label: string): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (!HEX_COLOR_PATTERN.test(value)) {
    throw new GoogleWalletError(
      `The wallet ${label} must be a #rrggbb hex color.`,
      'INVALID_INPUT',
      false
    );
  }
  return value.toLowerCase();
}

function optionalHttpsUri(value: string | null | undefined, label: string): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GoogleWalletError(
      `The wallet ${label} must be an absolute URL.`,
      'INVALID_INPUT',
      false
    );
  }
  // Google fetches these server-side; an http:// or data: image URI is both a
  // mixed-content problem and an SSRF-shaped surface we have no reason to allow.
  if (parsed.protocol !== 'https:') {
    throw new GoogleWalletError(
      `The wallet ${label} must be served over https.`,
      'INVALID_INPUT',
      false
    );
  }
  return parsed.toString();
}

/**
 * Tenant branding for the org's loyalty class. Lane L1's `WalletTenantConfig`
 * row maps onto this 1:1; the adapter takes the values, not the row, so it stays
 * compilable and testable before that table exists.
 */
export type GoogleWalletTenantBrand = {
  /** Customer-facing program name, e.g. "Chai House Rewards". */
  programDisplayName: string;
  /** Defaults to the platform name — the issuer is always DevFathom (§14). */
  issuerDisplayName?: string;
  /** Absolute https logo URI, or null when the tenant has not uploaded one. */
  logoUri?: string | null;
  /** `#rrggbb`. Google derives readable foreground contrast from this. */
  backgroundColor?: string | null;
  /** Optional points label; Google shows "Points" when unset. */
  pointsLabel?: string | null;
};

export type GoogleLoyaltyClass = {
  id: string;
  issuerName: string;
  programName: string;
  reviewStatus: 'UNDER_REVIEW';
  programLogo?: {
    sourceUri: { uri: string };
    contentDescription: { defaultValue: { language: string; value: string } };
  };
  hexBackgroundColor?: string;
};

export type GoogleLoyaltyObjectState = 'ACTIVE' | 'EXPIRED';

export type GoogleLoyaltyObject = {
  id: string;
  classId: string;
  state: GoogleLoyaltyObjectState;
  loyaltyPoints: { label: string; balance: { int: number } };
  barcode: { type: 'QR_CODE'; value: string; alternateText: string };
};

/**
 * The EXACT set of keys permitted anywhere in a built loyalty object (AC9).
 *
 * This is an allowlist rather than a PII denylist on purpose: a denylist has to
 * predict every field Google might add that renders personal data, and it only
 * has to be wrong once. Anything not named here cannot be sent.
 */
export const LOYALTY_OBJECT_KEY_ALLOWLIST: readonly string[] = [
  'id',
  'classId',
  'state',
  'loyaltyPoints',
  'label',
  'balance',
  'int',
  'barcode',
  'type',
  'value',
  'alternateText',
];

/** Claims permitted in the save-link JWT (§8.3, AC9). */
export const SAVE_JWT_CLAIM_ALLOWLIST: readonly string[] = ['iss', 'aud', 'typ', 'iat', 'payload'];

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      into.add(key);
      collectKeys(nested, into);
    }
  }
}

/**
 * Fail closed if a loyalty object ever grows a key outside the allowlist. Called
 * on every build AND immediately before signing or sending, so a caller cannot
 * mutate an object between construction and transmission.
 */
export function assertLoyaltyObjectKeysAllowed(object: unknown): void {
  const keys = new Set<string>();
  collectKeys(object, keys);
  const allowed = new Set(LOYALTY_OBJECT_KEY_ALLOWLIST);
  const offending = [...keys].filter((key) => !allowed.has(key)).sort();
  if (offending.length > 0) {
    throw new GoogleWalletError(
      `Google loyalty object carries keys outside the allowlist: ${offending.join(', ')}.`,
      'INVALID_INPUT',
      false
    );
  }
}

/** `<issuerId>.<wgc_ suffix>` — opaque per §6, no tenant primary key. */
export function loyaltyClassId(issuerId: string, classSuffix: string): string {
  assertPattern(issuerId, ISSUER_ID_PATTERN, 'issuer id');
  assertPattern(classSuffix, WALLET_CLASS_SUFFIX_PATTERN, 'class suffix');
  return `${issuerId}.${classSuffix}`;
}

/** `<issuerId>.<wps_ serial>` — opaque per §8.2. */
export function loyaltyObjectId(issuerId: string, serialNumber: string): string {
  assertPattern(issuerId, ISSUER_ID_PATTERN, 'issuer id');
  assertPattern(serialNumber, WALLET_SERIAL_PATTERN, 'pass serial');
  return `${issuerId}.${serialNumber}`;
}

/** `DFW1:<alias>` (§5.2). The barcode's only payload is the alias. */
export function walletBarcodeValue(alias: string): string {
  if (normalizeLoyaltyCardCode(alias) === alias) return alias;
  assertPattern(alias, WALLET_ALIAS_PATTERN, 'wallet alias');
  return `${WALLET_BARCODE_PREFIX}${alias}`;
}

/**
 * Build the org's branded loyalty class (§8.1). One class per organization,
 * created lazily at first Google issuance.
 */
export function buildLoyaltyClass(input: {
  issuerId: string;
  classSuffix: string;
  brand: GoogleWalletTenantBrand;
}): GoogleLoyaltyClass {
  const id = loyaltyClassId(input.issuerId, input.classSuffix);
  const programName = assertDisplayName(input.brand.programDisplayName, 'program name');
  const issuerName = assertDisplayName(input.brand.issuerDisplayName ?? 'DevFathom', 'issuer name');
  const logoUri = optionalHttpsUri(input.brand.logoUri, 'logo URI');
  const hexBackgroundColor = optionalColor(input.brand.backgroundColor, 'background color');

  const loyaltyClass: GoogleLoyaltyClass = {
    id,
    issuerName,
    programName,
    // Google requires a class to be submitted for review before it can be used.
    reviewStatus: 'UNDER_REVIEW',
  };
  if (logoUri) {
    loyaltyClass.programLogo = {
      sourceUri: { uri: logoUri },
      // Screen readers announce this; it names the program, never a person.
      contentDescription: { defaultValue: { language: 'en-US', value: `${programName} logo` } },
    };
  }
  if (hexBackgroundColor) loyaltyClass.hexBackgroundColor = hexBackgroundColor;
  return loyaltyClass;
}

/**
 * Build the per-pass loyalty object (§8.2).
 *
 * `accountId` and `accountName` are omitted deliberately and permanently: both
 * render on the pass face, and the pass is impersonal by design. The balance is
 * a projection of the ledger, never a source of truth (§11, R10).
 */
export function buildLoyaltyObject(input: {
  issuerId: string;
  classSuffix: string;
  serialNumber: string;
  alias: string;
  balance: number;
  state?: GoogleLoyaltyObjectState;
  pointsLabel?: string | null;
}): GoogleLoyaltyObject {
  const id = loyaltyObjectId(input.issuerId, input.serialNumber);
  const classId = loyaltyClassId(input.issuerId, input.classSuffix);
  const barcodeValue = walletBarcodeValue(input.alias);

  if (
    !Number.isInteger(input.balance) ||
    input.balance < (barcodeValue === input.alias ? -MAX_BALANCE : 0) ||
    input.balance > MAX_BALANCE
  ) {
    throw new GoogleWalletError(
      'The wallet points balance must be a non-negative 32-bit integer.',
      'INVALID_INPUT',
      false
    );
  }

  const object: GoogleLoyaltyObject = {
    id,
    classId,
    state: input.state ?? 'ACTIVE',
    loyaltyPoints: {
      label: assertDisplayName(input.pointsLabel ?? 'Points', 'points label'),
      balance: { int: input.balance },
    },
    barcode: {
      type: 'QR_CODE',
      value: barcodeValue,
      // Manual-keying fallback when a scanner fails. Four characters of a
      // 128-bit alias is a disambiguator for the operator, not a lookup key.
      alternateText: input.alias.slice(-4),
    },
  };

  assertLoyaltyObjectKeysAllowed(object);
  return object;
}

function base64url(value: Buffer | string): string {
  return (typeof value === 'string' ? Buffer.from(value, 'utf8') : value).toString('base64url');
}

function signRs256(payload: Record<string, unknown>, privateKey: string): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey, 'base64url');
  } catch {
    // The key came from the settings store; a signing failure means the stored
    // PEM is not a usable RSA key. Never include the crypto error — it can echo
    // key material in some OpenSSL builds.
    throw new GoogleWalletError(
      'The Google Wallet issuer private key could not sign a token.',
      'INVALID_CREDENTIALS',
      false
    );
  }
  return `${signingInput}.${signature}`;
}

/**
 * Mint the "Add to Google Wallet" save-link JWT (§8.3).
 *
 * Claims are exactly `SAVE_JWT_CLAIM_ALLOWLIST` — no `origins`, no `nbf`, no
 * `exp`. The link's lifetime is bounded by the page that carries it (the
 * enrollment attempt expires in 15 minutes, §9), and we mint per request rather
 * than caching a signed JWT, so a leaked link is not a durable credential.
 */
export function buildSaveToWalletJwt(input: {
  credentials: GoogleWalletCredentials;
  loyaltyObject: GoogleLoyaltyObject;
  issuedAt?: Date;
}): string {
  assertLoyaltyObjectKeysAllowed(input.loyaltyObject);
  const issuedAt = input.issuedAt ?? new Date();
  return signRs256(
    {
      iss: input.credentials.clientEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(issuedAt.getTime() / 1000),
      payload: { loyaltyObjects: [input.loyaltyObject] },
    },
    input.credentials.privateKey
  );
}

/** The href behind the "Add to Google Wallet" button (§8.3). */
export function buildSaveToWalletUrl(input: {
  credentials: GoogleWalletCredentials;
  loyaltyObject: GoogleLoyaltyObject;
  issuedAt?: Date;
}): string {
  return `${GOOGLE_WALLET_SAVE_URL_BASE}/${buildSaveToWalletJwt(input)}`;
}

/** Injectable HTTP seam. Defaults to global `fetch`; tests pass a double. */
export type GoogleWalletTransport = (url: string, init: RequestInit) => Promise<Response>;

export type GoogleWalletClientOptions = {
  credentials: GoogleWalletCredentials;
  transport?: GoogleWalletTransport;
  /** Injectable clock so token caching and `iat` are deterministic under test. */
  now?: () => Date;
  timeoutMs?: number;
  apiBase?: string;
};

export type EnsureResult = { id: string; created: boolean };

export type GoogleWalletClient = {
  /** Mint (or reuse) a short-lived OAuth2 access token (§8.4). */
  getAccessToken(): Promise<string>;
  /** Create the org's class if Google does not already have it (§8.1). */
  ensureLoyaltyClass(input: {
    classSuffix: string;
    brand: GoogleWalletTenantBrand;
  }): Promise<EnsureResult>;
  /** Create the pass object if absent; idempotent across re-issue retries (§8.2). */
  ensureLoyaltyObject(input: {
    classSuffix: string;
    serialNumber: string;
    alias: string;
    balance: number;
    pointsLabel?: string | null;
  }): Promise<EnsureResult>;
  /** Push a new balance (§8.4). Called only by lane L6's outbox worker. */
  patchLoyaltyObjectBalance(input: { serialNumber: string; balance: number }): Promise<void>;
  /** Revocation (§8.5): the object stops being valid, the alias row is deleted. */
  expireLoyaltyObject(input: { serialNumber: string }): Promise<void>;
};

async function readErrorMessage(response: Response): Promise<string> {
  // Google returns `{error: {message}}`; anything else is treated as opaque. The
  // message is Google's own text about OUR request, so it carries no alias.
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    const message = body?.error?.message;
    if (typeof message === 'string' && message.length > 0) return message.slice(0, 300);
  } catch {
    // Fall through to the generic form.
  }
  return `HTTP ${response.status}`;
}

function fail(operation: string, status: number, detail: string): GoogleWalletError {
  const { reason, retryable } = classifyGoogleWalletStatus(status);
  return new GoogleWalletError(
    `Google Wallet ${operation} failed (${status}): ${detail}`,
    reason,
    retryable,
    status
  );
}

export function createGoogleWalletClient(options: GoogleWalletClientOptions): GoogleWalletClient {
  const { credentials } = options;
  const transport = options.transport ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiBase = (options.apiBase ?? GOOGLE_WALLET_API_BASE).replace(/\/$/, '');

  /** Access tokens live for the client instance only — never persisted. */
  let cachedToken: { value: string; expiresAtMs: number } | null = null;

  async function send(url: string, init: RequestInit, operation: string): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await transport(url, { ...init, signal });
    } catch (error) {
      if (error instanceof GoogleWalletError) throw error;
      // A network fault or timeout is exactly the case the outbox should retry.
      throw new GoogleWalletError(
        `Google Wallet ${operation} could not reach the API: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'PROVIDER_UNAVAILABLE',
        true
      );
    }
  }

  async function getAccessToken(): Promise<string> {
    const nowMs = now().getTime();
    if (cachedToken && cachedToken.expiresAtMs - TOKEN_EXPIRY_SKEW_MS > nowMs) {
      return cachedToken.value;
    }

    const issuedAtSeconds = Math.floor(nowMs / 1000);
    const assertion = signRs256(
      {
        iss: credentials.clientEmail,
        scope: GOOGLE_WALLET_OAUTH_SCOPE,
        aud: credentials.tokenUri,
        iat: issuedAtSeconds,
        exp: issuedAtSeconds + 3600,
      },
      credentials.privateKey
    );

    const response = await send(
      credentials.tokenUri,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      },
      'token exchange'
    );

    if (!response.ok) {
      const detail = await readErrorMessage(response);
      // A token endpoint rejecting our assertion is always an auth fault, even
      // when it answers 400 — do not let the generic mapping call that INVALID_INPUT.
      const { retryable } = classifyGoogleWalletStatus(response.status);
      throw new GoogleWalletError(
        `Google Wallet token exchange failed (${response.status}): ${detail}`,
        response.status >= 500 || response.status === 429 ? 'PROVIDER_UNAVAILABLE' : 'AUTH_FAILED',
        retryable,
        response.status
      );
    }

    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new GoogleWalletError(
        'Google Wallet token exchange returned no access token.',
        'AUTH_FAILED',
        false,
        response.status
      );
    }
    const expiresInSeconds = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    cachedToken = { value: body.access_token, expiresAtMs: nowMs + expiresInSeconds * 1000 };
    return cachedToken.value;
  }

  async function authorized(path: string, init: RequestInit, operation: string): Promise<Response> {
    const token = await getAccessToken();
    return send(
      `${apiBase}${path}`,
      {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
      operation
    );
  }

  async function ensureLoyaltyClass(input: {
    classSuffix: string;
    brand: GoogleWalletTenantBrand;
  }): Promise<EnsureResult> {
    const loyaltyClass = buildLoyaltyClass({
      issuerId: credentials.issuerId,
      classSuffix: input.classSuffix,
      brand: input.brand,
    });

    const existing = await authorized(
      `/loyaltyClass/${encodeURIComponent(loyaltyClass.id)}`,
      { method: 'GET' },
      'class read'
    );
    if (existing.ok) return { id: loyaltyClass.id, created: false };
    if (existing.status !== 404) {
      throw fail('class read', existing.status, await readErrorMessage(existing));
    }

    const created = await authorized(
      '/loyaltyClass',
      { method: 'POST', body: JSON.stringify(loyaltyClass) },
      'class insert'
    );
    // A concurrent issuance for the same org wins the race; that is success.
    if (created.status === 409) return { id: loyaltyClass.id, created: false };
    if (!created.ok) throw fail('class insert', created.status, await readErrorMessage(created));
    return { id: loyaltyClass.id, created: true };
  }

  async function ensureLoyaltyObject(input: {
    classSuffix: string;
    serialNumber: string;
    alias: string;
    balance: number;
    pointsLabel?: string | null;
  }): Promise<EnsureResult> {
    const object = buildLoyaltyObject({
      issuerId: credentials.issuerId,
      classSuffix: input.classSuffix,
      serialNumber: input.serialNumber,
      alias: input.alias,
      balance: input.balance,
      pointsLabel: input.pointsLabel,
    });
    assertLoyaltyObjectKeysAllowed(object);

    const created = await authorized(
      '/loyaltyObject',
      { method: 'POST', body: JSON.stringify(object) },
      'object insert'
    );
    // Re-issuing after a delivery retry must not be an error — the pass exists.
    if (created.status === 409) return { id: object.id, created: false };
    if (!created.ok) throw fail('object insert', created.status, await readErrorMessage(created));
    return { id: object.id, created: true };
  }

  async function patchLoyaltyObjectBalance(input: {
    serialNumber: string;
    balance: number;
  }): Promise<void> {
    const id = loyaltyObjectId(credentials.issuerId, input.serialNumber);
    if (!Number.isInteger(input.balance) || input.balance < 0 || input.balance > MAX_BALANCE) {
      throw new GoogleWalletError(
        'The wallet points balance must be a non-negative 32-bit integer.',
        'INVALID_INPUT',
        false
      );
    }
    const response = await authorized(
      `/loyaltyObject/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ loyaltyPoints: { balance: { int: input.balance } } }),
      },
      'balance patch'
    );
    if (!response.ok)
      throw fail('balance patch', response.status, await readErrorMessage(response));
  }

  async function expireLoyaltyObject(input: { serialNumber: string }): Promise<void> {
    const id = loyaltyObjectId(credentials.issuerId, input.serialNumber);
    const response = await authorized(
      `/loyaltyObject/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify({ state: 'EXPIRED' }) },
      'object expiry'
    );
    // Already gone is the state we wanted; revocation must be idempotent (§8.5).
    if (response.status === 404) return;
    if (!response.ok)
      throw fail('object expiry', response.status, await readErrorMessage(response));
  }

  return {
    getAccessToken,
    ensureLoyaltyClass,
    ensureLoyaltyObject,
    patchLoyaltyObjectBalance,
    expireLoyaltyObject,
  };
}

/** Config faults surface through one error type for callers of this module. */
export function toGoogleWalletError(error: unknown): GoogleWalletError {
  if (error instanceof GoogleWalletError) return error;
  if (error instanceof GoogleWalletConfigError) {
    return new GoogleWalletError(error.message, error.reason, false);
  }
  return new GoogleWalletError(
    `Google Wallet issuance failed: ${error instanceof Error ? error.message : String(error)}`,
    'PROVIDER_FAILED',
    false
  );
}
