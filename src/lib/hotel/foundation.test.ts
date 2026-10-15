import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import * as catalog from '@/lib/vertical-catalog';
import { MODULE_CATALOG } from '@/lib/module-catalog';
import { POLICIES, type Action } from '@/lib/abac/policies';
import { syncPlatformCatalog } from '../../../prisma/catalog-sync';
import {
  defaultBookingEngineSlug,
  bookingEngineSlug,
  hotelPropertyUpdateInput,
  isValidHotelTimezone,
} from './property';
import {
  evaluateHotelReadiness,
  evaluateHotelOnboarding,
  hotelEvidence,
} from './onboarding-checklist';

const priorCatalogDigests = {
  AGENCY: '54e0ca2cb112bd14c7bde79c1aba7ceeb7875fc51c5a0e5dd05c0db326440769',
  RESTAURANT: '8a4ca4af40ecbb1ab00e9211b2d6c234853e27956847561e5f24802c6e704eb9',
  PHARMACY: 'c0cd87fc9f91dcbe2d62350ce63bf4384a4c1d5c07a8d42a68220700744eddbe',
};

const property = {
  mode: 'HOTEL',
  name: 'Example Hotel',
  addressLine: 'Synthetic street',
  city: 'Lahore',
  timezone: 'Asia/Karachi',
  checkInTime: '14:00',
  checkOutTime: '12:00',
  auditTime: '03:00',
  taxProfileId: 'tax_1',
  businessDatePolicy: { rollover: 'audit' },
};

describe('hotel catalog foundation', () => {
  // These digests were captured from the accepted preimage's public catalog values.
  it.each(['AGENCY', 'RESTAURANT', 'PHARMACY'] as const)(
    'preserves every existing %s catalog value',
    (v) => {
      const data = {
        definition: catalog.VERTICALS[v],
        departments: catalog.departmentsForVertical(v),
        adminDepartment: catalog.adminDepartmentKeyForVertical(v),
        memberDepartment: catalog.memberDepartmentKeyForVertical(v),
        modules: catalog.modulesForVertical(v),
        mandatory: catalog.mandatoryModulesForVertical(v),
        roles: catalog.roleTemplatesForVertical(v),
        jobs: catalog.jobRoleTemplatesForVertical(v),
        limits: catalog.limitKeysForVertical(v),
        packages: catalog.packagesForVertical(v),
      };
      expect(createHash('sha256').update(JSON.stringify(data)).digest('hex')).toBe(
        priorCatalogDigests[v]
      );
    }
  );
  it('declares explicit hotel grants while retaining empty auditor and API templates', () => {
    expect(catalog.HOSPITALITY_MODULES).toHaveLength(15);
    expect(catalog.HOSPITALITY_PACKAGES).toHaveLength(4);
    expect(catalog.HOSPITALITY_ROLE_TEMPLATES).toHaveLength(15);
    expect(catalog.HOSPITALITY_CAPABILITIES).toHaveLength(19);
    for (const action of catalog.HOSPITALITY_CAPABILITIES)
      expect(POLICIES[action as Action]).toEqual([]);
    for (const key of ['read-only-auditor', 'partner-api-key']) {
      expect(catalog.HOSPITALITY_ROLE_TEMPLATES.find((r) => r.key === key)?.capabilities).toEqual(
        []
      );
    }
    expect(catalog.FIRST_RUN_VERTICALS).toEqual(['RESTAURANT', 'PHARMACY']);
    expect(catalog.jobRoleTemplatesForVertical('HOSPITALITY')).toEqual([]);
    expect(catalog.adminDepartmentKeyForVertical('HOSPITALITY')).toBe('FRONT_OFFICE');
    expect(catalog.mandatoryModulesForVertical('HOSPITALITY').map((m) => m.key)).toEqual([
      'hotel-core',
    ]);
    for (const pkg of catalog.HOSPITALITY_PACKAGES) {
      expect(
        pkg.moduleKeys.every((key) =>
          MODULE_CATALOG.some((m) => m.key === key && m.vertical === 'HOSPITALITY')
        )
      ).toBe(true);
    }
  });
  it.each(['Serena Gulberg', '!!!', 'x'.repeat(120), 'مثال ہوٹل'])(
    'makes a valid deterministic booking slug for %s',
    (name) => {
      const value = defaultBookingEngineSlug('example-org', name);
      expect(bookingEngineSlug.parse(value)).toBe(value);
      expect(defaultBookingEngineSlug('example-org', name)).toBe(value);
    }
  );
});

function catalogDb(existing: string[] = []) {
  return {
    platformModule: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async (arg: { create: { key: string } }) => ({ id: arg.create.key })),
    },
    platformPackage: {
      findMany: vi.fn(async () => existing.map((key) => ({ key }))),
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async (arg: { create: { key: string } }) => ({ id: arg.create.key })),
    },
    platformPackageModule: { upsert: vi.fn(async () => ({})) },
  };
}

describe('hotel catalog synchronization', () => {
  it('creates hotel packages only in unscoped synchronization and keeps create-only module updates', async () => {
    const db = catalogDb();
    await syncPlatformCatalog(db as unknown as Prisma.TransactionClient);
    for (const pkg of catalog.HOSPITALITY_PACKAGES)
      expect(db.platformPackage.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: pkg.key }, update: {} })
      );
    for (const [arg] of db.platformModule.upsert.mock.calls)
      expect(arg).toMatchObject({ update: {} });
  });
  it('never repairs links of an existing hotel package', async () => {
    const key = catalog.HOSPITALITY_PACKAGES[0].key;
    const db = catalogDb([key]);
    await syncPlatformCatalog(db as unknown as Prisma.TransactionClient);
    expect(db.platformPackage.upsert.mock.calls.some(([arg]) => arg.create.key === key)).toBe(
      false
    );
    expect(
      db.platformPackageModule.upsert.mock.calls.some((args) => JSON.stringify(args).includes(key))
    ).toBe(false);
  });
  it('Restaurant scoped synchronization does not query or create hotel entitlements', async () => {
    const db = catalogDb();
    await syncPlatformCatalog(db as unknown as Prisma.TransactionClient, {
      vertical: 'RESTAURANT',
      packageKey: 'restaurant-enterprise',
    });
    expect(JSON.stringify(db.platformPackage.findMany.mock.calls)).not.toContain('hotel-');
    expect(JSON.stringify(db.platformModule.findMany.mock.calls)).not.toContain('hotel-');
    expect(db.platformPackage.upsert.mock.calls.map(([arg]) => arg.create.key)).toEqual([
      'restaurant-enterprise',
    ]);
  });
});

describe('hotel activation evidence', () => {
  it('requires every factual input, recorded policy and role set', () => {
    const complete = hotelEvidence(property, 15, 15, 1);
    expect(evaluateHotelOnboarding('org_1', complete).ready).toBe(true);
    expect(hotelEvidence(null, 0, 15, null)).toEqual({
      MODE_CHOSEN: false,
      PROPERTY_FACTS: false,
      TAX_PROFILE: false,
      BUSINESS_DATE_AND_AUDIT: false,
      ROLES_ASSIGNED: false,
      ROOM_TYPES: false,
    });
    expect(hotelEvidence({ ...property, businessDatePolicy: {} }, 14, 15, 1)).toMatchObject({
      BUSINESS_DATE_AND_AUDIT: false,
      ROLES_ASSIGNED: false,
    });
    expect(hotelEvidence({ ...property, timezone: ' ' }, 15, 15, 1).PROPERTY_FACTS).toBe(false);
  });
  it('recomputes scoped facts and keeps unavailable room types blocking even with complete other evidence', async () => {
    const db = {
      hotelProperty: { findFirst: vi.fn(async () => property) },
      organizationRole: { count: vi.fn(async () => 15) },
    };
    const result = await evaluateHotelReadiness(db as unknown as PrismaClient, 'org_1');
    expect(db.hotelProperty.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_1', active: true } })
    );
    expect(db.organizationRole.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        key: { in: catalog.HOSPITALITY_ROLE_TEMPLATES.map((r) => r.key) },
      },
    });
    expect(result.ready).toBe(false);
    expect(result.blocking.map((item) => item.key)).toEqual(['ROOM_TYPES']);
  });
  it('does not accept failed evidence queries as a stored readiness claim', async () => {
    const db = {
      hotelProperty: {
        findFirst: vi.fn(async () => {
          throw new Error('unavailable');
        }),
      },
      organizationRole: { count: vi.fn(async () => 15) },
    };
    await expect(evaluateHotelReadiness(db as unknown as PrismaClient, 'org_1')).rejects.toThrow(
      'unavailable'
    );
  });
});

describe('hotel property timezone', () => {
  const facts = {
    name: 'Example Hotel',
    addressLine: 'Synthetic street',
    city: 'Lahore',
    timezone: 'Asia/Karachi',
    checkInTime: '14:00',
    checkOutTime: '12:00',
    auditTime: '03:00',
    currency: 'PKR',
    languages: ['en'],
    bookingEngineSlug: 'example-hotel',
  };
  const zoneIssue = expect.objectContaining({
    path: ['timezone'],
    message: 'Choose a valid IANA timezone.',
  });

  // UTC, a zone without daylight saving time and one with it.
  it.each(['UTC', 'Asia/Karachi', 'America/New_York'])('accepts %s', (zone) => {
    expect(isValidHotelTimezone(zone)).toBe(true);
    expect(hotelPropertyUpdateInput.parse({ ...facts, timezone: zone }).timezone).toBe(zone);
  });
  it('trims a valid zone before it is checked and stored', () => {
    const parsed = hotelPropertyUpdateInput.parse({ ...facts, timezone: '  America/New_York  ' });
    expect(parsed.timezone).toBe('America/New_York');
  });
  it.each(['Mars/Phobos', 'Asia/Atlantis', 'not a timezone'])(
    'refuses the unknown zone %s on the timezone field',
    (zone) => {
      expect(isValidHotelTimezone(zone)).toBe(false);
      const result = hotelPropertyUpdateInput.safeParse({ ...facts, timezone: zone });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual(expect.arrayContaining([zoneIssue]));
    }
  );
  it.each([
    ['blank', ''],
    ['whitespace-only', '   '],
    ['null', null],
    ['missing', undefined],
  ])('keeps a %s timezone invalid, with no UTC fallback', (_label, zone) => {
    expect(isValidHotelTimezone(zone)).toBe(false);
    const result = hotelPropertyUpdateInput.safeParse({ ...facts, timezone: zone });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === 'timezone')).toBe(true);
  });
  it('keeps the existing 100-character limit', () => {
    const result = hotelPropertyUpdateInput.safeParse({ ...facts, timezone: 'x'.repeat(101) });
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['timezone'], code: 'too_big' })])
    );
  });
  it('counts property facts only for a stored zone the runtime accepts', () => {
    for (const zone of ['UTC', 'Asia/Karachi', 'America/New_York'])
      expect(hotelEvidence({ ...property, timezone: zone }, 15, 15, 1).PROPERTY_FACTS).toBe(true);
    for (const zone of ['Mars/Phobos', 'not a timezone', '', '   ', null]) {
      const evidence = hotelEvidence({ ...property, timezone: zone }, 15, 15, 1);
      expect(evidence.PROPERTY_FACTS).toBe(false);
      const blocking = evaluateHotelOnboarding('org_1', evidence).blocking.map((item) => item.key);
      expect(blocking).toEqual(['PROPERTY_FACTS']);
    }
    expect(hotelEvidence(null, 15, 15, 1).PROPERTY_FACTS).toBe(false);
  });
  it('keeps readiness non-throwing and blocking when the stored zone is unknown', async () => {
    const db = {
      hotelProperty: { findFirst: vi.fn(async () => ({ ...property, timezone: 'Mars/Phobos' })) },
      organizationRole: { count: vi.fn(async () => 15) },
    };
    const result = await evaluateHotelReadiness(db as unknown as PrismaClient, 'org_1');
    expect(result.ready).toBe(false);
    expect(result.blocking.map((item) => item.key)).toEqual(['PROPERTY_FACTS', 'ROOM_TYPES']);
  });
});
