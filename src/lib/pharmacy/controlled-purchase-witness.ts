import { can } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

type WitnessCandidate = {
  status: string;
  user: {
    id: string;
    organizationId: string;
    role: string;
    department?: string | null;
    status: string;
  } | null;
  credential: {
    revokedAt: Date | null;
    deviceId: string | null;
    lockedUntil: Date | null;
  } | null;
};

/**
 * The one server-side eligibility rule for a controlled goods-receipt witness.
 * Keep enumeration and PIN verification on this predicate: showing a person
 * whom posting will reject is both misleading and a disclosure of unrelated
 * staff PIN holders.
 */
export async function isControlledPurchaseWitnessEligible(
  db: ScopedDb,
  candidate: WitnessCandidate,
  scope: { organizationId: string; actorId: string },
  qualifiedPersonUserId: string,
  now = new Date()
): Promise<boolean> {
  const { credential, user } = candidate;
  return Boolean(
    candidate.status === 'ACTIVE' &&
      credential &&
      credential.revokedAt === null &&
      credential.deviceId === null &&
      (!credential.lockedUntil || credential.lockedUntil <= now) &&
      user &&
      user.id === qualifiedPersonUserId &&
      user.id !== scope.actorId &&
      user.organizationId === scope.organizationId &&
      user.status === 'ACTIVE' &&
      (await can(user, 'pharmacy:dispense', undefined, { db, now }))
  );
}
