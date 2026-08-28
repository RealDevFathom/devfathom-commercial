/**
 * Wallet lane L3 (WHA-269) — the Google issuer config binding.
 *
 * The interesting failures here are not "does it parse JSON". They are: does a
 * missing issuer look different from a corrupt one (the outbox has to treat them
 * differently), does the sensitive envelope actually get decrypted, and does any
 * error message echo credential material.
 */
import { describe, expect, it } from 'vitest';

import {
  GOOGLE_WALLET_PROVISIONING_PREREQUISITE,
  GOOGLE_WALLET_SETTING_DECLARATIONS,
  GOOGLE_WALLET_SETTING_KEYS,
  GoogleWalletConfigError,
  describeGoogleWalletReadiness,
  parseServiceAccount,
  resolveGoogleWalletCredentials,
  type GoogleWalletSecretBinding,
  type PlatformSettingRecord,
} from './google-config';

const ISSUER_ID = '3388000000022345678';
const PRIVATE_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq-not-a-real-key\n-----END PRIVATE KEY-----\n';

const SERVICE_ACCOUNT = {
  type: 'service_account',
  client_email: 'wallet-issuer@devfathom.iam.gserviceaccount.com',
  // JSON-embedded PEMs arrive with literal backslash-n; that is the realistic input.
  private_key: PRIVATE_KEY_PEM.replace(/\n/g, '\\n'),
  token_uri: 'https://oauth2.googleapis.com/token',
};

/** A stand-in envelope so no test needs a real PLATFORM_ENCRYPTION_KEY. */
function fakeEnvelope(value: unknown): string {
  return `v1.fake.${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

function fakeDecrypt(envelope: string): string {
  const [version, , payload] = envelope.split('.');
  if (version !== 'v1' || !payload) throw new Error('bad envelope');
  return Buffer.from(payload, 'base64url').toString('utf8');
}

function binding(rows: Record<string, PlatformSettingRecord | null>): GoogleWalletSecretBinding {
  return {
    readSetting: async (key) => rows[key] ?? null,
    decrypt: fakeDecrypt,
    isEncryptionConfigured: () => true,
  };
}

function provisionedRows(overrides: Partial<Record<string, PlatformSettingRecord | null>> = {}) {
  return {
    [GOOGLE_WALLET_SETTING_KEYS.issuerId]: {
      key: GOOGLE_WALLET_SETTING_KEYS.issuerId,
      value: ISSUER_ID,
      sensitive: false,
    },
    [GOOGLE_WALLET_SETTING_KEYS.serviceAccount]: {
      key: GOOGLE_WALLET_SETTING_KEYS.serviceAccount,
      value: { encrypted: fakeEnvelope(SERVICE_ACCOUNT) },
      sensitive: true,
    },
    ...overrides,
  } as Record<string, PlatformSettingRecord | null>;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

describe('setting declarations (§14)', () => {
  it('declares the private-key-bearing setting as sensitive and the issuer id as public', () => {
    const byKey = new Map(GOOGLE_WALLET_SETTING_DECLARATIONS.map((d) => [d.key, d]));
    expect(byKey.get(GOOGLE_WALLET_SETTING_KEYS.serviceAccount)?.sensitive).toBe(true);
    expect(byKey.get(GOOGLE_WALLET_SETTING_KEYS.issuerId)?.sensitive).toBe(false);
  });

  it('introduces no per-tenant credential key', () => {
    // The hard constraint from the issue and §14: one platform issuer, full stop.
    for (const declaration of GOOGLE_WALLET_SETTING_DECLARATIONS) {
      expect(declaration.key.startsWith('wallet.google.')).toBe(true);
      expect(declaration.key).not.toMatch(/organization|tenant|org/i);
    }
  });
});

describe('service-account parsing', () => {
  it('accepts the document as an object or as a raw JSON string, and unescapes the PEM', () => {
    const fromObject = parseServiceAccount(SERVICE_ACCOUNT);
    const fromString = parseServiceAccount(JSON.stringify(SERVICE_ACCOUNT));
    expect(fromObject).toEqual(fromString);
    expect(fromObject.privateKey).toBe(PRIVATE_KEY_PEM);
    expect(fromObject.clientEmail).toBe(SERVICE_ACCOUNT.client_email);
  });

  it('defaults the token endpoint when the document omits it', () => {
    const withoutTokenUri: Record<string, unknown> = { ...SERVICE_ACCOUNT };
    delete withoutTokenUri.token_uri;
    expect(parseServiceAccount(withoutTokenUri).tokenUri).toBe(
      'https://oauth2.googleapis.com/token'
    );
  });

  it('rejects an OAuth client document pasted in place of a service account', () => {
    // The realistic ops mistake: the "OAuth 2.0 Client ID" JSON looks similar.
    const error = (() => {
      try {
        parseServiceAccount({
          type: 'authorized_user',
          client_email: 'a@b.test',
          private_key: 'x',
        });
      } catch (caught) {
        return caught;
      }
      throw new Error('expected a rejection');
    })();
    expect(error).toBeInstanceOf(GoogleWalletConfigError);
    expect((error as GoogleWalletConfigError).reason).toBe('INVALID_CREDENTIALS');
  });

  it('rejects a document with no private key, and one whose key is not a PEM', () => {
    expect(() => parseServiceAccount({ client_email: 'a@b.test' })).toThrow(
      /client_email or private_key/
    );
    expect(() => parseServiceAccount({ client_email: 'a@b.test', private_key: 'hunter2' })).toThrow(
      /not a PEM private key/
    );
  });

  it('rejects non-JSON and non-object input', () => {
    expect(() => parseServiceAccount('{not json')).toThrow(/not valid JSON/);
    expect(() => parseServiceAccount([SERVICE_ACCOUNT])).toThrow(/must be a JSON object/);
  });
});

describe('credential resolution', () => {
  it('decrypts the sensitive envelope and returns the platform issuer credential', async () => {
    await expect(resolveGoogleWalletCredentials(binding(provisionedRows()))).resolves.toEqual({
      issuerId: ISSUER_ID,
      clientEmail: SERVICE_ACCOUNT.client_email,
      privateKey: PRIVATE_KEY_PEM,
      tokenUri: SERVICE_ACCOUNT.token_uri,
    });
  });

  it('reports an unprovisioned issuer as NOT_CONFIGURED and names the prerequisite issue', async () => {
    const error = (await captureRejection(
      resolveGoogleWalletCredentials(binding({}))
    )) as GoogleWalletConfigError;
    expect(error.reason).toBe('NOT_CONFIGURED');
    expect(error.message).toContain(GOOGLE_WALLET_SETTING_KEYS.issuerId);
    expect(error.message).toContain(GOOGLE_WALLET_SETTING_KEYS.serviceAccount);
    expect(error.message).toContain(GOOGLE_WALLET_PROVISIONING_PREREQUISITE.issue);
  });

  it('distinguishes a half-provisioned issuer from a fully absent one', async () => {
    const rows = provisionedRows({ [GOOGLE_WALLET_SETTING_KEYS.serviceAccount]: null });
    const error = (await captureRejection(
      resolveGoogleWalletCredentials(binding(rows))
    )) as GoogleWalletConfigError;
    expect(error.reason).toBe('NOT_CONFIGURED');
    expect(error.message).toContain(GOOGLE_WALLET_SETTING_KEYS.serviceAccount);
    expect(error.message).not.toContain(GOOGLE_WALLET_SETTING_KEYS.issuerId);
  });

  it('calls a corrupt credential INVALID_CREDENTIALS, not NOT_CONFIGURED', async () => {
    // These have different remedies: one is "provision the issuer", the other is
    // "page someone, the stored key is wrong". The outbox must not conflate them.
    const rows = provisionedRows({
      [GOOGLE_WALLET_SETTING_KEYS.serviceAccount]: {
        key: GOOGLE_WALLET_SETTING_KEYS.serviceAccount,
        value: { encrypted: 'v2.wrong.format' },
        sensitive: true,
      },
    });
    const error = (await captureRejection(
      resolveGoogleWalletCredentials(binding(rows))
    )) as GoogleWalletConfigError;
    expect(error.reason).toBe('INVALID_CREDENTIALS');
  });

  it('never echoes ciphertext or key material in a failure message', async () => {
    const envelope = fakeEnvelope(SERVICE_ACCOUNT);
    const rows = provisionedRows({
      [GOOGLE_WALLET_SETTING_KEYS.serviceAccount]: {
        key: GOOGLE_WALLET_SETTING_KEYS.serviceAccount,
        value: { encrypted: envelope },
        sensitive: true,
      },
    });
    const hostileBinding: GoogleWalletSecretBinding = {
      readSetting: async (key) => rows[key] ?? null,
      decrypt: () => {
        throw new Error(`decrypt failed for ${envelope}`);
      },
      isEncryptionConfigured: () => true,
    };
    const error = (await captureRejection(
      resolveGoogleWalletCredentials(hostileBinding)
    )) as GoogleWalletConfigError;
    expect(error.message).not.toContain(envelope);
    expect(error.message).not.toContain(PRIVATE_KEY_PEM);
  });

  it('calls a missing encryption key a deployment fault, not a bad credential', async () => {
    const rows = provisionedRows();
    const error = (await captureRejection(
      resolveGoogleWalletCredentials({
        readSetting: async (key) => rows[key] ?? null,
        decrypt: fakeDecrypt,
        isEncryptionConfigured: () => false,
      })
    )) as GoogleWalletConfigError;
    expect(error.reason).toBe('NOT_CONFIGURED');
    expect(error.message).toContain('PLATFORM_ENCRYPTION_KEY');
  });

  it('rejects an issuer id that is not the numeric console id', async () => {
    for (const bad of ['issuer-abc', '../../evil', '123']) {
      const rows = provisionedRows({
        [GOOGLE_WALLET_SETTING_KEYS.issuerId]: {
          key: GOOGLE_WALLET_SETTING_KEYS.issuerId,
          value: bad,
          sensitive: false,
        },
      });
      const error = (await captureRejection(
        resolveGoogleWalletCredentials(binding(rows))
      )) as GoogleWalletConfigError;
      expect(error.reason).toBe('INVALID_CREDENTIALS');
    }
  });

  it('rejects a sensitive row that carries no envelope at all', async () => {
    const rows = provisionedRows({
      [GOOGLE_WALLET_SETTING_KEYS.serviceAccount]: {
        key: GOOGLE_WALLET_SETTING_KEYS.serviceAccount,
        value: { encrypted: null },
        sensitive: true,
      },
    });
    const error = (await captureRejection(
      resolveGoogleWalletCredentials(binding(rows))
    )) as GoogleWalletConfigError;
    expect(error.reason).toBe('INVALID_CREDENTIALS');
  });
});

describe('readiness reporting', () => {
  it('reports ready with no missing keys once the issuer is provisioned', async () => {
    const readiness = await describeGoogleWalletReadiness(binding(provisionedRows()));
    expect(readiness.ready).toBe(true);
    expect(readiness.missing).toEqual([]);
    expect(readiness.invalidReason).toBeNull();
  });

  it('names the exact missing keys and the blocking issue when it is not', async () => {
    const readiness = await describeGoogleWalletReadiness(binding({}));
    expect(readiness.ready).toBe(false);
    expect(readiness.invalidReason).toBe('NOT_CONFIGURED');
    expect(readiness.missing).toEqual([
      GOOGLE_WALLET_SETTING_KEYS.issuerId,
      GOOGLE_WALLET_SETTING_KEYS.serviceAccount,
    ]);
    expect(readiness.summary).toContain(GOOGLE_WALLET_PROVISIONING_PREREQUISITE.issue);
  });

  it('does not throw when the credential is corrupt — a probe must always answer', async () => {
    const rows = provisionedRows({
      [GOOGLE_WALLET_SETTING_KEYS.issuerId]: {
        key: GOOGLE_WALLET_SETTING_KEYS.issuerId,
        value: 'nope',
        sensitive: false,
      },
    });
    const readiness = await describeGoogleWalletReadiness(binding(rows));
    expect(readiness.ready).toBe(false);
    expect(readiness.invalidReason).toBe('INVALID_CREDENTIALS');
  });

  it('keeps credential material out of the printable summary', async () => {
    const readiness = await describeGoogleWalletReadiness(binding(provisionedRows()));
    expect(readiness.summary).not.toContain(PRIVATE_KEY_PEM);
    expect(readiness.summary).not.toContain(SERVICE_ACCOUNT.client_email);
  });
});
