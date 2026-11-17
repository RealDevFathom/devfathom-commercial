import { counterLabel } from '@/lib/pharmacy/counter-label';
import 'server-only';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { adminProcedure, router, type TRPCContext } from '@/server/trpc';
import { hasModule } from '@/lib/entitlements';
import { annotateAudit } from '@/server/audit';
import { requireDrawerManagerAccess } from '@/server/routers/pharmacy-sales';
import {
  authenticateRefundPin,
  actorMayRefund,
  REFUND_PIN_POLICY,
} from '@/lib/pharmacy/refund-authorization';
import {
  lockOpenPharmacyDrawer,
  assertDrawerOperator,
  requireCurrentPharmacyBusinessDate,
} from '@/lib/pharmacy/settlement';
import {
  prepaidTierSettings,
  prepaidSettings,
  publishPrepaidSettings,
  movePrepaid,
  postPrepaidCash,
  prepaidPin,
  prepaidPinIsSet,
  PrepaidError,
  setPrepaidPin,
} from '@/lib/pharmacy/prepaid-tiers';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export const PREPAID_OWNER_ONLY = 'Only the owner can manage prepaid tiers and balances.';

/**
 * DEV-863: tiers, upfront payments and prepaid refunds belong to the owner. `adminProcedure`
 * checks a grantable capability that a delegated employee can hold, so the signed-in session
 * must also be this organization's owner (session ADMIN), before any read or money work.
 */
function scopeFor(ctx: TRPCContext) {
  const user = ctx.session!.user;
  if (
    !user.organizationId ||
    user.organizationId !== ctx.entitlements.organizationId ||
    !hasModule(ctx.entitlements, 'pharmacy-crm')
  )
    throw new TRPCError({ code: 'FORBIDDEN' });
  if (user.role !== 'ADMIN')
    throw new TRPCError({ code: 'FORBIDDEN', message: PREPAID_OWNER_ONLY });
  return { organizationId: user.organizationId, actorId: user.id };
}
export const prepaidMovementInput = z
  .object({
    branchId: z.string().min(1),
    customerId: z.string().min(1),
    deviceId: z.string().trim().min(1).max(128),
    amountMinor: z.number().int().positive().max(2_000_000_000),
    idempotencyKey: z.string().min(8).max(128),
    kind: z.enum(['PAYMENT', 'REFUND']),
    /** The owner's own staff PIN, re-entered for every refund. */
    pin: z
      .string()
      .regex(/^\d{4,8}$/)
      .optional(),
    /** PAYMENT only: the spend PIN the customer chooses; required on their first payment. */
    customerPin: prepaidPin.optional(),
  })
  .strict();
export const prepaidPinInput = z
  .object({ customerId: z.string().min(1), customerPin: prepaidPin })
  .strict();
export const pharmacyPrepaidRouter = router({
  overview: adminProcedure
    .input(z.object({ customerId: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const scope = scopeFor(ctx);
      const [versions, liability, customers, branches] = await Promise.all([
        prepaidSettings(ctx.db, scope.organizationId),
        ctx.db.pharmacyPrepaidAccount.aggregate({
          where: { organizationId: scope.organizationId },
          _sum: { balanceMinor: true },
        }),
        ctx.db.pharmacyCustomer.findMany({
          where: {
            organizationId: scope.organizationId,
            active: true,
            ...(input.customerId ? { id: input.customerId } : {}),
          },
          select: {
            id: true,
            displayName: true,
            // Never the PIN hash: the console only learns whether a PIN is set.
            prepaidAccount: {
              select: {
                balanceMinor: true,
                refundableMinor: true,
                tierName: true,
                spendPinHash: true,
              },
            },
          },
          orderBy: { displayName: 'asc' },
          take: 50,
        }),
        ctx.db.pharmacyBranch.findMany({
          where: { organizationId: scope.organizationId, active: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
      ]);
      const openDrawers = await ctx.db.pharmacyDrawerSession.findMany({
        where: { organizationId: scope.organizationId, status: 'OPEN' },
        select: { branchId: true, deviceId: true, businessDate: true },
        orderBy: { openedAt: 'desc' },
      });
      const devices = await ctx.db.pharmacyRegisteredDevice.findMany({
        where: {
          organizationId: scope.organizationId,
          id: { in: openDrawers.map((d) => d.deviceId) },
        },
        select: { id: true, name: true },
      });
      const drawers = openDrawers.map((d) => ({
        ...d,
        label:
          counterLabel(d.deviceId, devices.find((device) => device.id === d.deviceId)?.name) ??
          'Counter',
      }));
      const entries = input.customerId
        ? await ctx.db.pharmacyPrepaidEntry.findMany({
            where: {
              organizationId: scope.organizationId,
              account: { customerId: input.customerId },
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
          })
        : [];
      return {
        versions,
        drawers,
        liabilityMinor: liability._sum.balanceMinor ?? 0,
        customers: customers.map(({ prepaidAccount, ...customer }) => ({
          ...customer,
          prepaidAccount: prepaidAccount && {
            balanceMinor: prepaidAccount.balanceMinor,
            refundableMinor: prepaidAccount.refundableMinor,
            tierName: prepaidAccount.tierName,
            pinSet: !!prepaidAccount.spendPinHash,
          },
        })),
        branches,
        entries,
      };
    }),
  save: adminProcedure.input(prepaidTierSettings).mutation(async ({ ctx, input }) => {
    const scope = scopeFor(ctx);
    const version = await ctx.db.$transaction((tx) =>
      publishPrepaidSettings(tx as ScopedDb, scope, input)
    );
    annotateAudit(ctx, {
      category: 'PHARMACY',
      operation: 'CREATE',
      action: 'pharmacy.prepaid.settings',
      targetType: 'PharmacyPrepaidTierVersion',
      targetId: version.id,
      metadata: { version: version.version },
    });
    return version;
  }),
  setPin: adminProcedure.input(prepaidPinInput).mutation(async ({ ctx, input }) => {
    const scope = scopeFor(ctx);
    try {
      const result = await ctx.db.$transaction((tx) =>
        setPrepaidPin(tx as ScopedDb, scope, {
          customerId: input.customerId,
          pin: input.customerPin,
        })
      );
      annotateAudit(ctx, {
        category: 'PHARMACY',
        operation: 'UPDATE',
        action: 'pharmacy.prepaid.pinSet',
        targetType: 'PharmacyCustomer',
        targetId: input.customerId,
      });
      return result;
    } catch (error) {
      if (error instanceof PrepaidError)
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
      throw error;
    }
  }),
  move: adminProcedure.input(prepaidMovementInput).mutation(async ({ ctx, input }) => {
    const owner = scopeFor(ctx);
    const scope = await requireDrawerManagerAccess(ctx, input.branchId);
    if (scope.organizationId !== owner.organizationId || scope.actorId !== owner.actorId)
      throw new TRPCError({ code: 'FORBIDDEN', message: PREPAID_OWNER_ONLY });
    if (input.kind === 'REFUND' && input.customerPin !== undefined)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'A refund does not set a PIN.' });
    if (input.kind === 'REFUND') {
      if (!(await actorMayRefund(ctx.db, ctx.session!.user)))
        throw new TRPCError({ code: 'FORBIDDEN' });
      const verified = await authenticateRefundPin({
        ...scope,
        pin: input.pin ?? '',
        action: 'pharmacy.prepaid.refund',
      });
      if ('blocked' in verified)
        throw new TRPCError({ code: 'FORBIDDEN', message: verified.blocked });
    }
    try {
      const entry = await ctx.db.$transaction(async (tx) => {
        const db = tx as ScopedDb;
        const drawer = await lockOpenPharmacyDrawer(db, scope, input.deviceId);
        await requireCurrentPharmacyBusinessDate(db, scope, drawer.businessDate);
        assertDrawerOperator(drawer, scope, { kind: 'COUNTER', actorIsManager: true });
        // The customer chooses their spend PIN when they first pay; nothing spends without it.
        if (
          input.kind === 'PAYMENT' &&
          !input.customerPin &&
          !(await prepaidPinIsSet(db, scope.organizationId, input.customerId))
        )
          throw new PrepaidError(
            'The customer must choose a prepaid PIN with their first payment.'
          );
        const entry = await movePrepaid(db, scope, {
          customerId: input.customerId,
          kind: input.kind,
          amountMinor: input.amountMinor,
          idempotencyKey: input.idempotencyKey,
        });
        if (!entry.replayed && input.kind === 'PAYMENT' && input.customerPin)
          await setPrepaidPin(db, scope, { customerId: input.customerId, pin: input.customerPin });
        if (!entry.replayed) {
          await db.pharmacyDrawerMovement.create({
            data: {
              organizationId: scope.organizationId,
              drawerSessionId: drawer.id,
              kind: input.kind === 'PAYMENT' ? 'PAID_IN' : 'PAID_OUT',
              amountMinor: input.amountMinor,
              reason: `Prepaid ${entry.id}`,
              actorId: scope.actorId,
            },
          });
          await postPrepaidCash(db, scope, entry);
        }
        return entry;
      });
      annotateAudit(ctx, {
        category: 'PHARMACY',
        operation: 'CREATE',
        action: 'pharmacy.prepaid.move',
        targetType: 'PharmacyPrepaidEntry',
        targetId: entry.id,
        metadata: {
          kind: input.kind,
          ...(input.kind === 'REFUND' ? { policy: REFUND_PIN_POLICY, pinVerified: true } : {}),
        },
      });
      return entry;
    } catch (error) {
      if (error instanceof PrepaidError)
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
      throw error;
    }
  }),
});
