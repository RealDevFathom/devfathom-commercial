import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

type Proof = {
  actingStaffProfileId: string | null;
  deviceId: string;
  terminalSessionId: string;
  verified: boolean;
};
const proofs = new AsyncLocalStorage<Proof>();

/** Proof stays inside one authenticated terminal request; clients cannot supply it. */
export function withOwnerReauthenticationScope<T>(
  proof: Omit<Proof, 'verified'>,
  work: () => T
): T {
  return proofs.run({ ...proof, verified: false }, work);
}

export async function isSoloOwner(db: ScopedDb, staffProfileId: string, branchId: string) {
  const staff = await db.restaurantStaffProfile.findMany({
    where: { status: 'ACTIVE' },
    take: 2,
    select: {
      id: true,
      user: { select: { organizationRole: { select: { key: true } } } },
      jobRoles: {
        where: { branchId, jobRole: { key: 'owner', active: true } },
        select: { id: true },
      },
    },
  });
  const owner = staff[0];
  if (
    staff.length !== 1 ||
    owner.id !== staffProfileId ||
    (owner.user?.organizationRole?.key !== 'owner' && owner.jobRoles.length === 0)
  )
    return false;
  // Reuse the effective permission resolver, including explicit DENY overrides.
  const { operatorHasCapability } = await import('./checkout-routes');
  return operatorHasCapability(db, staffProfileId, 'coauth:approve', new Date(), branchId);
}

/** Call only after verifying this operator's PIN, never for a badge or demo approval. */
export async function recordOwnerPinReauthentication(
  db: ScopedDb,
  staffProfileId: string,
  branchId: string
) {
  const proof = proofs.getStore();
  if (!proof || proof.actingStaffProfileId !== staffProfileId) return;
  proof.verified = await isSoloOwner(db, staffProfileId, branchId);
}

export function hasOwnerPinReauthentication(actor: string, deviceId?: string | null) {
  const proof = proofs.getStore();
  return Boolean(
    proof?.verified && proof.actingStaffProfileId === actor && proof.deviceId === deviceId
  );
}

export function ownerReauthenticationSessionId(actor: string, deviceId?: string | null) {
  return hasOwnerPinReauthentication(actor, deviceId) ? proofs.getStore()!.terminalSessionId : null;
}
