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
  PrepaidError,
} from '@/lib/pharmacy/prepaid-tiers';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

function scopeFor(ctx: TRPCContext) {
  const user = ctx.session!.user;
  if (
    !user.organizationId ||
    user.organizationId !== ctx.entitlements.organizationId ||
    !hasModule(ctx.entitlements, 'pharmacy-crm')
  )
    throw new TRPCError({ code: 'FORBIDDEN' });
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
    pin: z
      .string()
      .regex(/^\d{4,8}$/)
      .optional(),
  })
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
          select: { id: true, displayName: true, prepaidAccount: true },
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
        customers,
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
  move: adminProcedure.input(prepaidMovementInput).mutation(async ({ ctx, input }) => {
    scopeFor(ctx);
    const scope = await requireDrawerManagerAccess(ctx, input.branchId);
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
        const entry = await movePrepaid(db, scope, input);
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
