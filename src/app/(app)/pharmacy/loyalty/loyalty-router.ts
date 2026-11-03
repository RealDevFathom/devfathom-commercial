import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import {
  listLoyaltyCustomers,
  readLoyaltyHistory,
  LOYALTY_HISTORY_MAX_PAGE,
  PharmacyLoyaltyError,
} from '@/lib/pharmacy/customer-loyalty';
import { annotateAudit } from '@/server/audit';
import { adminProcedure, publicProcedure, router, type TRPCContext } from '@/server/trpc';

function scopeFor(ctx: TRPCContext, branchId = '') {
  const organizationId = ctx.session?.user.organizationId;
  const actorId = ctx.session?.user.id;
  if (
    !organizationId ||
    !actorId ||
    organizationId !== ctx.entitlements.organizationId ||
    (ctx.organization && ctx.organization.id !== organizationId) ||
    !hasModule(ctx.entitlements, 'pharmacy-crm')
  ) {
    throw new TRPCError({ code: 'FORBIDDEN' });
  }
  return { organizationId, actorId, branchId };
}

const branchInput = z.object({ branchId: z.string().trim().min(1).max(128) });
async function historyRead<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof PharmacyLoyaltyError)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch or customer unavailable.' });
    throw error;
  }
}

// Server-page caller: no central router mutation. Explicit CRM check also applies
// when composed by core integration; see evidence/handoff-loyalty-20261008.md.
export const pharmacyLoyaltyRouter = router({
  branches: adminProcedure.query(({ ctx }) => {
    const scope = scopeFor(ctx);
    return ctx.db.pharmacyBranch.findMany({
      where: { organizationId: scope.organizationId, active: true },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }),
  customers: publicProcedure
    .use(({ ctx, next }) => {
      // Search text can contain a patient's phone, including on denied/invalid requests.
      ctx.audit.detail.skipInput = true;
      return next();
    })
    .concat(adminProcedure)
    .input(branchInput.extend({ query: z.string().trim().max(100).default('') }).strict())
    .query(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      let allowPatientPhoneSearch = false;
      if (input.query.length >= 2) {
        // Same patient-search boundary as pharmacyPrescriptions.counterPatients (DEV-624).
        const subject = subjectFromSession(ctx.session.user);
        const options = { db: ctx.db, source: 'TRPC' as const, ip: ctx.requestMeta.ip };
        allowPatientPhoneSearch =
          (await can(subject, 'pharmacy:counter', undefined, options)) ||
          (await can(subject, 'pharmacy:dispense', undefined, options));
      }
      annotateAudit(ctx, {
        category: 'PHARMACY_PATIENT',
        operation: 'READ',
        action: 'pharmacy.loyalty.customers',
        metadata: { protected: true, purpose: 'LOYALTY', branchId: input.branchId },
      });
      return historyRead(() =>
        listLoyaltyCustomers(ctx.db, scope, input.query, allowPatientPhoneSearch)
      );
    }),
  history: adminProcedure
    .input(
      branchInput
        .extend({
          customerId: z.string().trim().min(1).max(128),
          page: z.number().int().min(1).max(LOYALTY_HISTORY_MAX_PAGE).default(1),
        })
        .strict()
    )
    .query(({ ctx, input }) =>
      historyRead(() =>
        readLoyaltyHistory(ctx.db, scopeFor(ctx, input.branchId), input.customerId, input.page)
      )
    ),
  setReminderLanguage: adminProcedure
    .input(
      branchInput
        .extend({
          customerId: z.string().trim().min(1).max(128),
          preferredLanguage: z.enum(['en', 'ur']),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      const branch = await ctx.db.pharmacyBranch.findFirst({
        where: { id: input.branchId, organizationId: scope.organizationId, active: true },
        select: { id: true },
      });
      if (!branch) throw new TRPCError({ code: 'NOT_FOUND' });
      const current = await ctx.db.pharmacyCustomer.findFirst({
        where: { id: input.customerId, organizationId: scope.organizationId, active: true },
        select: { id: true, preferredLanguage: true },
      });
      if (!current) throw new TRPCError({ code: 'NOT_FOUND' });
      const updated = await ctx.db.pharmacyCustomer.updateMany({
        where: { id: input.customerId, organizationId: scope.organizationId, active: true },
        data: { preferredLanguage: input.preferredLanguage },
      });
      if (updated.count !== 1) throw new TRPCError({ code: 'NOT_FOUND' });
      annotateAudit(ctx, {
        category: 'PHARMACY',
        operation: 'UPDATE',
        action: 'pharmacyCustomer.setReminderLanguage',
        targetType: 'PharmacyCustomer',
        targetId: current.id,
        changes: {
          preferredLanguage: { before: current.preferredLanguage, after: input.preferredLanguage },
        },
        metadata: { branchId: input.branchId },
      });
      return { preferredLanguage: input.preferredLanguage };
    }),
});
