import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { hasModule } from '@/lib/entitlements';
import {
  collectKhataPayment,
  FamilyKhataError,
  listKhataLedger,
  type FamilyKhataScope,
} from '@/lib/pharmacy/family-khata';
import { processDueWhatsAppKhataReminders } from '@/lib/pharmacy/whatsapp/khata-reminders';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '@/server/audit';
import { adminProcedure, router, type TRPCContext } from '@/server/trpc';

const txDb = (tx: unknown) => tx as ScopedDb;
const branchInput = z.object({ branchId: z.string().trim().min(1).max(128) });
const accountInput = branchInput.extend({ familyAccountId: z.string().trim().min(1).max(128) });

/** Owner-only, same tenant, Khata licensed through the counter package. */
function tenantScope(ctx: TRPCContext) {
  const organizationId = ctx.session?.user.organizationId;
  const actorId = ctx.session?.user.id;
  if (
    !organizationId ||
    !actorId ||
    organizationId !== ctx.entitlements.organizationId ||
    (ctx.organization && ctx.organization.id !== organizationId) ||
    (ctx.organization && ctx.organization.vertical !== 'PHARMACY') ||
    !hasModule(ctx.entitlements, 'pharmacy-counter')
  )
    throw new TRPCError({ code: 'FORBIDDEN' });
  return { organizationId, actorId };
}

async function branchScope(ctx: TRPCContext, branchId: string): Promise<FamilyKhataScope> {
  const scope = tenantScope(ctx);
  const branch = await ctx.db.pharmacyBranch.findFirst({
    where: { id: branchId, organizationId: scope.organizationId, active: true },
    select: { id: true },
  });
  if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch unavailable.' });
  return { ...scope, branchId };
}

/** Khata rows are branch-scoped by RLS; bind the branch inside the same transaction. */
function inBranch<T>(ctx: TRPCContext, scope: FamilyKhataScope, run: (db: ScopedDb) => Promise<T>) {
  return ctx.db.$transaction(async (tx) => {
    const db = txDb(tx);
    await db.$queryRaw(
      Prisma.sql`SELECT set_config('app.current_branch_id', ${scope.branchId}, true)`
    );
    return run(db);
  });
}

function khataFail(error: unknown): never {
  if (error instanceof FamilyKhataError)
    throw new TRPCError({
      code: error.reason === 'ACCOUNT_NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST',
      message: error.reason,
    });
  throw error;
}

// Server-page caller (like the loyalty ledger): no central router registration.
export const pharmacyKhataRouter = router({
  branches: adminProcedure.query(({ ctx }) => {
    const scope = tenantScope(ctx);
    return ctx.db.pharmacyBranch.findMany({
      where: { organizationId: scope.organizationId, active: true },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }),
  ledger: adminProcedure.input(branchInput.strict()).query(async ({ ctx, input }) => {
    const scope = await branchScope(ctx, input.branchId);
    return inBranch(ctx, scope, (db) => listKhataLedger(db, scope));
  }),
  collectPayment: adminProcedure
    .input(
      accountInput
        .extend({
          amountMinor: z.number().int().positive().max(2_147_483_647),
          method: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'WALLET']),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9-]{8,64}$/),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await branchScope(ctx, input.branchId);
      try {
        const result = await inBranch(ctx, scope, (db) => collectKhataPayment(db, scope, input));
        annotateAudit(ctx, {
          category: 'PHARMACY',
          operation: 'CREATE',
          action: 'pharmacyKhata.collectPayment',
          targetType: 'PharmacyFamilyAccount',
          targetId: input.familyAccountId,
          metadata: {
            branchId: input.branchId,
            amountMinor: result.paidMinor,
            method: input.method,
            replayed: result.replayed,
          },
        });
        return result;
      } catch (error) {
        khataFail(error);
      }
    }),
  sendReminder: adminProcedure.input(accountInput.strict()).mutation(async ({ ctx, input }) => {
    const scope = await branchScope(ctx, input.branchId);
    if (!hasModule(ctx.entitlements, 'pharmacy-crm'))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'WhatsApp reminders need the Pharmacy CRM package.',
      });
    const account = await inBranch(ctx, scope, (db) =>
      db.pharmacyFamilyAccount.findFirst({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          id: input.familyAccountId,
          active: true,
        },
        select: { id: true },
      })
    );
    if (!account) throw new TRPCError({ code: 'NOT_FOUND', message: 'ACCOUNT_NOT_FOUND' });
    const result = await processDueWhatsAppKhataReminders({
      limit: 1,
      account: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        familyAccountId: account.id,
      },
    });
    annotateAudit(ctx, {
      category: 'PHARMACY',
      operation: 'CREATE',
      action: 'pharmacyKhata.sendReminder',
      targetType: 'PharmacyFamilyAccount',
      targetId: account.id,
      metadata: {
        branchId: scope.branchId,
        sent: result.sent,
        prepared: result.prepared,
        duplicate: result.duplicate,
      },
    });
    return result;
  }),
});
