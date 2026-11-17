import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./consent-writer', () => ({ lockCustomerConsent: vi.fn(async () => undefined) }));

import { lockCustomerConsent } from './consent-writer';
import { setLoyaltyMembership } from './loyalty-membership';

const scope = { organizationId: 'org-a' };

function fixture(
  customer: Record<string, unknown> | null = {
    id: 'customer-a',
    patientId: 'patient-a',
    loyaltyActive: true,
    displayName: 'Retail customer',
  },
  consent: Record<string, unknown> | null = { granted: true, revokedAt: null }
) {
  return {
    $queryRaw: vi.fn(async () => [{ branchId: null }]),
    pharmacyCustomer: {
      findFirst: vi.fn().mockResolvedValue(customer),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    patientConsent: { findFirst: vi.fn().mockResolvedValue(consent) },
    pharmacyLoyaltyPointsEntry: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { points: 140 } }),
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('DEV-764 loyalty membership', () => {
  it('deactivates a member under the customer lock, keeping every point', async () => {
    const db = fixture();
    const at = new Date('2026-11-17T10:00:00Z');
    await expect(
      setLoyaltyMembership(db as never, scope, {
        customerId: 'customer-a',
        active: false,
        reason: '  Asked to leave  ',
        at,
      })
    ).resolves.toMatchObject({ before: true, after: false, pointsBalance: 140, changed: true });
    expect(lockCustomerConsent).toHaveBeenCalledWith(db, 'org-a', 'customer-a');
    expect(vi.mocked(lockCustomerConsent).mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyCustomer.findFirst.mock.invocationCallOrder[0]!
    );
    expect(db.pharmacyCustomer.updateMany).toHaveBeenCalledWith({
      where: { id: 'customer-a', organizationId: 'org-a', active: true, loyaltyActive: true },
      data: {
        loyaltyActive: false,
        loyaltyStatusChangedAt: at,
        loyaltyStatusReason: 'Asked to leave',
      },
    });
    // Nothing is written to the points ledger: the balance stays exactly what it was.
    expect(db.pharmacyLoyaltyPointsEntry).not.toHaveProperty('create');
    expect(db.patientConsent.findFirst).not.toHaveBeenCalled();
  });

  it('re-enrols a deactivated member only with current loyalty consent', async () => {
    const inactive = {
      id: 'customer-a',
      patientId: 'patient-a',
      loyaltyActive: false,
      displayName: 'Retail customer',
    };
    const revoked = fixture(inactive, { granted: true, revokedAt: new Date() });
    await expect(
      setLoyaltyMembership(revoked as never, scope, {
        customerId: 'customer-a',
        active: true,
        reason: 'Rejoined',
      })
    ).rejects.toThrow('LOYALTY_CONSENT_REQUIRED');
    expect(revoked.pharmacyCustomer.updateMany).not.toHaveBeenCalled();

    const db = fixture(inactive);
    await expect(
      setLoyaltyMembership(db as never, scope, {
        customerId: 'customer-a',
        active: true,
        reason: 'Rejoined',
      })
    ).resolves.toMatchObject({ before: false, after: true, changed: true });
    expect(db.patientConsent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', patientId: 'patient-a', purpose: 'LOYALTY' },
      })
    );
    expect(db.pharmacyCustomer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ loyaltyActive: false }),
        data: expect.objectContaining({ loyaltyActive: true, loyaltyStatusReason: 'Rejoined' }),
      })
    );
  });

  it('changes nothing when the status is already in force', async () => {
    const db = fixture();
    await expect(
      setLoyaltyMembership(db as never, scope, {
        customerId: 'customer-a',
        active: true,
        reason: 'Enrol again',
      })
    ).resolves.toMatchObject({ before: true, after: true, changed: false });
    expect(db.pharmacyCustomer.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a missing reason before any read, and a customer outside the tenant', async () => {
    const db = fixture();
    await expect(
      setLoyaltyMembership(db as never, scope, {
        customerId: 'customer-a',
        active: false,
        reason: ' x ',
      })
    ).rejects.toThrow('INVALID_MEMBERSHIP_CHANGE');
    expect(db.pharmacyCustomer.findFirst).not.toHaveBeenCalled();
    expect(lockCustomerConsent).not.toHaveBeenCalled();

    const foreign = fixture(null);
    await expect(
      setLoyaltyMembership(foreign as never, scope, {
        customerId: 'other-tenant',
        active: false,
        reason: 'Asked to leave',
      })
    ).rejects.toThrow('CUSTOMER_NOT_FOUND');
    expect(foreign.pharmacyCustomer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'other-tenant', organizationId: 'org-a', active: true },
      })
    );
  });

  it('refuses when a concurrent change already moved the status', async () => {
    const db = fixture();
    db.pharmacyCustomer.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      setLoyaltyMembership(db as never, scope, {
        customerId: 'customer-a',
        active: false,
        reason: 'Asked to leave',
      })
    ).rejects.toThrow('CUSTOMER_NOT_FOUND');
  });
});
