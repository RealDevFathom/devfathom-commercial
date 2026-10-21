import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';

import { evaluateHotelOnboarding } from './onboarding-checklist';
import {
  loadHotelLanding,
  modeLabelFor,
  sellsFunctionSpaces,
  summarizeHotelLanding,
  walkSellsRooms,
  type HotelLandingSource,
} from './landing';

const evidence = {
  MODE_CHOSEN: true,
  PROPERTY_FACTS: true,
  TAX_PROFILE: false,
  BUSINESS_DATE_AND_AUDIT: false,
  ROLES_ASSIGNED: true,
  ROOM_TYPES: false,
};
const checklist = evaluateHotelOnboarding('org_hotel', evidence);
// The same walk at a venue: step 6 asks for a function space, which it has.
const venueChecklist = evaluateHotelOnboarding('org_venue', {
  MODE_CHOSEN: true,
  PROPERTY_FACTS: true,
  TAX_PROFILE: false,
  BUSINESS_DATE_AND_AUDIT: false,
  ROLES_ASSIGNED: true,
  FUNCTION_SPACES: true,
});
const property = {
  branchId: 'branch_lahore',
  name: 'Fathom Grand Lahore',
  city: 'Lahore',
  mode: 'HOTEL',
  checkInTime: '14:00',
  checkOutTime: '12:00',
  currency: 'PKR',
  timezone: 'Asia/Karachi',
};

function source(overrides: Partial<HotelLandingSource> = {}): HotelLandingSource {
  return {
    extras: {
      properties: vi.fn(async () => ({
        properties: [{ branchId: 'branch_lahore', name: 'Fathom Grand Lahore' }],
      })),
      list: vi.fn(async () => ({
        extras: [{ active: true }, { active: true }, { active: false }],
      })),
      ...overrides.extras,
    },
    get: vi.fn(async () => ({
      property,
      checklist,
      activationSummary: 'Activation is refused until these 3 steps are done.',
    })),
    ...(overrides.get ? { get: overrides.get } : {}),
  };
}

describe('loadHotelLanding', () => {
  it('reads every assigned property, its readiness and its active extras', async () => {
    const s = source();
    const landing = await loadHotelLanding(s);
    expect(landing).toEqual({
      kind: 'properties',
      properties: [
        {
          branchId: 'branch_lahore',
          name: 'Fathom Grand Lahore',
          city: 'Lahore',
          modeLabel: 'Hotel',
          sellsRooms: true,
          sellsFunctionSpaces: false,
          checkInTime: '14:00',
          checkOutTime: '12:00',
          currency: 'PKR',
          timezone: 'Asia/Karachi',
          extrasCount: 2,
          checklist,
          activationSummary: 'Activation is refused until these 3 steps are done.',
        },
      ],
    });
    expect(s.get).toHaveBeenCalledWith({ branchId: 'branch_lahore' });
    expect(s.extras.list).toHaveBeenCalledWith({ branchId: 'branch_lahore' });
  });

  it('reports an unassigned member when property administration lists nothing', async () => {
    const s = source({
      extras: { properties: vi.fn(async () => ({ properties: [] })), list: vi.fn() },
    });
    await expect(loadHotelLanding(s)).resolves.toEqual({ kind: 'unassigned' });
    expect(s.get).not.toHaveBeenCalled();
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'] as const)(
    'reports a %s refusal as denied',
    async (code) => {
      const s = source({
        extras: {
          properties: vi.fn(async () => {
            throw new TRPCError({ code });
          }),
          list: vi.fn(),
        },
      });
      await expect(loadHotelLanding(s)).resolves.toEqual({ kind: 'denied' });
    }
  );

  it('reports any other failure as an error instead of throwing into the page', async () => {
    const s = source({
      get: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    });
    await expect(loadHotelLanding(s)).resolves.toEqual({ kind: 'error' });
  });
});

describe('summarizeHotelLanding', () => {
  it('folds the ledger figures across properties', () => {
    const loaded = {
      branchId: 'b',
      name: 'n',
      city: 'c',
      modeLabel: 'Hotel',
      sellsRooms: true,
      sellsFunctionSpaces: false,
      checkInTime: '14:00',
      checkOutTime: '12:00',
      currency: 'PKR',
      timezone: 'Asia/Karachi',
      extrasCount: 4,
      checklist,
      activationSummary: '',
    };
    expect(summarizeHotelLanding([loaded, { ...loaded, branchId: 'b2', extrasCount: 1 }])).toEqual({
      propertyCount: 2,
      stepsDone: 6,
      stepsTotal: 12,
      blockingSteps: 6,
      extrasCount: 5,
      ready: false,
    });
    expect(summarizeHotelLanding([])).toMatchObject({ propertyCount: 0, ready: false });
  });

  it('names a mode for the operator and never shows a bare enum it does not know', () => {
    expect(modeLabelFor('HOTEL')).toBe('Hotel');
    expect(modeLabelFor('UNKNOWN_MODE')).toBe('UNKNOWN_MODE');
  });

  it('reads function-space sales from the configuration, not the mode name', () => {
    expect(sellsFunctionSpaces('VENUE', null)).toBe(true);
    expect(sellsFunctionSpaces('HOTEL', null)).toBe(false);
    expect(sellsFunctionSpaces('HOTEL', { functionSpaces: true })).toBe(true);
    expect(sellsFunctionSpaces('VENUE', { functionSpaces: false })).toBe(false);
    expect(sellsFunctionSpaces('UNKNOWN_MODE', null)).toBe(false);
  });

  it('offers rooms exactly where the walk asks for a room type', () => {
    expect(walkSellsRooms(checklist)).toBe(true);
    expect(walkSellsRooms(venueChecklist)).toBe(false);
  });
});

describe('loadHotelLanding for a venue', () => {
  it('carries the function-space step the router chose and offers no rooms page', async () => {
    const s = source({
      get: vi.fn(async () => ({
        property: { ...property, branchId: 'branch_venue', mode: 'VENUE', modeOverrides: null },
        checklist: venueChecklist,
        activationSummary: 'Activation is refused until these 2 steps are done.',
      })),
    });
    const landing = await loadHotelLanding(s);
    expect(landing.kind).toBe('properties');
    if (landing.kind !== 'properties') return;
    const [venue] = landing.properties;
    expect(venue).toMatchObject({
      modeLabel: 'Venue',
      sellsRooms: false,
      sellsFunctionSpaces: true,
      checklist: venueChecklist,
    });
    expect(venue!.checklist.items.find((item) => item.step === 6)).toMatchObject({
      key: 'FUNCTION_SPACES',
      label: 'At least one active function space',
      state: 'DONE',
      href: '/hotel/settings/spaces',
    });
    expect(summarizeHotelLanding(landing.properties)).toMatchObject({
      stepsDone: 4,
      stepsTotal: 6,
      blockingSteps: 2,
    });
  });
});
