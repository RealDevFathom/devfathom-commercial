import { describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { calculateTaxAmount, TaxConfigurationError } from '@/lib/tax/calculator';
import {
  computeRoomNightTax,
  HOTEL_TAX_PROVINCES,
  validateHotelTaxProfile,
  type HotelTaxProfileInput,
} from './tax';

// Synthetic configuration, not provincial tax guidance.
const profile = (overrides: Partial<HotelTaxProfileInput> = {}): HotelTaxProfileInput => ({
  productClass: 'HOTEL',
  province: 'PUNJAB',
  roomServicesTaxBps: 1250,
  priceMode: 'EXCLUSIVE',
  levies: [],
  ...overrides,
});

describe('hotel tax configuration', () => {
  it.each(['PUNJAB', 'SINDH', 'KP', 'BALOCHISTAN', 'ICT', 'GB', 'AJK'] as const)(
    'uses configured rates, not province defaults, for %s',
    (province) => {
      expect(HOTEL_TAX_PROVINCES).toContain(province);
      for (const roomServicesTaxBps of [0, 1250, 2375]) {
        const result = computeRoomNightTax(profile({ province, roomServicesTaxBps }), 10_000);
        expect(result.servicesTaxMinor).toBe(roomServicesTaxBps);
        expect(result.grossMinor).toBe(10_000 + roomServicesTaxBps);
      }
    }
  );

  it('accepts an incomplete draft without supplying province, rate, price mode or levies', () => {
    expect(validateHotelTaxProfile({ productClass: 'HOTEL' })).toEqual({
      productClass: 'HOTEL',
      eInvoiceEnabled: false,
      submissionMode: 'SIMULATED',
    });
  });

  it('preserves explicit nulls under the H-D05 assumption', () => {
    const draft = {
      productClass: 'HOTEL',
      province: null,
      roomServicesTaxBps: null,
      priceMode: null,
      levies: null,
      ntn: null,
      strn: null,
      eInvoiceEnabled: null,
      integrationId: null,
      submissionMode: null,
    };
    expect(validateHotelTaxProfile(draft)).toEqual(draft);
  });

  it('accepts a configuration projection on an existing platform profile/rule shape', () => {
    const configured = {
      ...profile(),
      id: 'synthetic-profile-version',
      status: 'PUBLISHED',
      effectiveFrom: new Date('2030-01-01'),
      approvalReference: 'SYNTHETIC',
      approvedAt: new Date('2029-12-01'),
      ntn: ' SYNTHETIC-NTN ',
      strn: 'SYNTHETIC-STRN',
      eInvoiceEnabled: true,
      integrationId: 'synthetic-integration',
      submissionMode: 'REAL' as const,
    };
    expect(validateHotelTaxProfile(configured)).toMatchObject({
      productClass: 'HOTEL',
      ntn: 'SYNTHETIC-NTN',
      strn: 'SYNTHETIC-STRN',
      eInvoiceEnabled: true,
      integrationId: 'synthetic-integration',
      submissionMode: 'REAL',
    });
    expect(computeRoomNightTax(configured, 800).servicesTaxMinor).toBe(100);
  });

  it.each(['province', 'roomServicesTaxBps', 'priceMode', 'levies'] as const)(
    'refuses calculation when %s is null or missing, including zero-value room nights',
    (field) => {
      for (const value of [null, undefined]) {
        for (const amountMinor of [0, 10_000]) {
          expect(() => computeRoomNightTax(profile({ [field]: value }), amountMinor)).toThrow(
            TaxConfigurationError
          );
        }
      }
    }
  );

  it.each(
    [
      null,
      undefined,
      [],
      {},
      { productClass: 'RESTAURANT' },
      { productClass: 'PHARMACY' },
      { province: 'UNKNOWN' },
      { province: 'punjab' },
      { priceMode: 'UNKNOWN' },
      { eInvoiceEnabled: 'false' },
      { submissionMode: 'LIVE' },
      { ntn: '' },
      { strn: 123 },
      { integrationId: ' ' },
    ].map((invalid) => ({ invalid }))
  )('rejects malformed profile input $invalid', ({ invalid }) => {
    const input =
      invalid && !Array.isArray(invalid) && Object.keys(invalid).length
        ? { ...profile(), ...invalid }
        : invalid;
    expect(() => validateHotelTaxProfile(input)).toThrow();
  });

  it.each([-1, 0.5, 10_001, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, '1250'])(
    'rejects invalid basis points %s',
    (roomServicesTaxBps) => {
      expect(() => validateHotelTaxProfile({ ...profile(), roomServicesTaxBps })).toThrow();
    }
  );

  it.each(
    [
      {},
      [null],
      [{}],
      [{ code: ' ', amountMinor: 1 }],
      [{ code: 'BED_TAX', amountMinor: null }],
      [{ code: 'BED_TAX', amountMinor: '1' }],
      [{ code: 'BED_TAX', amountMinor: -1 }],
      [{ code: 'BED_TAX', amountMinor: 0.5 }],
      [{ code: 'BED_TAX', amountMinor: NaN }],
      [{ code: 'BED_TAX', amountMinor: Infinity }],
      [{ code: 'BED_TAX', amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
      [
        { code: 'BED_TAX', amountMinor: 1 },
        { code: ' BED_TAX ', amountMinor: 2 },
      ],
    ].map((levies) => ({ levies }))
  )('rejects invalid or duplicate levy configuration $levies', ({ levies }) => {
    expect(() => validateHotelTaxProfile({ ...profile(), levies })).toThrow();
  });
});

describe('room-night tax arithmetic', () => {
  it.each([
    ['EXCLUSIVE', 49, 100, 49, 0, 49],
    ['EXCLUSIVE', 50, 100, 50, 1, 51],
    ['EXCLUSIVE', 51, 100, 51, 1, 52],
    ['EXCLUSIVE', 1, 5000, 1, 1, 2],
    ['EXCLUSIVE', 1, 10_000, 1, 1, 2],
    ['INCLUSIVE', 1, 10_000, 1, 0, 1],
    ['INCLUSIVE', 3, 10_000, 2, 1, 3],
    ['INCLUSIVE', 11_600, 1600, 10_000, 1600, 11_600],
    ['EXCLUSIVE', 0, 1250, 0, 0, 0],
    ['INCLUSIVE', 0, 1250, 0, 0, 0],
    ['EXCLUSIVE', 123, 0, 123, 0, 123],
    ['INCLUSIVE', 123, 0, 123, 0, 123],
  ] as const)(
    '%s amount=%i bps=%i preserves platform rounding',
    (priceMode, amountMinor, roomServicesTaxBps, netMinor, servicesTaxMinor, grossMinor) => {
      const result = computeRoomNightTax(profile({ priceMode, roomServicesTaxBps }), amountMinor);
      expect(result).toEqual({
        netMinor,
        servicesTaxMinor,
        levies: [],
        levyTotalMinor: 0,
        taxMinor: servicesTaxMinor,
        grossMinor,
      });
      const platform = calculateTaxAmount({
        consideration: new Prisma.Decimal(String(amountMinor)).div(100),
        rate: new Prisma.Decimal(String(roomServicesTaxBps)).div(10_000),
        priceMode,
      });
      expect(String(netMinor)).toBe(platform.net.times(100).toFixed(0));
      expect(String(servicesTaxMinor)).toBe(platform.tax.times(100).toFixed(0));
      expect(String(grossMinor)).toBe(platform.gross.times(100).toFixed(0));
    }
  );

  it.each(['EXCLUSIVE', 'INCLUSIVE'] as const)(
    'adds explicit levy lines separately in %s mode without mutating inputs',
    (priceMode) => {
      const configured = profile({
        priceMode,
        roomServicesTaxBps: 2500,
        levies: [
          { code: 'BED_TAX', amountMinor: 123 },
          { code: 'OTHER', amountMinor: 7 },
        ],
      });
      Object.freeze(configured.levies![0]);
      Object.freeze(configured.levies![1]);
      Object.freeze(configured.levies);
      Object.freeze(configured);
      const result = computeRoomNightTax(configured, 1000);
      expect(result).toEqual({
        netMinor: priceMode === 'EXCLUSIVE' ? 1000 : 800,
        servicesTaxMinor: priceMode === 'EXCLUSIVE' ? 250 : 200,
        levies: [
          { code: 'BED_TAX', amountMinor: 123 },
          { code: 'OTHER', amountMinor: 7 },
        ],
        levyTotalMinor: 130,
        taxMinor: priceMode === 'EXCLUSIVE' ? 380 : 330,
        grossMinor: priceMode === 'EXCLUSIVE' ? 1380 : 1130,
      });
      expect(result.levies).not.toBe(configured.levies);
    }
  );

  it.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, '100', null, undefined])(
    'rejects invalid room amount %s before arithmetic',
    (amount) => {
      expect(() => computeRoomNightTax(profile(), amount as number)).toThrow();
    }
  );

  it('preserves safe integer boundaries without a floating-point multiplication', () => {
    expect(
      computeRoomNightTax(profile({ roomServicesTaxBps: 0 }), Number.MAX_SAFE_INTEGER)
    ).toMatchObject({
      netMinor: Number.MAX_SAFE_INTEGER,
      taxMinor: 0,
      grossMinor: Number.MAX_SAFE_INTEGER,
    });
    expect(
      computeRoomNightTax(profile({ roomServicesTaxBps: 9999 }), 4_000_000_000_000_001)
    ).toMatchObject({ servicesTaxMinor: 3_999_600_000_000_001, grossMinor: 7_999_600_000_000_002 });
    expect(
      computeRoomNightTax(
        profile({ priceMode: 'INCLUSIVE', roomServicesTaxBps: 10_000 }),
        Number.MAX_SAFE_INTEGER
      )
    ).toMatchObject({
      netMinor: 4_503_599_627_370_496,
      taxMinor: 4_503_599_627_370_495,
      grossMinor: Number.MAX_SAFE_INTEGER,
    });
  });

  it('accepts the maximum safe levy when room and services tax are zero', () => {
    expect(
      computeRoomNightTax(
        profile({
          roomServicesTaxBps: 0,
          levies: [{ code: 'BED_TAX', amountMinor: Number.MAX_SAFE_INTEGER }],
        }),
        0
      )
    ).toMatchObject({
      levyTotalMinor: Number.MAX_SAFE_INTEGER,
      taxMinor: Number.MAX_SAFE_INTEGER,
      grossMinor: Number.MAX_SAFE_INTEGER,
    });
  });

  it('rejects overflow from services tax, levy aggregation and final gross', () => {
    expect(() =>
      computeRoomNightTax(profile({ roomServicesTaxBps: 1 }), Number.MAX_SAFE_INTEGER)
    ).toThrow(RangeError);
    expect(() =>
      computeRoomNightTax(
        profile({
          roomServicesTaxBps: 0,
          levies: [
            { code: 'A', amountMinor: Number.MAX_SAFE_INTEGER },
            { code: 'B', amountMinor: 1 },
          ],
        }),
        0
      )
    ).toThrow(RangeError);
    expect(() =>
      computeRoomNightTax(
        profile({ roomServicesTaxBps: 0, levies: [{ code: 'BED_TAX', amountMinor: 1 }] }),
        Number.MAX_SAFE_INTEGER
      )
    ).toThrow(RangeError);
  });
});
