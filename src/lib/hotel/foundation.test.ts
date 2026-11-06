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
  HOTEL_ONBOARDING_STEPS,
  HOTEL_VENUE_ONBOARDING_STEPS,
  evaluateHotelReadiness,
  evaluateHotelOnboarding,
  hotelEvidence,
  hotelSellableInventory,
} from './onboarding-checklist';

const priorCatalogDigests = {
  AGENCY: '54e0ca2cb112bd14c7bde79c1aba7ceeb7875fc51c5a0e5dd05c0db326440769',
  RESTAURANT: '94d6616c691e680b51b340e75547478e5fdd98e9aa208efc12ce64670dc950a7',
  // QA-130: canonical capability names and explicit Owner report grants.
  // #975 (47518cbf): Owner / Operator template gains exact 'pharmacy:procurement',
  // 'pharmacy:inventory', 'pharmacy:counter', 'pharmacy:close', 'pharmacy:manage'.
  // #247 / #479 (3369c68b): the Owner template gains exact 'pharmacy:safety'.
  // DEV-751 (#1418): generic sop:* actions in the pharmacy capability catalog and the
  // appended pharmacy SOP role-template grants. Its pin was 81bdc13b….
  // DEV-739 (#1413, Saad, DEV-32): day close is managers and owners only, so
  // 'pharmacy:close' moves from the Pharmacist template (#654) to the Manager template.
  // Restoring only those two template lines reproduces 81bdc13b…; nothing else changed.
  PHARMACY: '90b4f45a731df5735677b166f1af6f66e313cf43e0450cad2a763043cb5ef614',
};

const property = {
  mode: 'HOTEL',
  modeOverrides: null,
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
  // These digests pin accepted public catalog values, including the QA-130 grant migration.
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
      updateMany: vi.fn(async () => ({ count: 0 })),
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
  it('recomputes scoped facts and keeps missing room types blocking even with complete other evidence', async () => {
    const db = {
      hotelProperty: { findFirst: vi.fn(async () => ({ ...property, branchId: 'property_1' })) },
      organizationRole: { count: vi.fn(async () => 15) },
      hotelRoomType: { count: vi.fn(async () => 0) },
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
    // Counted under the property that was read, active types only.
    expect(db.hotelRoomType.count).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', branchId: 'property_1', active: true },
    });
    expect(result.ready).toBe(false);
    expect(result.blocking.map((item) => item.key)).toEqual(['ROOM_TYPES']);
  });
  it('is ready once the property holds one active room type, and links the step to the rooms page', async () => {
    const db = {
      hotelProperty: { findFirst: vi.fn(async () => ({ ...property, branchId: 'property_1' })) },
      organizationRole: { count: vi.fn(async () => 15) },
      hotelRoomType: { count: vi.fn(async () => 1) },
    };
    const result = await evaluateHotelReadiness(db as unknown as PrismaClient, 'org_1');
    expect(result.ready).toBe(true);
    expect(result.blocking).toEqual([]);
    const step = result.items.find((item) => item.key === 'ROOM_TYPES')!;
    expect(step).toMatchObject({
      state: 'DONE',
      href: '/hotel/settings/rooms',
      linkLabel: 'Open rooms',
    });
  });
  it('does not count room types when there is no property to count under', async () => {
    const db = {
      hotelProperty: { findFirst: vi.fn(async () => null) },
      organizationRole: { count: vi.fn(async () => 15) },
      hotelRoomType: { count: vi.fn(async () => 99) },
    };
    const result = await evaluateHotelReadiness(db as unknown as PrismaClient, 'org_1');
    expect(db.hotelRoomType.count).not.toHaveBeenCalled();
    expect(result.items.find((item) => item.key === 'ROOM_TYPES')?.state).toBe('NEEDS_YOU');
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

describe('step 6 for a property that sells no room inventory', () => {
  const venue = { ...property, mode: 'VENUE' };

  it('asks a venue for an active function space where a room seller is asked for a room type', () => {
    expect(hotelSellableInventory(venue)).toBe('FUNCTION_SPACES');
    expect(hotelSellableInventory(property)).toBe('ROOM_TYPES');
    for (const mode of ['HOTEL', 'HOSTEL', 'APARTMENT', 'RESORT'])
      expect(hotelSellableInventory({ ...property, mode })).toBe('ROOM_TYPES');
    expect(HOTEL_VENUE_ONBOARDING_STEPS.map((step) => step.key)).toEqual([
      'MODE_CHOSEN',
      'PROPERTY_FACTS',
      'TAX_PROFILE',
      'BUSINESS_DATE_AND_AUDIT',
      'ROLES_ASSIGNED',
      'FUNCTION_SPACES',
    ]);
    // Every other step is the room seller's own step, unchanged.
    expect(HOTEL_VENUE_ONBOARDING_STEPS.slice(0, 5)).toEqual(HOTEL_ONBOARDING_STEPS.slice(0, 5));
    expect(HOTEL_ONBOARDING_STEPS.map((step) => step.key)).not.toContain('FUNCTION_SPACES');
  });

  it('is ready with one active function space and no room type, and links the step to the spaces page', () => {
    const evidence = hotelEvidence(venue, 15, 15, null, 1);
    expect(evidence).toEqual({
      MODE_CHOSEN: true,
      PROPERTY_FACTS: true,
      TAX_PROFILE: true,
      BUSINESS_DATE_AND_AUDIT: true,
      ROLES_ASSIGNED: true,
      FUNCTION_SPACES: true,
    });
    const checklist = evaluateHotelOnboarding('org_1', evidence);
    expect(checklist.ready).toBe(true);
    expect(checklist.totalCount).toBe(6);
    expect(checklist.items.map((item) => item.key)).not.toContain('ROOM_TYPES');
    expect(checklist.items.find((item) => item.key === 'FUNCTION_SPACES')).toMatchObject({
      step: 6,
      label: 'At least one active function space',
      state: 'DONE',
      blocking: true,
      href: '/hotel/settings/spaces',
      linkLabel: 'Open function spaces',
    });
  });

  it('keeps a venue without an active function space blocking, whatever room types it holds', () => {
    for (const [roomTypes, spaces] of [
      [0, 0],
      [5, 0],
      [5, null],
      [null, null],
    ] as const) {
      const checklist = evaluateHotelOnboarding(
        'org_1',
        hotelEvidence(venue, 15, 15, roomTypes, spaces)
      );
      expect(checklist.ready).toBe(false);
      expect(checklist.blocking.map((item) => item.key)).toEqual(['FUNCTION_SPACES']);
      expect(checklist.blocking[0]!.why).toMatch(/Add at least one function space/);
    }
  });

  it('never lets function spaces stand in for a room type at a property that sells rooms', () => {
    for (const subject of [
      property,
      { ...property, mode: 'RESORT' },
      // An override can make a venue sell rooms; then it needs a room type too.
      { ...venue, modeOverrides: { inventoryKinds: ['ROOM'] } },
      { ...property, modeOverrides: { functionSpaces: true } },
    ]) {
      expect(hotelSellableInventory(subject)).toBe('ROOM_TYPES');
      const checklist = evaluateHotelOnboarding('org_1', hotelEvidence(subject, 15, 15, 0, 3));
      expect(checklist.ready).toBe(false);
      expect(checklist.blocking.map((item) => item.key)).toEqual(['ROOM_TYPES']);
      expect(checklist.items.map((item) => item.key)).not.toContain('FUNCTION_SPACES');
    }
  });

  it('follows the configuration, not the mode name, and keeps the room-type step when it cannot be read', () => {
    expect(hotelSellableInventory({ ...property, modeOverrides: { inventoryKinds: [] } })).toBe(
      'FUNCTION_SPACES'
    );
    expect(hotelSellableInventory({ ...venue, modeOverrides: {} })).toBe('FUNCTION_SPACES');
    expect(hotelSellableInventory({ ...venue, modeOverrides: { functionSpaces: false } })).toBe(
      'FUNCTION_SPACES'
    );
    // Missing or damaged data never earns the exception.
    expect(hotelSellableInventory(null)).toBe('ROOM_TYPES');
    expect(hotelSellableInventory({ mode: null, modeOverrides: null })).toBe('ROOM_TYPES');
    expect(hotelSellableInventory({ mode: 'UNKNOWN_MODE', modeOverrides: null })).toBe(
      'ROOM_TYPES'
    );
    expect(hotelSellableInventory({ ...venue, modeOverrides: { inventoryKinds: 'none' } })).toBe(
      'ROOM_TYPES'
    );
    expect(hotelSellableInventory({ ...venue, modeOverrides: { unknownKey: true } })).toBe(
      'ROOM_TYPES'
    );
    expect(hotelSellableInventory({ ...venue, modeOverrides: [] })).toBe('ROOM_TYPES');
  });

  it('counts the active function spaces of the property it read, and never its room types', async () => {
    const db = {
      hotelProperty: {
        findFirst: vi.fn(async () => ({ ...venue, branchId: 'venue_1' })),
      },
      organizationRole: { count: vi.fn(async () => 15) },
      hotelRoomType: { count: vi.fn(async () => 9) },
      hotelFunctionSpace: { count: vi.fn(async () => 0) },
    };
    const pending = await evaluateHotelReadiness(db as unknown as PrismaClient, 'org_1');
    expect(db.hotelProperty.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ mode: true, modeOverrides: true }),
      })
    );
    expect(db.hotelFunctionSpace.count).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', branchId: 'venue_1', active: true },
    });
    expect(db.hotelRoomType.count).not.toHaveBeenCalled();
    expect(pending.ready).toBe(false);
    expect(pending.blocking.map((item) => item.key)).toEqual(['FUNCTION_SPACES']);

    db.hotelFunctionSpace.count.mockResolvedValue(1);
    const ready = await evaluateHotelReadiness(db as unknown as PrismaClient, 'org_1');
    expect(ready.ready).toBe(true);
    expect(db.hotelRoomType.count).not.toHaveBeenCalled();
  });

  it('counts room types, never function spaces, for a property that sells rooms', async () => {
    const db = {
      hotelProperty: {
        findFirst: vi.fn(async () => ({ ...property, branchId: 'property_1' })),
      },
      organizationRole: { count: vi.fn(async () => 15) },
      hotelRoomType: { count: vi.fn(async () => 0) },
      hotelFunctionSpace: { count: vi.fn(async () => 4) },
    };
    const result = await evaluateHotelReadiness(db as unknown as PrismaClient, 'org_1');
    expect(db.hotelFunctionSpace.count).not.toHaveBeenCalled();
    expect(result.blocking.map((item) => item.key)).toEqual(['ROOM_TYPES']);
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
      hotelRoomType: { count: vi.fn(async () => 0) },
    };
    const result = await evaluateHotelReadiness(db as unknown as PrismaClient, 'org_1');
    expect(result.ready).toBe(false);
    expect(result.blocking.map((item) => item.key)).toEqual(['PROPERTY_FACTS', 'ROOM_TYPES']);
  });
});
