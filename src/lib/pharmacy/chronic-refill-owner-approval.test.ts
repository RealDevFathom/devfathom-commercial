import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/abac', () => ({ can: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/restaurant/operator-credentials', () => ({
  clearLockout: () => ({ failedAttempts: 0, lockedUntil: null }),
  isLockedOut: (credential: { lockedUntil: Date | null }) => Boolean(credential.lockedUntil),
  registerFailedAttempt: (credential: { failedAttempts: number }) => ({ failedAttempts: credential.failedAttempts + 1 }),
  verifyOperatorCredential: vi.fn().mockResolvedValue(true),
}));

import { can } from '@/lib/abac';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { approveChronicRefillAsOwner } from './chronic-refill-owner-approval';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'owner-1' };
const input = { subscriptionId: 'sub-1', reviewItemId: 'review-1', staffProfileId: 'staff-1', pin: '826451', reason: 'Reviewed this cycle' };
function fixture() {
  const credential = { id: 'credential-1', credentialHash: 'hash', failedAttempts: 0, lockedUntil: null as Date | null,
    staffProfile: { status: 'ACTIVE', user: { id: scope.actorId, organizationId: scope.organizationId,
      status: 'ACTIVE', organizationRole: { key: 'owner-operator' } } } };
  return {
    credential,
    db: {
      $queryRaw: vi.fn().mockResolvedValue([{ id: input.reviewItemId }]),
      $executeRaw: vi.fn().mockResolvedValue(1),
      restaurantOperatorCredential: { findFirst: vi.fn().mockResolvedValue(credential), update: vi.fn() },
      pharmacyPharmacistReviewDecision: { create: vi.fn().mockResolvedValue({ id: 'decision-1' }) },
    },
  };
}

beforeEach(() => {
  vi.mocked(can).mockReset().mockResolvedValue(true);
  vi.mocked(verifyOperatorCredential).mockReset().mockResolvedValue(true);
});

describe('chronic refill owner PIN exception', () => {
  it.each(['cashier', 'other-owner', 'inactive', 'locked', 'denied-grant'])(
    'rejects %s without creating a signature or exception', async (scenario) => {
      const { db, credential } = fixture();
      if (scenario === 'cashier') credential.staffProfile.user.organizationRole.key = 'cashier';
      if (scenario === 'other-owner') credential.staffProfile.user.id = 'someone-else';
      if (scenario === 'inactive') credential.staffProfile.status = 'INACTIVE';
      if (scenario === 'locked') credential.lockedUntil = new Date(Date.now() + 60_000);
      if (scenario === 'denied-grant') vi.mocked(can).mockResolvedValue(false);
      expect(await approveChronicRefillAsOwner(db as never, scope, input)).toEqual({ blocked: true });
      expect(db.pharmacyPharmacistReviewDecision.create).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
    }
  );

  it('records an invalid PIN attempt without throwing away the durable counter', async () => {
    const { db } = fixture();
    vi.mocked(verifyOperatorCredential).mockResolvedValue(false);
    expect(await approveChronicRefillAsOwner(db as never, scope, input)).toEqual({ blocked: true });
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'credential-1' }, data: { failedAttempts: 1 },
    });
    expect(db.pharmacyPharmacistReviewDecision.create).not.toHaveBeenCalled();
  });

  it('keeps the one-item exception and audit inside the verified transaction without recording the PIN', async () => {
    const { db } = fixture();
    expect(await approveChronicRefillAsOwner(db as never, scope, input)).toEqual({ decisionId: 'decision-1' });
    const settings = db.$queryRaw.mock.calls.map(([sql]) => sql as { values: unknown[]; strings: string[] });
    expect(settings[2]!.values).toEqual([input.reviewItemId]);
    expect(settings[3]!.strings.join('')).toContain("'app.chronic_refill_owner_review_item_id', ''");
    const audit = db.$executeRaw.mock.calls[0]![0] as { values: unknown[]; strings: string[] };
    expect(audit.strings.join('')).toContain('OWNER_PIN_APPROVED');
    expect(JSON.stringify(audit.values)).toContain('decision-1');
    expect(JSON.stringify(audit.values)).not.toContain(input.pin);
  });
});
