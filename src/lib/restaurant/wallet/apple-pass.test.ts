import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildApplePassJson,
  hashAppleAuthenticationToken,
  mintAppleAuthenticationToken,
  signManifest,
} from './apple-pass';

const base = {
  credentials: { passTypeIdentifier: 'pass.com.devfathom.loyalty', teamIdentifier: 'DEVFATH0M1' },
  serialNumber: 'wps_00000000000000000000000000',
  authenticationToken: 'wpa_00000000000000000000000000',
  alias: 'wla_00000000000000000000000000',
  balance: 240,
  programDisplayName: 'Chai House Rewards',
  webServiceUrl: 'https://wallet.devfathom.com/api/wallet/apple',
};

function keys(value: unknown, result = new Set<string>()) {
  if (Array.isArray(value)) value.forEach((entry) => keys(entry, result));
  else if (value && typeof value === 'object')
    Object.entries(value).forEach(([key, nested]) => {
      result.add(key);
      keys(nested, result);
    });
  return result;
}

describe('Apple storeCard contract', () => {
  it('mints a hashed 128-bit opaque authentication token', () => {
    const first = mintAppleAuthenticationToken();
    const second = mintAppleAuthenticationToken();
    expect(first).toMatch(/^wpa_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(second).not.toBe(first);
    expect(hashAppleAuthenticationToken(first)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a detached CMS signature verifiable against the manifest', () => {
    const root = path.join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.cwd(),
      'apple-cms-test'
    );
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const key = path.join(root, 'key.pem');
    const signer = path.join(root, 'signer.pem');
    const wwdrKey = path.join(root, 'wwdr-key.pem');
    const wwdr = path.join(root, 'wwdr.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=Pass Signer',
        '-keyout',
        key,
        '-out',
        signer,
        '-days',
        '1',
      ],
      { stdio: 'ignore' }
    );
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=WWDR',
        '-keyout',
        wwdrKey,
        '-out',
        wwdr,
        '-days',
        '1',
      ],
      { stdio: 'ignore' }
    );
    const manifest = Buffer.from('{"pass.json":"abc"}');
    const signature = signManifest(manifest, {
      passCertificatePem: readFileSync(signer, 'utf8'),
      passPrivateKeyPem: readFileSync(key, 'utf8'),
      wwdrCertificatePem: readFileSync(wwdr, 'utf8'),
      passTypeIdentifier: base.credentials.passTypeIdentifier,
      teamIdentifier: base.credentials.teamIdentifier,
    });
    const manifestPath = path.join(root, 'manifest.json');
    const signaturePath = path.join(root, 'signature');
    writeFileSync(manifestPath, manifest);
    writeFileSync(signaturePath, signature);
    expect(() =>
      execFileSync(
        'openssl',
        [
          'smime',
          '-verify',
          '-inform',
          'DER',
          '-in',
          signaturePath,
          '-content',
          manifestPath,
          '-noverify',
          '-out',
          path.join(root, 'verified'),
        ],
        { stdio: 'ignore' }
      )
    ).not.toThrow();
    rmSync(root, { recursive: true, force: true });
  });
  it('contains the opaque barcode and balance without PII or primary keys', () => {
    const pass = buildApplePassJson(base);
    expect(pass.storeCard.primaryFields).toEqual([{ key: 'balance', label: 'Points', value: 240 }]);
    expect(pass.barcodes).toEqual([
      {
        format: 'PKBarcodeFormatQR',
        message: `DFW1:${base.alias}`,
        messageEncoding: 'iso-8859-1',
        altText: '0000',
      },
    ]);
    const allKeys = keys(pass);
    for (const forbidden of [
      'customerId',
      'organizationId',
      'branchId',
      'email',
      'phone',
      'displayName',
      'givenName',
      'familyName',
    ])
      expect(allKeys.has(forbidden)).toBe(false);
  });

  it('does not echo bearer-shaped values in validation errors', () => {
    for (const field of ['alias', 'serialNumber', 'authenticationToken'] as const) {
      const secret = `${field}_sensitive_payload`;
      expect(() => buildApplePassJson({ ...base, [field]: secret })).toThrow();
      try {
        buildApplePassJson({ ...base, [field]: secret });
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
  });

  it('rejects negative balance and insecure production web service URLs', () => {
    expect(() => buildApplePassJson({ ...base, balance: -1 })).toThrow(
      'Invalid Apple Wallet balance'
    );
    expect(() =>
      buildApplePassJson({ ...base, webServiceUrl: 'http://wallet.devfathom.com' })
    ).toThrow('must use HTTPS');
  });
});
