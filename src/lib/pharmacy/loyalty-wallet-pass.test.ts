import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { normalizeLoyaltyCardCode } from './loyalty-card-code';
import {
  buildPharmacyWalletTestPasses,
  issuePharmacyWalletTestPasses,
  mintPharmacyWalletSerial,
  PHARMACY_WALLET_TEST_ISSUER,
} from './loyalty-wallet-pass';

const CODE = 'DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SERIAL = `plw_${'ab'.repeat(16)}`;
const base = { code: CODE, serialNumber: SERIAL, balancePoints: 1250, pointValueMinor: 100 };

/** Every key path at any depth, so a field added later cannot slip past the allowlist. */
function keys(value: unknown): string[] {
  const walk = (node: unknown, prefix: string): string[] => {
    if (Array.isArray(node)) return node.flatMap((item) => walk(item, `${prefix}[]`));
    if (node && typeof node === 'object')
      return Object.entries(node).flatMap(([key, child]) => [
        `${prefix}${key}`,
        ...walk(child, `${prefix}${key}.`),
      ]);
    return [];
  };
  return [...new Set(walk(value, ''))];
}

describe('DEV-747 pharmacy wallet test passes', () => {
  it('carries the physical card code in both QRs, so the counter scan resolves the same customer', () => {
    const passes = buildPharmacyWalletTestPasses(base);
    expect(passes.apple.barcodes).toEqual([
      {
        format: 'PKBarcodeFormatQR',
        message: CODE,
        messageEncoding: 'iso-8859-1',
        altText: 'DFLC ABCD EFGH IJKL MNOP QRST UVWX YZ',
      },
    ]);
    expect(passes.google.barcode).toEqual({
      type: 'QR_CODE',
      value: CODE,
      alternateText: 'DFLC ABCD EFGH IJKL MNOP QRST UVWX YZ',
    });
    expect(normalizeLoyaltyCardCode(passes.apple.barcodes[0]!.message)).toBe(CODE);
    expect(normalizeLoyaltyCardCode(passes.google.barcode.value)).toBe(CODE);
  });

  it('shows the ledger balance and the owner’s point value on both passes', () => {
    const passes = buildPharmacyWalletTestPasses({ ...base, pointValueMinor: 250 });
    expect(passes.balancePoints).toBe(1250);
    expect(passes.apple.storeCard.primaryFields).toEqual([
      { key: 'balance', label: 'Points', value: 1250 },
    ]);
    expect(passes.apple.storeCard.secondaryFields[0]!.value).toBe('1 point = PKR 2.50');
    expect(passes.google.loyaltyPoints).toEqual({ label: 'Points', balance: { int: 1250 } });
    expect(passes.google.textModulesData[0]!.body).toBe('1 point = PKR 2.50');
    expect(buildPharmacyWalletTestPasses(base).apple.storeCard.secondaryFields[0]!.value).toBe(
      '1 point = PKR 1'
    );
  });

  it('is a test pass only: placeholder issuer, no signature, web service or update token', () => {
    const passes = buildPharmacyWalletTestPasses(base);
    expect(passes.mode).toBe('TEST');
    expect(passes.apple.passTypeIdentifier).toBe(
      PHARMACY_WALLET_TEST_ISSUER.applePassTypeIdentifier
    );
    expect(passes.apple.passTypeIdentifier).toMatch(/^pass\.test\./);
    expect(passes.apple.storeCard.headerFields).toEqual([
      { key: 'mode', label: 'Pass', value: 'TEST' },
    ]);
    expect(passes.google.id).toBe(`test-issuer.${SERIAL}`);
    expect(passes.google.classId).toMatch(/^test-issuer\./);
    const all = keys(passes);
    for (const forbidden of ['authenticationToken', 'webServiceURL', 'signature', 'manifest'])
      expect(all.some((key) => key.endsWith(forbidden))).toBe(false);
  });

  it('puts nothing about the customer on either pass', () => {
    const passes = buildPharmacyWalletTestPasses(base);
    expect(keys(passes.apple).sort()).toEqual(
      [
        'formatVersion',
        'passTypeIdentifier',
        'teamIdentifier',
        'serialNumber',
        'organizationName',
        'description',
        'logoText',
        'storeCard',
        ...['headerFields', 'primaryFields', 'secondaryFields', 'backFields'].flatMap((field) => [
          `storeCard.${field}`,
          `storeCard.${field}.[]key`,
          `storeCard.${field}.[]label`,
          `storeCard.${field}.[]value`,
        ]),
        'barcodes',
        'barcodes.[]format',
        'barcodes.[]message',
        'barcodes.[]messageEncoding',
        'barcodes.[]altText',
      ].sort()
    );
    expect(keys(passes.google).sort()).toEqual(
      [
        'id',
        'classId',
        'state',
        'loyaltyPoints',
        'loyaltyPoints.label',
        'loyaltyPoints.balance',
        'loyaltyPoints.balance.int',
        'barcode',
        'barcode.type',
        'barcode.value',
        'barcode.alternateText',
        'textModulesData',
        'textModulesData.[]id',
        'textModulesData.[]header',
        'textModulesData.[]body',
      ].sort()
    );
    // Google renders these on the pass face; an impersonal pass never sets them.
    expect(keys(passes.google)).not.toContain('accountName');
    expect(keys(passes.google)).not.toContain('accountId');
  });

  it('refuses anything that is not a card code, a random serial, a whole balance or a point value', () => {
    expect(() => buildPharmacyWalletTestPasses({ ...base, code: 'Ayesha 0300' })).toThrow();
    expect(() =>
      buildPharmacyWalletTestPasses({ ...base, code: 'dflc abcd efgh ijkl mnop qrst uvwx yz' })
    ).toThrow();
    expect(() => buildPharmacyWalletTestPasses({ ...base, serialNumber: 'customer-1' })).toThrow();
    expect(() => buildPharmacyWalletTestPasses({ ...base, balancePoints: 1.5 })).toThrow();
    expect(() => buildPharmacyWalletTestPasses({ ...base, pointValueMinor: 0 })).toThrow();
  });

  it('mints a random serial that names no customer or record', () => {
    expect(mintPharmacyWalletSerial(() => Buffer.alloc(16, 0xab))).toBe(SERIAL);
    expect(mintPharmacyWalletSerial()).toMatch(/^plw_[0-9a-f]{32}$/);
    expect(mintPharmacyWalletSerial()).not.toBe(mintPharmacyWalletSerial());
  });

  it('reads the organization-wide balance and the current point value when issuing', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { points: 420 } });
    const findFirst = vi.fn().mockResolvedValue({ redemptionValueMinor: 300 });
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ branchId: null }]),
      pharmacyLoyaltyPointsEntry: { aggregate },
      pharmacyLoyaltyProgramVersion: { findFirst },
    };
    const passes = await issuePharmacyWalletTestPasses(db as never, 'org-a', {
      customerId: 'customer-a',
      code: CODE,
    });
    // No branch filter: points earned at any branch count.
    expect(aggregate).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', customerId: 'customer-a' },
      _sum: { points: true },
    });
    expect(passes).toMatchObject({ balancePoints: 420, pointValueMinor: 300 });
    expect(passes.apple.serialNumber).toMatch(/^plw_[0-9a-f]{32}$/);
    expect(passes.google.id).toBe(`test-issuer.${passes.apple.serialNumber}`);

    findFirst.mockResolvedValue(null);
    aggregate.mockResolvedValue({ _sum: { points: null } });
    await expect(
      issuePharmacyWalletTestPasses(db as never, 'org-a', { customerId: 'customer-a', code: CODE })
    ).resolves.toMatchObject({ balancePoints: 0, pointValueMinor: 100 });
  });
});
