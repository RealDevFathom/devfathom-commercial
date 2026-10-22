/**
 * COMP-01 — the hospitality onboarding checklist's go-live rule.
 *
 * The one thing worth pinning here is that readiness is *derived*: there is no
 * claim to record, so no fixture and no seed can move a step. Each test builds
 * property facts and asks what the checklist makes of them.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';

import {
  HOTEL_ONBOARDING_STEPS,
  evaluateHotelOnboarding,
  hotelActivationSummary,
  hotelEvidence,
  evaluateHotelReadiness,
  type HotelOnboardingEvidence,
} from './onboarding-checklist';

const ORG = 'org_hotel_checklist';

/** A property with every fact H1-01 can answer already recorded. */
const completeProperty = {
  mode: 'HOTEL',
  name: 'Serena Gulberg',
  addressLine: '12 Main Boulevard',
  city: 'Lahore',
  timezone: 'Asia/Karachi',
  checkInTime: '14:00',
  checkOutTime: '12:00',
  auditTime: '03:00',
  taxProfileId: 'tax_profile_1',
  businessDatePolicy: { roll: 'AUDIT' },
};

const allDone: HotelOnboardingEvidence = {
  MODE_CHOSEN: true,
  PROPERTY_FACTS: true,
  TAX_PROFILE: true,
  BUSINESS_DATE_AND_AUDIT: true,
  ROLES_ASSIGNED: true,
  ROOM_TYPES: true,
};

describe('hotel onboarding steps', () => {
  it('lists the six steps of the walk, numbered in order, all blocking', () => {
    expect(HOTEL_ONBOARDING_STEPS.map((step) => step.key)).toEqual([
      'MODE_CHOSEN',
      'PROPERTY_FACTS',
      'TAX_PROFILE',
      'BUSINESS_DATE_AND_AUDIT',
      'ROLES_ASSIGNED',
      'ROOM_TYPES',
    ]);
    expect(HOTEL_ONBOARDING_STEPS.map((step) => step.step)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const step of HOTEL_ONBOARDING_STEPS) {
      expect(step.blocking).toBe(true);
      expect(step.todo.length).toBeGreaterThan(0);
      expect(step.done.length).toBeGreaterThan(0);
    }
  });

  it('never links a step at a surface this build does not have', () => {
    const roomTypes = HOTEL_ONBOARDING_STEPS.find((step) => step.key === 'ROOM_TYPES')!;
    expect(roomTypes.href).toBeNull();
    expect(roomTypes.linkLabel).toBeNull();
  });
});

describe('evaluateHotelOnboarding', () => {
  it('is ready only when every step is answered', () => {
    const checklist = evaluateHotelOnboarding(ORG, allDone);
    expect(checklist.ready).toBe(true);
    expect(checklist.blocking).toEqual([]);
    expect(checklist.doneCount).toBe(6);
    expect(checklist.totalCount).toBe(6);
    expect(hotelActivationSummary(checklist)).toBe(
      'Every readiness step is done. This property can be activated.'
    );
  });

  it('refuses go-live while any single step is outstanding', () => {
    for (const key of HOTEL_ONBOARDING_STEPS.map((step) => step.key)) {
      const checklist = evaluateHotelOnboarding(ORG, { ...allDone, [key]: false });
      expect(checklist.ready, key).toBe(false);
      expect(checklist.blocking.map((item) => item.key)).toEqual([key]);
    }
  });

  it('states what to do next rather than that something is missing', () => {
    const checklist = evaluateHotelOnboarding(ORG, { ...allDone, TAX_PROFILE: false });
    const tax = checklist.items.find((item) => item.key === 'TAX_PROFILE')!;
    expect(tax.state).toBe('NEEDS_YOU');
    expect(tax.why).toContain('Attach the tax profile');
    expect(tax.blocksActivation).toBe(true);
    expect(hotelActivationSummary(checklist)).toBe(
      'Activation is refused until this step is done: Tax profile.'
    );
  });

  it('names the first three blocking steps and counts the rest', () => {
    const checklist = evaluateHotelOnboarding(ORG, {
      MODE_CHOSEN: false,
      PROPERTY_FACTS: false,
      TAX_PROFILE: false,
      BUSINESS_DATE_AND_AUDIT: false,
      ROLES_ASSIGNED: true,
      ROOM_TYPES: true,
    });
    expect(hotelActivationSummary(checklist)).toBe(
      'Activation is refused until these 4 steps are done: Property mode, Property facts, Tax profile and 1 more.'
    );
  });
});

describe('hotelEvidence', () => {
  it('answers every derivable step from a completely recorded property', () => {
    const evidence = hotelEvidence(completeProperty, 15, 15, 3);
    expect(evidence).toEqual(allDone);
  });

  it('reports every step outstanding when no property exists', () => {
    const evidence = hotelEvidence(null, 15, 15, null);
    expect(evidence).toEqual({
      MODE_CHOSEN: false,
      PROPERTY_FACTS: false,
      TAX_PROFILE: false,
      BUSINESS_DATE_AND_AUDIT: false,
      ROLES_ASSIGNED: true,
      ROOM_TYPES: false,
    });
  });

  it('does not accept blank strings as recorded facts', () => {
    const evidence = hotelEvidence(
      { ...completeProperty, city: '   ', taxProfileId: '' },
      15,
      15,
      1
    );
    expect(evidence.PROPERTY_FACTS).toBe(false);
    expect(evidence.TAX_PROFILE).toBe(false);
  });

  it('treats the default empty business-date policy as undecided', () => {
    expect(
      hotelEvidence({ ...completeProperty, businessDatePolicy: {} }, 15, 15, 1)
    ).toHaveProperty('BUSINESS_DATE_AND_AUDIT', false);
    // …and a non-object column is not a decision either.
    expect(
      hotelEvidence({ ...completeProperty, businessDatePolicy: [] }, 15, 15, 1)
    ).toHaveProperty('BUSINESS_DATE_AND_AUDIT', false);
  });

  it('requires every role template, not merely some roles', () => {
    expect(hotelEvidence(completeProperty, 14, 15, 1).ROLES_ASSIGNED).toBe(false);
    expect(hotelEvidence(completeProperty, 15, 15, 1).ROLES_ASSIGNED).toBe(true);
    // A vertical with no templates can never satisfy the step by vacuous truth.
    expect(hotelEvidence(completeProperty, 0, 0, 1).ROLES_ASSIGNED).toBe(false);
  });

  it('leaves room types pending until H1-03 can count them', () => {
    // `null` is "nothing can answer this yet" and must never read as satisfied.
    expect(hotelEvidence(completeProperty, 15, 15, null).ROOM_TYPES).toBe(false);
    expect(hotelEvidence(completeProperty, 15, 15, 0).ROOM_TYPES).toBe(false);
    expect(hotelEvidence(completeProperty, 15, 15, 1).ROOM_TYPES).toBe(true);
  });
});

it('counts actual room types only inside the resolved property and tenant', async () => {
  const count = vi.fn(async () => 1);
  const queryRaw = vi.fn(async () => []);
  const database = {
    hotelProperty: {
      findFirst: vi.fn(async () => ({ ...completeProperty, branchId: 'property_1' })),
    },
    organizationRole: { count: vi.fn(async () => 15) },
    $transaction: async (run: (tx: unknown) => unknown) =>
      run({ $queryRaw: queryRaw, hotelRoomType: { count } }),
  } as unknown as PrismaClient;
  const result = await evaluateHotelReadiness(database, ORG);
  expect(result.items.find((item) => item.key === 'ROOM_TYPES')?.state).toBe('DONE');
  expect(count).toHaveBeenCalledWith({ where: { organizationId: ORG, branchId: 'property_1' } });
  expect(queryRaw.mock.calls[0].slice(1)).toEqual(['property_1']);
  count.mockResolvedValue(0);
  const empty = await evaluateHotelReadiness(database, ORG);
  expect(empty.items.find((item) => item.key === 'ROOM_TYPES')?.state).toBe('NEEDS_YOU');
});
