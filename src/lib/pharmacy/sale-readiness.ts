/**
 * DEV-860: the counter's ready-to-sell check, run before the first scan.
 *
 * It asks the same questions the sale paths ask, so the counter can list what is
 * missing instead of failing on the first scan with a generic error:
 *
 * - `blockers` would refuse a new bill now: the regulatory gate `createSale` runs
 *   (`storedPharmacyOperationDenial`, the same checks without locks or a denial audit)
 *   and, for an operator who takes payment, this device's OPEN drawer (DEV-725).
 * - `warnings` leave ordinary sales open but refuse part of them: a prescription,
 *   restricted or controlled line outside the pharmacist-presence hours (DEV-86), and
 *   a controlled line with no second pharmacist holding an active staff PIN.
 *
 * It authorizes nothing. Every write keeps its own gate in its own transaction. The
 * answer carries reason codes and booleans only, never another user's name or record.
 */

import { can } from '@/lib/abac';
import { isLockedOut } from '@/lib/restaurant/operator-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { NO_INDEPENDENT_PHARMACIST, type CounterSetupReason } from './counter-setup';
import { storedPharmacyOperationDenial } from './regulatory';

export type CounterSaleReadiness = {
  ready: boolean;
  blockers: CounterSetupReason[];
  warnings: CounterSetupReason[];
};

type ReadinessInput = {
  organizationId: string;
  branchId: string;
  actorId: string;
  /** This counter device. Only an operator who takes payment needs its drawer open. */
  deviceId?: string | null;
  takesPayment: boolean;
  at?: Date;
};

/** Credentials read when looking for a countersigning pharmacist; a branch has few. */
const PHARMACIST_PIN_SCAN_LIMIT = 50;

/**
 * True when someone other than the operator could countersign a controlled line: an
 * active member of this organization, with an active staff profile, an unrevoked and
 * unlocked organization-wide PIN, and the `pharmacy:dispense` grant. The same tests the
 * controlled authorization applies before it verifies the PIN.
 */
export async function hasIndependentPharmacistPin(
  db: ScopedDb,
  input: Pick<ReadinessInput, 'organizationId' | 'actorId'> & { at: Date }
): Promise<boolean> {
  const credentials = await db.restaurantOperatorCredential.findMany({
    where: {
      organizationId: input.organizationId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
      staffProfile: {
        status: 'ACTIVE',
        user: {
          organizationId: input.organizationId,
          status: 'ACTIVE',
          id: { not: input.actorId },
        },
      },
    },
    select: {
      failedAttempts: true,
      lockedUntil: true,
      staffProfile: {
        select: {
          user: {
            select: { id: true, role: true, department: true, status: true, organizationId: true },
          },
        },
      },
    },
    take: PHARMACIST_PIN_SCAN_LIMIT,
  });
  for (const credential of credentials) {
    const user = credential.staffProfile.user;
    if (
      !user ||
      user.organizationId !== input.organizationId ||
      user.status !== 'ACTIVE' ||
      user.id === input.actorId ||
      isLockedOut(credential, input.at)
    )
      continue;
    if (await can(user, 'pharmacy:dispense', undefined, { db, now: input.at })) return true;
  }
  return false;
}

export async function evaluateCounterSaleReadiness(
  db: ScopedDb,
  input: ReadinessInput
): Promise<CounterSaleReadiness> {
  const at = input.at ?? new Date();
  const blockers: CounterSetupReason[] = [];
  const warnings: CounterSetupReason[] = [];

  // The gate `createSale` runs for every new bill.
  const denial = await storedPharmacyOperationDenial(db, input.organizationId, input.branchId, {
    name: 'pharmacy.sale.create',
    at,
  });
  if (denial) {
    blockers.push(denial);
  } else {
    // The gate an Rx, restricted or controlled line meets at add-line.
    const regulated = await storedPharmacyOperationDenial(
      db,
      input.organizationId,
      input.branchId,
      {
        name: 'pharmacy.sale.dispense_regulated',
        at,
        requiresQualifiedPerson: true,
        requiresPharmacistPresence: true,
      }
    );
    if (regulated) warnings.push(regulated);
  }

  if (input.takesPayment) {
    const drawer = input.deviceId
      ? await db.pharmacyDrawerSession.findFirst({
          where: {
            organizationId: input.organizationId,
            branchId: input.branchId,
            deviceId: input.deviceId,
            status: 'OPEN',
          },
          select: { id: true },
        })
      : null;
    if (!drawer) blockers.push('DRAWER_NOT_OPEN');
  }

  if (
    !(await hasIndependentPharmacistPin(db, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      at,
    }))
  )
    warnings.push(NO_INDEPENDENT_PHARMACIST);

  return { ready: blockers.length === 0, blockers, warnings };
}
