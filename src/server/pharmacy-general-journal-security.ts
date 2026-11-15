/**
 * CEO-JVCORE-20261025: authorization and audit for the pharmacy general
 * journal.
 *
 * The router's base procedure already runs the audited `admin:access` ABAC
 * check and records an independent tRPC audit row for every call, allowed or
 * denied. This module adds what a prefixless server caller (a page) would
 * otherwise skip, all BEFORE any voucher row is read:
 *   - the Pharmacy Finance licence for the authenticated organization,
 *   - the canonical `finance:read` ABAC decision,
 *   - an active branch inside that organization.
 *
 * A successful post/reverse also writes an EXECUTE audit row through the
 * business transaction itself, so the ledger change and its audit evidence
 * commit or roll back together.
 */
import { TRPCError } from '@trpc/server';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { recordAudit } from './audit';
import type { TRPCContext } from './trpc';

export const GENERAL_JOURNAL_AUDIT_CATEGORY = 'PHARMACY_FINANCE';
export const GENERAL_JOURNAL_TARGET_TYPE = 'PharmacyJournalVoucher';

export type GeneralJournalScope = { organizationId: string; branchId: string; actorId: string };

type AuthorizationContext = Pick<
  TRPCContext,
  'db' | 'entitlements' | 'organization' | 'requestMeta'
> & {
  session: NonNullable<TRPCContext['session']>;
};

function forbidden(message: string): never {
  throw new TRPCError({ code: 'FORBIDDEN', message });
}

export async function authorizeGeneralJournal(
  ctx: AuthorizationContext,
  branchId: string
): Promise<GeneralJournalScope> {
  const user = ctx.session?.user;
  if (!user?.id) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (user.role !== 'ADMIN') forbidden('Owner finance access is required.');
  const organizationId = ctx.entitlements?.organizationId;
  if (
    !organizationId ||
    !ctx.organization?.id ||
    organizationId !== ctx.organization.id ||
    (user.organizationId && user.organizationId !== organizationId)
  ) {
    forbidden('Organization is outside your finance scope.');
  }
  if (!hasModule(ctx.entitlements, 'pharmacy-finance')) {
    forbidden('Pharmacy Finance access is required.');
  }
  const allowed = await can(subjectFromSession(user), 'finance:read', undefined, {
    db: ctx.db,
    source: 'TRPC',
    ip: ctx.requestMeta?.ip ?? null,
  });
  if (!allowed) forbidden('Finance permission is required.');
  const branch = await ctx.db.pharmacyBranch.findFirst({
    where: { organizationId, id: branchId, active: true },
    select: { id: true },
  });
  if (!branch) forbidden('Branch is outside your finance scope.');
  return { organizationId, branchId: branch.id, actorId: user.id };
}

export type GeneralJournalExecuteAudit = {
  action: 'pharmacyGeneralJournal.post' | 'pharmacyGeneralJournal.reverse';
  voucher: { id: string; reference: string; version: number; status: string };
  entryId: string;
  commandKey: string;
  replayed: boolean;
};

/**
 * Awaited, transactional audit of a successful financial command. A failure
 * here throws and rolls back the posting it describes.
 */
export async function recordGeneralJournalExecuteAudit(
  tx: ScopedDb,
  ctx: Pick<AuthorizationContext, 'session' | 'requestMeta'>,
  scope: GeneralJournalScope,
  audit: GeneralJournalExecuteAudit
) {
  const user = ctx.session.user;
  await recordAudit(
    {
      organizationId: scope.organizationId,
      actorType: 'USER',
      actorId: scope.actorId,
      actorName: user.name ?? null,
      actorEmail: user.email ?? null,
      actorRole: user.role ?? null,
      source: 'TRPC',
      category: GENERAL_JOURNAL_AUDIT_CATEGORY,
      operation: 'EXECUTE',
      action: audit.action,
      description:
        audit.action === 'pharmacyGeneralJournal.post'
          ? `Posted journal voucher ${audit.voucher.reference}`
          : `Reversed journal voucher ${audit.voucher.reference}`,
      targetType: GENERAL_JOURNAL_TARGET_TYPE,
      targetId: audit.voucher.id,
      targetLabel: audit.voucher.reference,
      result: {
        status: audit.voucher.status,
        version: audit.voucher.version,
        entryId: audit.entryId,
        replayed: audit.replayed,
      },
      metadata: { branchId: scope.branchId, commandKey: audit.commandKey },
      ip: ctx.requestMeta?.ip ?? null,
      userAgent: ctx.requestMeta?.userAgent ?? null,
      path: audit.action,
      outcome: 'SUCCESS',
    },
    tx
  );
}
