import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./regulatory', () => ({ storedPharmacyOperationDenial: vi.fn() }));
vi.mock('@/lib/abac', () => ({ can: vi.fn() }));

import { can } from '@/lib/abac';
import { storedPharmacyOperationDenial } from './regulatory';
import { evaluateCounterSaleReadiness, hasIndependentPharmacistPin } from './sale-readiness';

/**
 * DEV-860: the ready-to-sell check lists, before the first scan, every setup gap that
 * would refuse a bill (blockers) or part of one (warnings). One case per reason.
 */
const at = new Date('2026-11-15T09:00:00.000Z');
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'actor-1' };

function pharmacistCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pin-1',
    failedAttempts: 0,
    lockedUntil: null,
    staffProfile: {
      user: {
        id: 'pharmacist-2',
        role: 'EMPLOYEE',
        department: null,
        status: 'ACTIVE',
        organizationId: 'org-a',
      },
    },
    ...overrides,
  };
}

function fixture({
  drawer = { id: 'drawer-1' } as { id: string } | null,
  credentials = [pharmacistCredential()] as unknown[],
  requireSecondPharmacist = true,
} = {}) {
  return {
    pharmacyBranch: { findFirstOrThrow: vi.fn(async () => ({ requireSecondPharmacist })) },
    pharmacyDrawerSession: { findFirst: vi.fn(async () => drawer) },
    restaurantOperatorCredential: { findMany: vi.fn(async () => credentials) },
  };
}

const run = (db: ReturnType<typeof fixture>, takesPayment = true, deviceId = 'device-1') =>
  evaluateCounterSaleReadiness(db as never, { ...scope, deviceId, takesPayment, at });

beforeEach(() => {
  vi.mocked(storedPharmacyOperationDenial).mockReset().mockResolvedValue(null);
  vi.mocked(can).mockReset().mockResolvedValue(true);
});

describe('evaluateCounterSaleReadiness (DEV-860)', () => {
  it('is ready when the gate passes, the drawer is open and a second pharmacist has a PIN', async () => {
    await expect(run(fixture())).resolves.toEqual({ ready: true, blockers: [], warnings: [] });
  });

  it.each([
    'ORGANIZATION_NOT_ACTIVE',
    'PROFILE_MISSING',
    'BRANCH_INACTIVE',
    'PROFILE_PREMISES_MISMATCH',
    'RULE_SET_UNCONFIRMED',
    'LICENCE_INVALID',
    'QUALIFIED_PERSON_COVERAGE_MISSING',
  ] as const)('blocks the first bill on %s, the reason createSale would refuse', async (reason) => {
    vi.mocked(storedPharmacyOperationDenial).mockResolvedValueOnce(reason);
    await expect(run(fixture())).resolves.toEqual({
      ready: false,
      blockers: [reason],
      warnings: [],
    });
    expect(storedPharmacyOperationDenial).toHaveBeenCalledWith(anyDb(), 'org-a', 'branch-a', {
      name: 'pharmacy.sale.create',
      at,
    });
    // The regulated-line question is not asked of a branch that cannot sell at all.
    expect(storedPharmacyOperationDenial).toHaveBeenCalledOnce();
  });

  it('warns that regulated lines are refused outside the pharmacist-presence hours', async () => {
    vi.mocked(storedPharmacyOperationDenial)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('PHARMACIST_NOT_PRESENT');
    await expect(run(fixture())).resolves.toEqual({
      ready: true,
      blockers: [],
      warnings: ['PHARMACIST_NOT_PRESENT'],
    });
    expect(storedPharmacyOperationDenial).toHaveBeenLastCalledWith(anyDb(), 'org-a', 'branch-a', {
      name: 'pharmacy.sale.dispense_regulated',
      at,
      requiresQualifiedPerson: true,
      requiresPharmacistPresence: true,
    });
  });

  it('blocks a cashier whose counter device has no OPEN drawer', async () => {
    const db = fixture({ drawer: null });
    await expect(run(db)).resolves.toEqual({
      ready: false,
      blockers: ['DRAWER_NOT_OPEN'],
      warnings: [],
    });
    expect(db.pharmacyDrawerSession.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        branchId: 'branch-a',
        deviceId: 'device-1',
        status: 'OPEN',
      },
      select: { id: true },
    });
  });

  it('blocks a cashier with no counter device rather than reading any drawer', async () => {
    const db = fixture();
    await expect(
      evaluateCounterSaleReadiness(db as never, { ...scope, takesPayment: true, at })
    ).resolves.toMatchObject({ ready: false, blockers: ['DRAWER_NOT_OPEN'] });
    expect(db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
  });

  it('asks no drawer of a pharmacist who takes no payment (DEV-97)', async () => {
    const db = fixture({ drawer: null });
    await expect(run(db, false)).resolves.toEqual({ ready: true, blockers: [], warnings: [] });
    expect(db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
  });

  it('omits the witness warning and credential search when the branch allows solo dispensing', async () => {
    const db = fixture({ credentials: [], requireSecondPharmacist: false });
    await expect(run(db)).resolves.toEqual({ ready: true, blockers: [], warnings: [] });
    expect(db.pharmacyBranch.findFirstOrThrow).toHaveBeenCalledWith({
      where: { organizationId: scope.organizationId, id: scope.branchId },
      select: { requireSecondPharmacist: true },
    });
    expect(db.restaurantOperatorCredential.findMany).not.toHaveBeenCalled();
  });

  it('warns when no second pharmacist holds an active staff PIN', async () => {
    await expect(run(fixture({ credentials: [] }))).resolves.toEqual({
      ready: true,
      blockers: [],
      warnings: ['NO_INDEPENDENT_PHARMACIST'],
    });
  });
});

describe('hasIndependentPharmacistPin (DEV-860)', () => {
  const ask = (db: ReturnType<typeof fixture>) =>
    hasIndependentPharmacistPin(db as never, { organizationId: 'org-a', actorId: 'actor-1', at });

  it('reads only unrevoked organization-wide PINs of active staff in this organization', async () => {
    const db = fixture();
    await expect(ask(db)).resolves.toBe(true);
    expect(db.restaurantOperatorCredential.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          type: 'PIN',
          revokedAt: null,
          deviceId: null,
          staffProfile: {
            status: 'ACTIVE',
            user: { organizationId: 'org-a', status: 'ACTIVE', id: { not: 'actor-1' } },
          },
        },
      })
    );
    expect(can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pharmacist-2' }),
      'pharmacy:dispense',
      undefined,
      expect.objectContaining({ now: at })
    );
  });

  it('finds an eligible pharmacist after a full page of ineligible PINs', async () => {
    const db = fixture();
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      pharmacistCredential({ id: `pin-${index}`, lockedUntil: new Date('2026-11-15T10:00:00Z') })
    );
    db.restaurantOperatorCredential.findMany
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([pharmacistCredential({ id: 'pin-50' })]);
    await expect(ask(db)).resolves.toBe(true);
    expect(db.restaurantOperatorCredential.findMany).toHaveBeenCalledTimes(2);
    expect(db.restaurantOperatorCredential.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: { id: 'pin-49' }, skip: 1, orderBy: { id: 'asc' } })
    );
  });

  it('exhausts every full page before reporting that no pharmacist is eligible', async () => {
    const db = fixture();
    vi.mocked(can).mockResolvedValue(false);
    db.restaurantOperatorCredential.findMany
      .mockResolvedValueOnce(
        Array.from({ length: 50 }, (_, index) => pharmacistCredential({ id: `pin-${index}` }))
      )
      .mockResolvedValueOnce(
        Array.from({ length: 50 }, (_, index) => pharmacistCredential({ id: `pin-${index + 50}` }))
      )
      .mockResolvedValueOnce([]);
    await expect(ask(db)).resolves.toBe(false);
    expect(db.restaurantOperatorCredential.findMany).toHaveBeenCalledTimes(3);
    expect(can).toHaveBeenCalledTimes(100);
  });

  it('does not count a holder without the dispensing grant', async () => {
    vi.mocked(can).mockResolvedValue(false);
    await expect(ask(fixture())).resolves.toBe(false);
  });

  it('does not count a locked-out PIN', async () => {
    const locked = pharmacistCredential({ lockedUntil: new Date('2026-11-15T10:00:00.000Z') });
    await expect(ask(fixture({ credentials: [locked] }))).resolves.toBe(false);
    expect(can).not.toHaveBeenCalled();
  });

  it('does not count the operator themself, another tenant or an inactive account', async () => {
    const user = pharmacistCredential().staffProfile.user;
    const credentials = [
      pharmacistCredential({ staffProfile: { user: { ...user, id: 'actor-1' } } }),
      pharmacistCredential({ staffProfile: { user: { ...user, organizationId: 'org-b' } } }),
      pharmacistCredential({ staffProfile: { user: { ...user, status: 'SUSPENDED' } } }),
      pharmacistCredential({ staffProfile: { user: null } }),
    ];
    await expect(ask(fixture({ credentials }))).resolves.toBe(false);
    expect(can).not.toHaveBeenCalled();
  });
});

function anyDb() {
  return expect.anything();
}
