/**
 * Wallet lane L3 (WHA-269) — Google issuance, driven entirely through a mocked
 * transport.
 *
 * The cases here are the ones that actually decide whether this boundary is
 * safe: what leaves the process inside a signed JWT (AC9), what an operator's
 * pass would render, what the outbox worker is told to retry, and whether a
 * wallet alias can escape into a log line or an error string.
 *
 * No network, no database, no credentials — an RSA keypair is generated in
 * process so signatures are really verified rather than shape-checked.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { GoogleWalletCredentials } from './google-config';
import {
  GOOGLE_WALLET_SAVE_URL_BASE,
  GoogleWalletError,
  LOYALTY_OBJECT_KEY_ALLOWLIST,
  SAVE_JWT_CLAIM_ALLOWLIST,
  WALLET_BARCODE_PREFIX,
  aliasFingerprint,
  assertLoyaltyObjectKeysAllowed,
  buildLoyaltyClass,
  buildLoyaltyObject,
  buildSaveToWalletJwt,
  buildSaveToWalletUrl,
  classifyGoogleWalletStatus,
  createGoogleWalletClient,
  loyaltyClassId,
  loyaltyObjectId,
  walletBarcodeValue,
  type GoogleWalletTransport,
} from './google';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ISSUER_ID = '3388000000022345678';

const CREDENTIALS: GoogleWalletCredentials = {
  issuerId: ISSUER_ID,
  clientEmail: 'wallet-issuer@devfathom.iam.gserviceaccount.com',
  privateKey,
  tokenUri: 'https://oauth2.googleapis.com/token',
};

/** Shapes minted by lane L1; this lane only ever validates them. 26 Crockford chars each. */
const ALIAS = 'wla_3g7v9k2m5q8r1t4w6y0zb3d5f7';
const SERIAL = 'wps_g7v9k2m5q8r1t4w6y0zb3d5f73';
const CLASS_SUFFIX = 'wgc_7v9k2m5q8r1t4w6y0zb3d5f73g';
const OTHER_CLASS_SUFFIX = 'wgc_v9k2m5q8r1t4w6y0zb3d5f73g7';

const BRAND = {
  programDisplayName: 'Chai House Rewards',
  logoUri: 'https://cdn.devfathom.test/tenants/chai-house/logo.png',
  backgroundColor: '#1F2937',
};

type RecordedCall = { url: string; init: RequestInit };

/**
 * A transport double that answers from a queue and records every call, so a test
 * can assert both what we sent and that we did NOT send something.
 */
function mockTransport(responses: Array<Response | Error>): {
  transport: GoogleWalletTransport;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const transport: GoogleWalletTransport = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected extra request to ${url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TOKEN_RESPONSE = () => json({ access_token: 'ya29.test-access-token', expires_in: 3600 });

function decodeJwt(jwt: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: string;
  signature: string;
} {
  const [header, claims, signature] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >,
    signingInput: `${header}.${claims}`,
    signature,
  };
}

function verifyRs256(signingInput: string, signature: string): boolean {
  return createVerify('RSA-SHA256').update(signingInput).verify(publicKey, signature, 'base64url');
}

/** Every key at every depth — the deep enumeration AC9 asks for. */
function deepKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) deepKeys(entry, into);
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      into.add(key);
      deepKeys(nested, into);
    }
  }
  return into;
}

/**
 * Capture a thrown/rejected `GoogleWalletError` and assert its verdict fields.
 * The reason and the retryable flag ARE the contract lane L6 consumes, so they
 * are asserted directly rather than through a message regex.
 */
function expectWalletError(
  error: unknown,
  expected: { reason: string; retryable: boolean; status?: number | null }
): GoogleWalletError {
  expect(error).toBeInstanceOf(GoogleWalletError);
  const walletError = error as GoogleWalletError;
  expect(walletError.reason).toBe(expected.reason);
  expect(walletError.retryable).toBe(expected.retryable);
  if ('status' in expected) expect(walletError.status).toBe(expected.status);
  return walletError;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

function captureThrow(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw, but it returned.');
}

function client(responses: Array<Response | Error>, nowMs = Date.UTC(2026, 7, 28, 12, 0, 0)) {
  const { transport, calls } = mockTransport(responses);
  return {
    calls,
    api: createGoogleWalletClient({
      credentials: CREDENTIALS,
      transport,
      now: () => new Date(nowMs),
    }),
  };
}

describe('opaque identifiers at the Google boundary', () => {
  it('composes class and object ids from the issuer id and an opaque suffix', () => {
    expect(loyaltyClassId(ISSUER_ID, CLASS_SUFFIX)).toBe(`${ISSUER_ID}.${CLASS_SUFFIX}`);
    expect(loyaltyObjectId(ISSUER_ID, SERIAL)).toBe(`${ISSUER_ID}.${SERIAL}`);
  });

  it('rejects a cuid where an opaque suffix belongs, so no primary key reaches Google', () => {
    // A RestaurantCustomer / organization cuid is exactly the value a careless
    // caller would reach for. It must not be accepted anywhere in this module.
    expect(() => loyaltyClassId(ISSUER_ID, 'clx8p2q4r0000v3k9abcdef12')).toThrow(GoogleWalletError);
    expect(() => loyaltyObjectId(ISSUER_ID, 'clx8p2q4r0000v3k9abcdef12')).toThrow(
      GoogleWalletError
    );
  });

  it('rejects a non-numeric issuer id before it can be interpolated into a URL', () => {
    expect(() => loyaltyClassId('../../evil', CLASS_SUFFIX)).toThrow(GoogleWalletError);
  });

  it('separates two tenants by class suffix alone, with one shared issuer', () => {
    const first = buildLoyaltyClass({
      issuerId: ISSUER_ID,
      classSuffix: CLASS_SUFFIX,
      brand: BRAND,
    });
    const second = buildLoyaltyClass({
      issuerId: ISSUER_ID,
      classSuffix: OTHER_CLASS_SUFFIX,
      brand: { programDisplayName: 'Karachi Grill Club' },
    });
    expect(first.id).not.toBe(second.id);
    expect(first.id.startsWith(`${ISSUER_ID}.`)).toBe(true);
    expect(second.id.startsWith(`${ISSUER_ID}.`)).toBe(true);
    expect(first.programName).toBe('Chai House Rewards');
    expect(second.programName).toBe('Karachi Grill Club');
  });
});

describe('branded tenant class', () => {
  it('carries the tenant program name, logo and colour, under the DevFathom issuer', () => {
    const built = buildLoyaltyClass({
      issuerId: ISSUER_ID,
      classSuffix: CLASS_SUFFIX,
      brand: BRAND,
    });
    expect(built).toEqual({
      id: `${ISSUER_ID}.${CLASS_SUFFIX}`,
      issuerName: 'DevFathom',
      programName: 'Chai House Rewards',
      reviewStatus: 'UNDER_REVIEW',
      programLogo: {
        sourceUri: { uri: BRAND.logoUri },
        contentDescription: {
          defaultValue: { language: 'en-US', value: 'Chai House Rewards logo' },
        },
      },
      hexBackgroundColor: '#1f2937',
    });
  });

  it('omits branding a tenant has not supplied rather than inventing a default', () => {
    const built = buildLoyaltyClass({
      issuerId: ISSUER_ID,
      classSuffix: CLASS_SUFFIX,
      brand: { programDisplayName: 'Plain Program', logoUri: null, backgroundColor: null },
    });
    expect(built.programLogo).toBeUndefined();
    expect(built.hexBackgroundColor).toBeUndefined();
  });

  it('refuses a non-https logo URI, a malformed colour and an empty program name', () => {
    const base = { issuerId: ISSUER_ID, classSuffix: CLASS_SUFFIX };
    expect(() =>
      buildLoyaltyClass({
        ...base,
        brand: { programDisplayName: 'X', logoUri: 'http://cdn.test/logo.png' },
      })
    ).toThrow(/https/);
    expect(() =>
      buildLoyaltyClass({ ...base, brand: { programDisplayName: 'X', backgroundColor: 'navy' } })
    ).toThrow(/hex color/);
    expect(() => buildLoyaltyClass({ ...base, brand: { programDisplayName: '   ' } })).toThrow(
      /program name/
    );
  });
});

describe('impersonal loyalty object (AC9 — no PII crosses the boundary)', () => {
  const object = buildLoyaltyObject({
    issuerId: ISSUER_ID,
    classSuffix: CLASS_SUFFIX,
    serialNumber: SERIAL,
    alias: ALIAS,
    balance: 240,
  });

  it('is exactly the §8.2 shape', () => {
    expect(object).toEqual({
      id: `${ISSUER_ID}.${SERIAL}`,
      classId: `${ISSUER_ID}.${CLASS_SUFFIX}`,
      state: 'ACTIVE',
      loyaltyPoints: { label: 'Points', balance: { int: 240 } },
      barcode: {
        type: 'QR_CODE',
        value: `${WALLET_BARCODE_PREFIX}${ALIAS}`,
        alternateText: ALIAS.slice(-4),
      },
    });
  });

  it('has no key outside the allowlist, at any depth', () => {
    expect([...deepKeys(object)].sort()).toEqual([...LOYALTY_OBJECT_KEY_ALLOWLIST].sort());
  });

  it('omits accountId and accountName, which would render a person on the pass face', () => {
    const keys = deepKeys(object);
    for (const forbidden of [
      'accountId',
      'accountName',
      'email',
      'phone',
      'customerId',
      'organizationId',
      'branchId',
      'displayName',
      'givenName',
      'familyName',
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it('fails closed when a caller bolts an extra field onto the object', () => {
    // The realistic regression: someone adds `accountName` "so support can find
    // the customer". The allowlist has to catch it before it is signed.
    expect(() => assertLoyaltyObjectKeysAllowed({ ...object, accountName: 'Ayesha Khan' })).toThrow(
      /accountName/
    );
  });

  it('rejects a balance that is negative, fractional or out of int range', () => {
    const base = {
      issuerId: ISSUER_ID,
      classSuffix: CLASS_SUFFIX,
      serialNumber: SERIAL,
      alias: ALIAS,
    };
    for (const balance of [-1, 1.5, 2_147_483_648, Number.NaN]) {
      expect(() => buildLoyaltyObject({ ...base, balance })).toThrow(/non-negative 32-bit integer/);
    }
  });
});

describe('barcode envelope and alias handling (§5.2, §5.3, A2, A3)', () => {
  it('wraps the alias in the versioned DFW1 envelope', () => {
    expect(walletBarcodeValue(ALIAS)).toBe(`DFW1:${ALIAS}`);
  });

  it('rejects an enrollment URL, a bare alias-shaped string and Crockford-excluded letters', () => {
    for (const bad of [
      'https://chai.devfathom.test/wallet/join/wel_3g7v9k2m5q8r1t4w6y0zb3d5f7',
      'wel_3g7v9k2m5q8r1t4w6y0zb3d5f7',
      'wla_3g7v9k2m5q8r1t4w6y0zb3d5f', // 25 chars
      'wla_3G7V9K2M5Q8R1T4W6Y0ZB3D5F7', // uppercase
      'wla_illlooouuu2m5q8r1t4w6y0zb3', // i / l / o / u are not Crockford
      `DFW1:${ALIAS}`, // already enveloped — double wrapping is a bug
    ]) {
      expect(() => walletBarcodeValue(bad)).toThrow(GoogleWalletError);
    }
  });

  it('never echoes the alias in an error message', () => {
    // A3: the alias must not reach a log or an error string. An error thrown
    // *about* a bad alias is the most likely place for it to leak.
    try {
      walletBarcodeValue('wla_BADBADBAD');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleWalletError);
      expect((error as Error).message).not.toContain('wla_BADBADBAD');
      expect((error as Error).message).toBe('Invalid wallet alias for Google Wallet issuance.');
    }
  });

  it('fingerprints an alias without being reversible to it', () => {
    const fingerprint = aliasFingerprint(ALIAS);
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint).not.toContain(ALIAS.slice(4));
    expect(aliasFingerprint(ALIAS)).toBe(fingerprint);
    expect(aliasFingerprint('wla_9k2m5q8r1t4w6y0zb3d5f73g7')).not.toBe(fingerprint);
  });
});

describe('save-link JWT (§8.3, AC9)', () => {
  const object = buildLoyaltyObject({
    issuerId: ISSUER_ID,
    classSuffix: CLASS_SUFFIX,
    serialNumber: SERIAL,
    alias: ALIAS,
    balance: 240,
  });
  const issuedAt = new Date('2026-08-28T12:00:00.000Z');
  const jwt = buildSaveToWalletJwt({ credentials: CREDENTIALS, loyaltyObject: object, issuedAt });
  const decoded = decodeJwt(jwt);

  it('is RS256 and verifies against the issuer public key', () => {
    expect(decoded.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(verifyRs256(decoded.signingInput, decoded.signature)).toBe(true);
  });

  it('does not verify once a claim is tampered with', () => {
    const forged = Buffer.from(
      JSON.stringify({ ...decoded.claims, iss: 'attacker@example.test' }),
      'utf8'
    ).toString('base64url');
    const [header] = jwt.split('.');
    expect(verifyRs256(`${header}.${forged}`, decoded.signature)).toBe(false);
  });

  it('carries exactly the allowlisted claims, and no more', () => {
    expect(Object.keys(decoded.claims).sort()).toEqual([...SAVE_JWT_CLAIM_ALLOWLIST].sort());
    expect(decoded.claims.iss).toBe(CREDENTIALS.clientEmail);
    expect(decoded.claims.aud).toBe('google');
    expect(decoded.claims.typ).toBe('savetowallet');
    expect(decoded.claims.iat).toBe(Math.floor(issuedAt.getTime() / 1000));
  });

  it('carries one loyalty object and nothing personal anywhere in the payload', () => {
    const payload = decoded.claims.payload as { loyaltyObjects: unknown[] };
    expect(payload.loyaltyObjects).toHaveLength(1);
    expect(payload.loyaltyObjects[0]).toEqual(object);

    const claimKeys = deepKeys(decoded.claims);
    for (const forbidden of [
      'accountId',
      'accountName',
      'email',
      'phone',
      'customerId',
      'origins',
    ]) {
      expect(claimKeys.has(forbidden)).toBe(false);
    }
  });

  it('is minted per request rather than cached, so `iat` tracks the clock', () => {
    const later = buildSaveToWalletJwt({
      credentials: CREDENTIALS,
      loyaltyObject: object,
      issuedAt: new Date(issuedAt.getTime() + 60_000),
    });
    expect(later).not.toBe(jwt);
    expect(decodeJwt(later).claims.iat).toBe(Math.floor(issuedAt.getTime() / 1000) + 60);
  });

  it('builds the Add to Google Wallet href from the signed JWT', () => {
    const url = buildSaveToWalletUrl({ credentials: CREDENTIALS, loyaltyObject: object, issuedAt });
    expect(url).toBe(`${GOOGLE_WALLET_SAVE_URL_BASE}/${jwt}`);
    expect(new URL(url).protocol).toBe('https:');
  });

  it('refuses to sign an object that has grown a disallowed field', () => {
    expect(() =>
      buildSaveToWalletJwt({
        credentials: CREDENTIALS,
        // Mutated after construction — the guard has to run at signing time too.
        loyaltyObject: { ...object, accountName: 'Ayesha Khan' } as typeof object,
        issuedAt,
      })
    ).toThrow(/accountName/);
  });

  it('reports an unusable private key as a credential fault, not a provider fault', () => {
    const error = captureThrow(() =>
      buildSaveToWalletJwt({
        credentials: {
          ...CREDENTIALS,
          privateKey: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----',
        },
        loyaltyObject: object,
        issuedAt,
      })
    );
    expectWalletError(error, { reason: 'INVALID_CREDENTIALS', retryable: false });
  });
});

describe('deterministic error classification', () => {
  it('maps every status the Wallet API can answer to a fixed verdict', () => {
    expect(classifyGoogleWalletStatus(400)).toEqual({ reason: 'INVALID_INPUT', retryable: false });
    expect(classifyGoogleWalletStatus(401)).toEqual({ reason: 'AUTH_FAILED', retryable: false });
    expect(classifyGoogleWalletStatus(403)).toEqual({ reason: 'FORBIDDEN', retryable: false });
    expect(classifyGoogleWalletStatus(404)).toEqual({ reason: 'NOT_FOUND', retryable: false });
    expect(classifyGoogleWalletStatus(408)).toEqual({
      reason: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    expect(classifyGoogleWalletStatus(409)).toEqual({ reason: 'ALREADY_EXISTS', retryable: false });
    expect(classifyGoogleWalletStatus(429)).toEqual({ reason: 'RATE_LIMITED', retryable: true });
    expect(classifyGoogleWalletStatus(500)).toEqual({
      reason: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    expect(classifyGoogleWalletStatus(503)).toEqual({
      reason: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    expect(classifyGoogleWalletStatus(302)).toEqual({
      reason: 'PROVIDER_FAILED',
      retryable: false,
    });
  });

  it('is total — every 4xx/5xx status yields a defined verdict', () => {
    for (let status = 400; status < 600; status += 1) {
      const verdict = classifyGoogleWalletStatus(status);
      expect(typeof verdict.reason).toBe('string');
      expect(typeof verdict.retryable).toBe('boolean');
    }
  });
});

describe('OAuth2 access tokens (§8.4)', () => {
  it('exchanges a signed JWT-bearer assertion for an access token', async () => {
    const { api, calls } = client([TOKEN_RESPONSE()]);
    await expect(api.getAccessToken()).resolves.toBe('ya29.test-access-token');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CREDENTIALS.tokenUri);
    const body = new URLSearchParams(calls[0].init.body as string);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    const assertion = decodeJwt(body.get('assertion')!);
    expect(assertion.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(verifyRs256(assertion.signingInput, assertion.signature)).toBe(true);
    expect(assertion.claims.iss).toBe(CREDENTIALS.clientEmail);
    expect(assertion.claims.aud).toBe(CREDENTIALS.tokenUri);
    expect(assertion.claims.scope).toBe('https://www.googleapis.com/auth/wallet_object.issuer');
    expect(assertion.claims.exp).toBe((assertion.claims.iat as number) + 3600);
  });

  it('reuses a live token and re-mints one that is inside the expiry skew', async () => {
    const start = Date.UTC(2026, 7, 28, 12, 0, 0);
    let nowMs = start;
    const { transport, calls } = mockTransport([
      json({ access_token: 'first', expires_in: 3600 }),
      json({ access_token: 'second', expires_in: 3600 }),
      json({ ok: true }),
    ]);
    const api = createGoogleWalletClient({
      credentials: CREDENTIALS,
      transport,
      now: () => new Date(nowMs),
    });

    await expect(api.getAccessToken()).resolves.toBe('first');
    nowMs = start + 30 * 60_000;
    await expect(api.getAccessToken()).resolves.toBe('first');
    // 59m30s in: inside the 60s refresh skew, so a new token is minted.
    nowMs = start + 3_570_000;
    await expect(api.getAccessToken()).resolves.toBe('second');
    expect(calls).toHaveLength(2);

    // The freshly minted token is the one attached to the next API call.
    await api.patchLoyaltyObjectBalance({ serialNumber: SERIAL, balance: 10 });
    expect((calls[2].init.headers as Record<string, string>).Authorization).toBe('Bearer second');
  });

  it('calls a token-endpoint 400 an auth fault, not bad input', async () => {
    const { api } = client([json({ error: { message: 'invalid_grant' } }, 400)]);
    expectWalletError(await captureRejection(api.getAccessToken()), {
      reason: 'AUTH_FAILED',
      retryable: false,
      status: 400,
    });
  });

  it('treats a token-endpoint 503 as retryable', async () => {
    const { api } = client([json({ error: { message: 'backend error' } }, 503)]);
    expectWalletError(await captureRejection(api.getAccessToken()), {
      reason: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('rejects a 200 that carries no access token', async () => {
    const { api } = client([json({ expires_in: 3600 })]);
    expectWalletError(await captureRejection(api.getAccessToken()), {
      reason: 'AUTH_FAILED',
      retryable: false,
    });
  });
});

describe('class issuance (§8.1)', () => {
  it('reuses an existing class without writing to it', async () => {
    const { api, calls } = client([TOKEN_RESPONSE(), json({ id: `${ISSUER_ID}.${CLASS_SUFFIX}` })]);
    await expect(
      api.ensureLoyaltyClass({ classSuffix: CLASS_SUFFIX, brand: BRAND })
    ).resolves.toEqual({ id: `${ISSUER_ID}.${CLASS_SUFFIX}`, created: false });
    expect(calls).toHaveLength(2);
    expect(calls[1].init.method).toBe('GET');
    expect(calls[1].url).toContain(`/loyaltyClass/${ISSUER_ID}.${CLASS_SUFFIX}`);
  });

  it('creates the class lazily on first issuance, with the tenant branding', async () => {
    const { api, calls } = client([
      TOKEN_RESPONSE(),
      json({ error: { message: 'not found' } }, 404),
      json({ id: `${ISSUER_ID}.${CLASS_SUFFIX}` }),
    ]);
    await expect(
      api.ensureLoyaltyClass({ classSuffix: CLASS_SUFFIX, brand: BRAND })
    ).resolves.toEqual({ id: `${ISSUER_ID}.${CLASS_SUFFIX}`, created: true });

    expect(calls[2].init.method).toBe('POST');
    expect(calls[2].url).toContain('/loyaltyClass');
    expect(JSON.parse(calls[2].init.body as string)).toEqual(
      buildLoyaltyClass({ issuerId: ISSUER_ID, classSuffix: CLASS_SUFFIX, brand: BRAND })
    );
    expect((calls[2].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ya29.test-access-token'
    );
  });

  it('treats a concurrent creation (409) as success, not a failure', async () => {
    const { api } = client([
      TOKEN_RESPONSE(),
      json({ error: { message: 'not found' } }, 404),
      json({ error: { message: 'already exists' } }, 409),
    ]);
    await expect(
      api.ensureLoyaltyClass({ classSuffix: CLASS_SUFFIX, brand: BRAND })
    ).resolves.toEqual({ id: `${ISSUER_ID}.${CLASS_SUFFIX}`, created: false });
  });

  it('surfaces a 500 on the read as retryable rather than trying to create', async () => {
    const { api, calls } = client([TOKEN_RESPONSE(), json({ error: { message: 'boom' } }, 500)]);
    expectWalletError(
      await captureRejection(api.ensureLoyaltyClass({ classSuffix: CLASS_SUFFIX, brand: BRAND })),
      { reason: 'PROVIDER_UNAVAILABLE', retryable: true, status: 500 }
    );
    expect(calls).toHaveLength(2);
  });
});

describe('object issuance (§8.2)', () => {
  it('posts the impersonal object and reports it created', async () => {
    const { api, calls } = client([TOKEN_RESPONSE(), json({ id: `${ISSUER_ID}.${SERIAL}` })]);
    await expect(
      api.ensureLoyaltyObject({
        classSuffix: CLASS_SUFFIX,
        serialNumber: SERIAL,
        alias: ALIAS,
        balance: 240,
      })
    ).resolves.toEqual({ id: `${ISSUER_ID}.${SERIAL}`, created: true });

    const sent = JSON.parse(calls[1].init.body as string) as unknown;
    expect([...deepKeys(sent)].sort()).toEqual([...LOYALTY_OBJECT_KEY_ALLOWLIST].sort());
    expect((sent as { barcode: { value: string } }).barcode.value).toBe(`DFW1:${ALIAS}`);
  });

  it('is idempotent when the pass already exists at Google', async () => {
    const { api } = client([TOKEN_RESPONSE(), json({ error: { message: 'exists' } }, 409)]);
    await expect(
      api.ensureLoyaltyObject({
        classSuffix: CLASS_SUFFIX,
        serialNumber: SERIAL,
        alias: ALIAS,
        balance: 0,
      })
    ).resolves.toEqual({ id: `${ISSUER_ID}.${SERIAL}`, created: false });
  });

  it('validates before authenticating, so a bad alias never costs a token call', async () => {
    const { api, calls } = client([]);
    expectWalletError(
      await captureRejection(
        api.ensureLoyaltyObject({
          classSuffix: CLASS_SUFFIX,
          serialNumber: SERIAL,
          alias: 'not-an-alias',
          balance: 0,
        })
      ),
      { reason: 'INVALID_INPUT', retryable: false }
    );
    expect(calls).toHaveLength(0);
  });
});

describe('balance push and revocation (§8.4, §8.5)', () => {
  it('patches only the balance', async () => {
    const { api, calls } = client([TOKEN_RESPONSE(), json({ id: `${ISSUER_ID}.${SERIAL}` })]);
    await api.patchLoyaltyObjectBalance({ serialNumber: SERIAL, balance: 315 });

    expect(calls[1].init.method).toBe('PATCH');
    expect(calls[1].url).toBe(
      `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${ISSUER_ID}.${SERIAL}`
    );
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      loyaltyPoints: { balance: { int: 315 } },
    });
  });

  it('rejects a bad balance before the network, so the outbox fails terminally', async () => {
    const { api, calls } = client([]);
    expectWalletError(
      await captureRejection(api.patchLoyaltyObjectBalance({ serialNumber: SERIAL, balance: -5 })),
      { reason: 'INVALID_INPUT', retryable: false }
    );
    expect(calls).toHaveLength(0);
  });

  it('expires the object on revocation', async () => {
    const { api, calls } = client([TOKEN_RESPONSE(), json({ id: `${ISSUER_ID}.${SERIAL}` })]);
    await api.expireLoyaltyObject({ serialNumber: SERIAL });
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ state: 'EXPIRED' });
  });

  it('treats revoking an object Google no longer has as success', async () => {
    const { api } = client([TOKEN_RESPONSE(), json({ error: { message: 'gone' } }, 404)]);
    await expect(api.expireLoyaltyObject({ serialNumber: SERIAL })).resolves.toBeUndefined();
  });

  it('turns a rate limit into a retryable failure carrying the status', async () => {
    const { api } = client([TOKEN_RESPONSE(), json({ error: { message: 'quota' } }, 429)]);
    expectWalletError(
      await captureRejection(api.patchLoyaltyObjectBalance({ serialNumber: SERIAL, balance: 1 })),
      { reason: 'RATE_LIMITED', retryable: true, status: 429 }
    );
  });

  it('turns a transport fault into a retryable failure', async () => {
    const { api } = client([TOKEN_RESPONSE(), new Error('socket hang up')]);
    expectWalletError(
      await captureRejection(api.patchLoyaltyObjectBalance({ serialNumber: SERIAL, balance: 1 })),
      { reason: 'PROVIDER_UNAVAILABLE', retryable: true, status: null }
    );
  });

  it('never puts the alias into a failure message reaching the outbox', async () => {
    const { api } = client([
      TOKEN_RESPONSE(),
      json({ error: { message: 'quota exceeded for issuer' } }, 429),
    ]);
    const error = expectWalletError(
      await captureRejection(
        api.ensureLoyaltyObject({
          classSuffix: CLASS_SUFFIX,
          serialNumber: SERIAL,
          alias: ALIAS,
          balance: 5,
        })
      ),
      { reason: 'RATE_LIMITED', retryable: true }
    );
    expect(error.message).not.toContain(ALIAS);
    expect(error.message).not.toContain(ALIAS.slice(4));
  });
});

describe('request hygiene', () => {
  it('bounds every call with a timeout signal', async () => {
    const { api, calls } = client([TOKEN_RESPONSE(), json({ ok: true })]);
    await api.patchLoyaltyObjectBalance({ serialNumber: SERIAL, balance: 1 });
    for (const call of calls) {
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('defaults to the real Wallet API host when no base is injected', () => {
    const transport = vi.fn();
    const api = createGoogleWalletClient({ credentials: CREDENTIALS, transport });
    expect(api).toBeDefined();
    expect(transport).not.toHaveBeenCalled();
  });
});
