import 'server-only';

import { TRPCError } from '@trpc/server';
import { pharmacySupplierComplianceRouter } from '@/server/routers/pharmacy-supplier-compliance';
import { tenantContext, type Notice } from '../../_lib/console';

export type SupplierComplianceCaller = ReturnType<
  typeof pharmacySupplierComplianceRouter.createCaller
>;
export type SupplierCompliancePolicyRead = Awaited<ReturnType<SupplierComplianceCaller['policy']>>;
export type SupplierCompliancePolicyHistory = Awaited<
  ReturnType<SupplierComplianceCaller['history']>
>;
export type SupplierComplianceSkips = Awaited<ReturnType<SupplierComplianceCaller['skips']>>;

/**
 * DEV-753: a caller for the owner policy. Like `purchasingCaller`, every Server
 * Function re-resolves the session, because a Server Function is reachable by
 * direct POST and not only through the form that renders it.
 */
export async function supplierComplianceCaller(): Promise<SupplierComplianceCaller | null> {
  const ctx = await tenantContext();
  return ctx ? pharmacySupplierComplianceRouter.createCaller(ctx) : null;
}

/** Fail closed for display: a policy that cannot be read is shown as enforced. */
export async function readPolicyForDisplay(
  caller: SupplierComplianceCaller | null
): Promise<SupplierCompliancePolicyRead | null> {
  if (!caller) return null;
  try {
    return await caller.policy();
  } catch {
    return null;
  }
}

/** Supplier checks are on unless the server positively said they are off. */
export function supplierChecksOn(read: SupplierCompliancePolicyRead | null): boolean {
  return read?.policy.checksEnabled !== false;
}

/**
 * A refusal the server explained is a known rejection; anything else leaves the
 * outcome unknown, so the operator is told to reload rather than assume.
 */
export function policyFailure(error: unknown): Notice {
  if (error instanceof TRPCError && ['FORBIDDEN', 'BAD_REQUEST', 'CONFLICT'].includes(error.code)) {
    return { message: error.message, kind: 'error', outcome: 'rejected' };
  }
  return {
    message:
      'Could not confirm whether supplier compliance checks changed. Reload to see the current setting before trying again.',
    kind: 'error',
    outcome: 'unknown',
  };
}
