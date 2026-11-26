import {
  CounterTransportError,
  establishToken,
  issueApprovalDeviceProof,
  verifyToken,
} from '@/lib/pharmacy/counter-terminal-session';
import { isAccountingPeriodClosedError } from '@/server/trpc-period-errors';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { hashDeviceSecret } from '@/lib/retail-terminal/device-secret';
import {
  enrollPharmacyCounter,
  PharmacyDeviceError,
  rotatePharmacyCounterSecret,
  revokePharmacyCounter,
  resolvePharmacyCounterBySecret,
} from '@/lib/pharmacy/offline-devices';
import { mrpRoundingIncrementForLot } from '@/lib/pharmacy/medicine';
import {
  pharmacyDeviceSecretDueForRenewal,
  pharmacyDeviceSecretExpired,
} from '@/lib/pharmacy/device-secret-expiry';
import {
  issueOfflineSnapshot,
  snapshotPayloadHash,
  snapshotPublicKey,
  verifySnapshotSignature,
} from '@/lib/pharmacy/offline-snapshots';
import { checkEnvelope } from '@/lib/pharmacy/offline-snapshot-envelope';
import { checkSafetyLease } from '@/lib/pharmacy/offline-safety-lease';
import { COUNTER_LEASE_RENEWAL_SIZE } from '@/lib/pharmacy/counter-offline-runtime';
import {
  reserveReceiptNumberBlock,
  MAX_RECEIPT_LEASE_SIZE,
} from '@/lib/pharmacy/offline-receipt-leases';
import {
  grantDeviceLotQuota,
  consumeDeviceLotQuota,
  openDeviceLotQuota,
  releaseDeviceLotQuota,
} from '@/lib/pharmacy/offline-quotas';
import {
  recordOfflineCommand,
  authorizeReplayedCommand,
  settleOfflineCommand,
} from '@/lib/pharmacy/offline-command-log';
import {
  authenticatePharmacyCommand,
  validateLeasedReceiptReplay,
  createSale,
  addSaleLine,
  lockSaleLineKey,
  assertSaleUnitConversion,
  PharmacySaleError,
} from '@/lib/pharmacy/sales';
import { BranchOperationDeniedError } from '@/lib/pharmacy/regulatory';
import { applyPharmacyTender, lockPharmacyDay } from '@/lib/pharmacy/settlement';
import {
  manualTenderCaptureSchema,
  validateManualTenderPolicy,
  manualMerchantPolicies,
} from '@/lib/pharmacy/manual-payments';
import { readManualPaymentSettings } from '@/lib/pharmacy/manual-payment-settings';
import {
  counterBranchAssignmentDenial,
  counterOperatorDenial,
} from '@/lib/pharmacy/counter-capability';
import { lockSaleCandidates, type LedgerScope } from '@/lib/pharmacy/stock-ledger';
import { lockStockRowsFrom } from '@/lib/pharmacy/stock-lock-order';
import { pharmacyBusinessDate } from '@/lib/pharmacy/business-day';
import { isPharmacistCheckPolicyOwner } from '@/lib/pharmacy/pharmacist-check-policy';
import {
  OFFLINE_CASH_SELLING_UNAVAILABLE_MESSAGE,
  OfflineCashSellingError,
  counterSetAsidesInForce,
  readOfflineCashSelling,
  signedRulesAllowOfflineSelling,
  writeOfflineCashSelling,
} from '@/lib/pharmacy/offline-cash-selling';
import {
  chainRefusal,
  sealLineTotalsValid,
  type ChainRefusal,
} from '@/lib/pharmacy/offline-sale-seal';
import { offlineSaleSealValid, recordedSaleSealHash } from '@/lib/pharmacy/offline-sale-seal-node';
import { readPharmacyDayClock } from '@/lib/pharmacy/business-day-clock';
import { formatKarachiDateTime } from '@/lib/pharmacy/karachi-time';
import {
  cookieCredentialAllowed,
  counterDeviceCookieOptions,
  counterDeviceCredential,
  exactSameOrigin,
  PHARMACY_COUNTER_DEVICE_COOKIE,
  PHARMACY_COUNTER_DEVICE_COOKIE_MAX_AGE,
} from '@/lib/pharmacy/counter-device-cookie';
import { NextResponse } from 'next/server';
import {
  OFFLINE_PREPARATION_LOT_LIMIT,
  offlinePreparationPlan,
} from '@/lib/pharmacy/offline-preparation';
import { adminProcedure, router } from '../trpc';

const id = z.string().min(1).max(160);
const branchInput = z.object({ branchId: id }).strict();
async function activeBranch(db: ScopedDb, organizationId: string, branchId: string) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: branchId, organizationId, active: true },
    select: { id: true },
  });
  if (!branch) throw new TRPCError({ code: 'FORBIDDEN', message: 'branch_unavailable' });
}
/**
 * DEV-957: enrolment acts on one branch's counters, so the administrator must
 * also be assigned to that branch (an organization ADMIN spans the
 * organization), exactly as the counter route's manager operations (DEV-850).
 */
async function managedBranch(
  db: ScopedDb,
  user: Parameters<typeof counterBranchAssignmentDenial>[1],
  organizationId: string,
  branchId: string
) {
  await activeBranch(db, organizationId, branchId);
  const denial = await counterBranchAssignmentDenial(db, user, organizationId, branchId);
  if (denial) throw new TRPCError({ code: 'FORBIDDEN', message: denial });
}

/** The device service's refusals as tRPC answers, never a 500. */
function deviceRefusal(error: unknown): never {
  if (error instanceof PharmacyDeviceError) {
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'INVALID_NAME'
            ? 'BAD_REQUEST'
            : 'CONFLICT',
      message: error.reason,
    });
  }
  throw error;
}

/** The words the Sales to reconcile form uses for each outcome. */
const UNSENT_SALE_OUTCOME_LABELS = {
  ENTERED_ONLINE: 'Entered as a sale online',
  MONEY_RETURNED: 'Money given back to the customer',
  OTHER: 'Something else',
} as const;

export const pharmacyOfflineRouter = router({
  /**
   * DEV-957: the branch's counters for the enrolment screen. Only identifiers,
   * status and runway counts: never a secret hash, a snapshot or a payload.
   */
  counters: adminProcedure.input(branchInput).query(({ ctx, input }) =>
    ctx.db.$transaction(async (tx) => {
      const db = tx as ScopedDb;
      const organizationId = ctx.entitlements.organizationId;
      await managedBranch(db, ctx.session.user, organizationId, input.branchId);
      const devices = await db.pharmacyRegisteredDevice.findMany({
        where: { organizationId, branchId: input.branchId, kind: 'PHARMACY_COUNTER' },
        select: {
          id: true,
          name: true,
          status: true,
          revokedAt: true,
          lastSeenAt: true,
          createdAt: true,
          secretExpiresAt: true,
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: 100,
      });
      const ids = devices.map((device) => device.id);
      const [leases, quotas, pending] = ids.length
        ? await Promise.all([
            db.pharmacyReceiptNumberLease.findMany({
              where: { organizationId, branchId: input.branchId, deviceId: { in: ids } },
              select: { deviceId: true, blockEnd: true, nextNumber: true },
            }),
            db.pharmacyDeviceLotQuota.findMany({
              where: {
                organizationId,
                branchId: input.branchId,
                deviceId: { in: ids },
                releasedAt: null,
              },
              select: { deviceId: true, quotaUnits: true, consumedUnits: true },
            }),
            db.pharmacyOfflineCommand.groupBy({
              by: ['deviceId'],
              where: {
                organizationId,
                branchId: input.branchId,
                deviceId: { in: ids },
                status: 'PENDING',
              },
              _count: { _all: true },
            }),
          ])
        : [[], [], []];
      return devices.map((device) => ({
        id: device.id,
        name: device.name,
        status: device.status,
        revokedAt: device.revokedAt?.toISOString() ?? null,
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
        enrolledAt: device.createdAt.toISOString(),
        // DEV-957 phase 2: when the server stops renewing this counter's offline selling.
        credentialExpiresAt: device.secretExpiresAt.toISOString(),
        credentialExpired: pharmacyDeviceSecretExpired(device, new Date()),
        receiptNumbersLeft: leases
          .filter((lease) => lease.deviceId === device.id)
          .reduce((total, lease) => total + Math.max(0, lease.blockEnd - lease.nextNumber + 1), 0),
        offlineUnitsLeft: quotas
          .filter((quota) => quota.deviceId === device.id)
          .reduce((total, quota) => total + Math.max(0, quota.quotaUnits - quota.consumedUnits), 0),
        failedOfflineSales: pending.find((row) => row.deviceId === device.id)?._count._all ?? 0,
      }));
    })
  ),
  /**
   * DEV-957: what "Prepare this counter for offline" proposes to grant. Read
   * only; the grant itself still goes through the counter route's manager-only
   * quota operation and the database capacity guard.
   */
  preparationPlan: adminProcedure
    .input(branchInput.extend({ deviceId: id }))
    .query(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const db = tx as ScopedDb;
        const organizationId = ctx.entitlements.organizationId;
        await managedBranch(db, ctx.session.user, organizationId, input.branchId);
        const device = await db.pharmacyRegisteredDevice.findFirst({
          where: { id: input.deviceId, organizationId, branchId: input.branchId },
          select: { id: true, status: true, revokedAt: true },
        });
        if (!device) throw new TRPCError({ code: 'NOT_FOUND' });
        if (device.status !== 'ACTIVE' || device.revokedAt)
          throw new TRPCError({ code: 'CONFLICT', message: 'REVOKED' });
        // Review round 2: nothing is set aside while offline cash selling is off.
        if (!(await counterSetAsidesInForce(db, organizationId)))
          return { lots: [], limit: OFFLINE_PREPARATION_LOT_LIMIT, settingAside: false };
        const lots = await offlinePreparationPlan(
          db,
          { organizationId, branchId: input.branchId },
          { deviceId: device.id, now: new Date() }
        );
        return { lots, limit: OFFLINE_PREPARATION_LOT_LIMIT, settingAside: true };
      })
    ),
  /**
   * DEV-957 phase 2: receipt numbers a revoked counter, or one whose credential expired,
   * reserved but never printed. They are never reused (a block's numbers are issued once,
   * from its cursor, and no other counter or online sale takes them), so this lists every
   * such gap with its cause, for an accountant to explain each missing number. A revoked
   * counter's gap is final; an expired counter's numbers stay unused unless a manager
   * renews it in Settings, Counter computers.
   */
  receiptNumberGaps: adminProcedure.input(branchInput).query(({ ctx, input }) =>
    ctx.db.$transaction(async (tx) => {
      const db = tx as ScopedDb;
      const organizationId = ctx.entitlements.organizationId;
      await managedBranch(db, ctx.session.user, organizationId, input.branchId);
      return receiptNumberGaps(db, { organizationId, branchId: input.branchId }, new Date());
    })
  ),
  /**
   * DEV-957 phase 2 (review B1): the owner's offline cash selling switch, as it is in
   * force. Off, and not available to switch on until sending offline sales is ready.
   */
  offlineCashSelling: adminProcedure.input(branchInput).query(({ ctx, input }) =>
    ctx.db.$transaction(async (tx) => {
      const db = tx as ScopedDb;
      const organizationId = ctx.entitlements.organizationId;
      await managedBranch(db, ctx.session.user, organizationId, input.branchId);
      const setting = await readOfflineCashSelling(db, organizationId);
      return {
        ...setting,
        message: setting.available ? null : OFFLINE_CASH_SELLING_UNAVAILABLE_MESSAGE,
      };
    })
  ),
  /**
   * The owner's write. In this phase switching it on is refused for everyone; switching it
   * off changes nothing. Owner only, so the refusal is the same answer phase 3 builds on.
   */
  setOfflineCashSelling: adminProcedure
    .input(branchInput.extend({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const db = tx as ScopedDb;
        const organizationId = ctx.entitlements.organizationId;
        await managedBranch(db, ctx.session.user, organizationId, input.branchId);
        // Switching it on is refused for everyone while it is not available, owner included.
        const current = await readOfflineCashSelling(db, organizationId);
        if (input.enabled && !current.enabled && !current.available)
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: OFFLINE_CASH_SELLING_UNAVAILABLE_MESSAGE,
          });
        if (!(await isPharmacistCheckPolicyOwner(db, organizationId, ctx.session.user.id)))
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the owner can change this.' });
        try {
          return await writeOfflineCashSelling(db, organizationId, { enabled: input.enabled });
        } catch (error) {
          if (error instanceof OfflineCashSellingError)
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: OFFLINE_CASH_SELLING_UNAVAILABLE_MESSAGE,
            });
          throw error;
        }
      })
    ),
  /**
   * DEV-957 phase 2 (review B2): a manager records what was done with one offline sale a
   * revoked (or removed) counter kept and never sent. The sale itself stays on that
   * computer until this is recorded (or the server acknowledges it); here only the
   * manager's account of it is kept, audited. If the server already holds the sale, that
   * is said instead and nothing is recorded.
   */
  recordUnsentOfflineSale: adminProcedure
    .input(
      branchInput.extend({
        deviceId: id,
        commandId: id,
        sequence: z.number().int().positive().max(2_147_483_647),
        receiptNumber: z.number().int().positive().max(2_147_483_647),
        amountMinor: z.number().int().nonnegative().safe(),
        soldAt: z.iso.datetime(),
        sealHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
        outcome: z.enum(['ENTERED_ONLINE', 'MONEY_RETURNED', 'OTHER']),
        note: z.string().trim().min(1).max(500),
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const db = tx as ScopedDb;
        const scope = {
          organizationId: ctx.entitlements.organizationId,
          branchId: input.branchId,
          actorId: ctx.session.user.id,
        };
        await managedBranch(db, ctx.session.user, scope.organizationId, scope.branchId);
        const device = await db.pharmacyRegisteredDevice.findFirst({
          where: {
            id: input.deviceId,
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            kind: 'PHARMACY_COUNTER',
          },
          select: { id: true },
        });
        if (!device) throw new TRPCError({ code: 'NOT_FOUND' });
        const onServer = await db.pharmacyOfflineCommand.findFirst({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            deviceId: device.id,
            idempotencyKey: input.commandId,
          },
          select: { id: true, status: true },
        });
        if (onServer) return { recorded: false as const, serverStatus: onServer.status };
        // Review round 2: idempotent. Two attempts at once queue on this lock, and a retry of
        // one already recorded answers as recorded without a second audit row.
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pharmacy-unsent-sale:${scope.organizationId}:${device.id}:${input.commandId}`}, 0))`;
        const already = await db.auditLog.findFirst({
          where: {
            organizationId: scope.organizationId,
            action: 'pharmacyOffline.recordUnsentOfflineSale',
            targetId: device.id,
            metadata: { path: ['commandId'], equals: input.commandId },
          },
          select: { actorName: true, createdAt: true, metadata: true },
        });
        if (already) {
          // Review round 3: a retry that says the same thing is the same record. One that says
          // something else never silently keeps the first answer: it is refused, naming who
          // recorded the sale, when, and what.
          const first = (already.metadata ?? {}) as { outcome?: unknown; note?: unknown };
          if (first.outcome === input.outcome && first.note === input.note)
            return { recorded: true as const, serverStatus: null };
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Receipt ${input.receiptNumber} was already recorded by ${already.actorName ?? 'another manager'} on ${formatKarachiDateTime(already.createdAt)} as "${UNSENT_SALE_OUTCOME_LABELS[first.outcome as keyof typeof UNSENT_SALE_OUTCOME_LABELS] ?? 'another outcome'}", with the note "${typeof first.note === 'string' ? first.note : ''}". Nothing was changed.`,
          });
        }
        await db.auditLog.create({
          data: {
            organizationId: scope.organizationId,
            actorId: scope.actorId,
            actorName: ctx.session.user.name ?? null,
            actorEmail: ctx.session.user.email ?? null,
            actorRole: ctx.session.user.role ?? null,
            source: 'TRPC',
            category: 'PHARMACY',
            operation: 'UPDATE',
            action: 'pharmacyOffline.recordUnsentOfflineSale',
            targetType: 'PharmacyRegisteredDevice',
            targetId: device.id,
            metadata: {
              branchId: scope.branchId,
              deviceId: device.id,
              commandId: input.commandId,
              sequence: input.sequence,
              receiptNumber: input.receiptNumber,
              amountMinor: input.amountMinor,
              soldAt: input.soldAt,
              sealHash: input.sealHash,
              outcome: input.outcome,
              note: input.note,
            },
          },
        });
        return { recorded: true as const, serverStatus: null };
      })
    ),
  enroll: adminProcedure
    .input(branchInput.extend({ name: z.string().trim().min(1).max(100) }))
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const db = tx as ScopedDb;
        const scope = {
          organizationId: ctx.entitlements.organizationId,
          branchId: input.branchId,
          actorId: ctx.session.user.id,
        };
        await managedBranch(db, ctx.session.user, scope.organizationId, scope.branchId);
        const { device, secret } = await enrollPharmacyCounter(db, scope, input).catch(
          deviceRefusal
        );
        return { device: { id: device.id, name: device.name, branchId: device.branchId }, secret };
      })
    ),
  rotate: adminProcedure
    .input(branchInput.extend({ deviceId: id, sessionToken: z.string().max(4096).optional() }))
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const db = tx as ScopedDb;
        const scope = {
          organizationId: ctx.entitlements.organizationId,
          branchId: input.branchId,
          actorId: ctx.session.user.id,
        };
        await managedBranch(db, ctx.session.user, scope.organizationId, scope.branchId);
        // Receipt leasing takes SHARE on this row. A first lease cannot race this check.
        await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_registered_devices
        WHERE id=${input.deviceId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`);
        const current = await db.pharmacyRegisteredDevice.findFirst({
          where: {
            id: input.deviceId,
            organizationId: scope.organizationId,
            branchId: scope.branchId,
          },
        });
        if (!current) throw new TRPCError({ code: 'NOT_FOUND' });
        // A never-prepared counter has no leased number and cannot hold a sealed sale.
        const issued = await db.pharmacyReceiptNumberLease.findFirst({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            deviceId: current.id,
          },
          select: { id: true },
        });
        if (issued) {
          try {
            verifyToken(input.sessionToken ?? '', {
              scope,
              deviceId: current.id,
              credentialHash: current.deviceSecretHash,
            });
          } catch {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message:
                'Rotate the credential on this counter after its waiting receipts are settled.',
            });
          }
        }
        const { device, secret } = await rotatePharmacyCounterSecret(
          db,
          scope,
          current.id,
          current.deviceSecretHash
        ).catch(deviceRefusal);
        return { deviceId: device.id, secret };
      })
    ),
  revoke: adminProcedure.input(branchInput.extend({ deviceId: id })).mutation(({ ctx, input }) =>
    ctx.db.$transaction(async (tx) => {
      const db = tx as ScopedDb;
      const scope = {
        organizationId: ctx.entitlements.organizationId,
        branchId: input.branchId,
        actorId: ctx.session.user.id,
      };
      await managedBranch(db, ctx.session.user, scope.organizationId, scope.branchId);
      const now = new Date();
      const device = await revokePharmacyCounter(db, scope, input.deviceId, now).catch(
        deviceRefusal
      );
      // DEV-957: a revoked counter can never sell what it was earmarked, so its
      // open quotas go back to the branch in the same transaction. The rows stay
      // (release is final and audited), so nothing is counted twice.
      const open = await db.pharmacyDeviceLotQuota.findMany({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          deviceId: device.id,
          releasedAt: null,
        },
        select: { id: true, quotaUnits: true, consumedUnits: true },
        orderBy: { id: 'asc' },
      });
      for (const quota of open) await releaseDeviceLotQuota(db, scope, quota.id, now);
      if (open.length) {
        await db.auditLog.create({
          data: {
            organizationId: scope.organizationId,
            actorId: scope.actorId,
            actorName: ctx.session.user.name ?? null,
            actorEmail: ctx.session.user.email ?? null,
            actorRole: ctx.session.user.role ?? null,
            source: 'TRPC',
            category: 'PHARMACY',
            operation: 'UPDATE',
            action: 'pharmacyOffline.releaseOfflineQuotas',
            targetType: 'PharmacyRegisteredDevice',
            targetId: device.id,
            metadata: {
              branchId: scope.branchId,
              deviceId: device.id,
              quotasReleased: open.length,
              unitsReleased: open.reduce(
                (total, quota) => total + quota.quotaUnits - quota.consumedUnits,
                0
              ),
            },
          },
        });
      }
      return { deviceId: device.id, status: device.status, quotasReleased: open.length };
    })
  ),
});

export type ReceiptNumberGap = {
  deviceId: string;
  deviceName: string;
  leaseId: string;
  blockStart: number;
  blockEnd: number;
  /** The first and last number of the block that were never printed. */
  firstUnused: number;
  lastUnused: number;
  unused: number;
  cause: 'REVOKED' | 'EXPIRED';
  /** When the counter was revoked, or when its credential expired. */
  since: string;
};

/** Every block of this branch with numbers a revoked or expired counter can no longer print. */
export async function receiptNumberGaps(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  now: Date
): Promise<ReceiptNumberGap[]> {
  const devices = await db.pharmacyRegisteredDevice.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      kind: 'PHARMACY_COUNTER',
      OR: [{ status: 'REVOKED' }, { revokedAt: { not: null } }, { secretExpiresAt: { lte: now } }],
    },
    select: { id: true, name: true, status: true, revokedAt: true, secretExpiresAt: true },
    take: 500,
  });
  if (!devices.length) return [];
  const byId = new Map(devices.map((device) => [device.id, device]));
  const leases = await db.pharmacyReceiptNumberLease.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      deviceId: { in: devices.map((device) => device.id) },
    },
    select: { id: true, deviceId: true, blockStart: true, blockEnd: true, nextNumber: true },
    orderBy: [{ blockStart: 'asc' }],
  });
  return leases
    .filter((lease) => lease.nextNumber <= lease.blockEnd)
    .map((lease) => {
      const device = byId.get(lease.deviceId)!;
      const revoked = device.status === 'REVOKED' || device.revokedAt !== null;
      return {
        deviceId: device.id,
        deviceName: device.name,
        leaseId: lease.id,
        blockStart: lease.blockStart,
        blockEnd: lease.blockEnd,
        firstUnused: lease.nextNumber,
        lastUnused: lease.blockEnd,
        unused: lease.blockEnd - lease.nextNumber + 1,
        cause: revoked ? ('REVOKED' as const) : ('EXPIRED' as const),
        since: (revoked
          ? (device.revokedAt ?? device.secretExpiresAt)
          : device.secretExpiresAt
        ).toISOString(),
      };
    });
}

const safety = z
  .object({
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    recallVersion: z.number().int().nonnegative(),
    licenceVersion: z.number().int().nonnegative(),
    ruleVersion: z.number().int().nonnegative(),
    recalledBatchIds: z.array(id),
  })
  .strict();
const kind = z.enum([
  'CATALOG',
  'PRICES',
  'TAX',
  'RULES',
  'LICENCE',
  'STAFF',
  'LOT_BALANCES',
  'CUSTOMER_CREDIT',
]);
const envelope = z
  .object({
    organizationId: id,
    branchId: id,
    deviceId: id,
    kind,
    version: z.number().int().positive(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    safetyLease: safety,
    signingKeyId: id,
  })
  .strict();
const signedSnapshot = z
  .object({ id: id.optional(), envelope, signature: z.string().min(1).max(200), payload: z.json() })
  .strict();
const leasedReceipt = z
  .object({
    leaseId: id,
    receiptNumber: z.number().int().positive(),
    originalSaleAt: z.iso.datetime(),
    envelope,
    signature: z.string().min(1).max(200),
  })
  .strict();
export const counterReplaySchema = z
  .object({
    sequence: z.number().int().positive(),
    idempotencyKey: id,
    action: z.enum(['CASH_OTC_SALE', 'CONTROLLED_MEDICINE_SALE', 'MANUAL_OTC_SALE']),
    leasedReceipt,
    snapshots: z.array(signedSnapshot).max(8),
    lines: z
      .array(
        z
          .object({
            medicineId: id,
            presentationId: id,
            packLevelId: id,
            saleUnit: z.enum(['PACK', 'STRIP', 'UNIT']),
            quantity: z.number().int().positive().max(1000),
            canonicalUnitsPerSaleUnit: z.number().int().positive().max(10000),
            inventoryLotId: id,
            stockLocationId: id,
          })
          .strict()
      )
      .min(1)
      .max(50),
    amountMinor: z.number().int().positive().safe(),
    cashReceivedMinor: z.number().int().positive().safe().optional(),
    manualCapture: manualTenderCaptureSchema.optional(),
    // DEV-957 phase 2 (hardening 4): the seal the counter signed at the moment of sale,
    // chaining this sale to the one before it (offline-sale-seal.ts).
    seal: z
      .object({
        previousHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
        lineTotalsMinor: z.array(z.number().int().nonnegative().safe()).min(1).max(50),
        signature: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.action === 'MANUAL_OTC_SALE'
        ? value.manualCapture !== undefined && value.cashReceivedMinor === undefined
        : value.manualCapture === undefined && value.cashReceivedMinor !== undefined,
    'Manual sales require merchant capture; cash sales require cash received.'
  );
export type CounterReplay = z.infer<typeof counterReplaySchema>;
const counterRejectSchema = z
  .object({ command: counterReplaySchema, reason: z.string().trim().min(1).max(500) })
  .strict();
export type PharmacyCounterContext = {
  db: ScopedDb;
  scope: LedgerScope;
  deviceId: string;
  deviceSecret: string;
};

/** #519: true when any lot on the command was recalled per a signed lease the
 * counter carried, or is recalled (or not visible in this branch) on the server. */
export async function replayLotsRecalled(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  command: Pick<CounterReplay, 'lines' | 'snapshots' | 'leasedReceipt'>
): Promise<boolean> {
  const leaseRecalled = new Set(
    [
      ...command.snapshots.map((snapshot) => snapshot.envelope),
      command.leasedReceipt.envelope,
    ].flatMap((envelope) => envelope.safetyLease.recalledBatchIds)
  );
  const lotIds = [...new Set(command.lines.map((line) => line.inventoryLotId))];
  if (lotIds.some((lotId) => leaseRecalled.has(lotId))) return true;
  const lots = await db.pharmacyInventoryLot.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: { in: lotIds } },
    select: { id: true, batch: { select: { state: true } } },
  });
  const state = new Map(lots.map((lot) => [lot.id, lot.batch.state]));
  return lotIds.some((lotId) => {
    const batchState = state.get(lotId);
    return batchState === undefined || batchState === 'RECALLED';
  });
}

/**
 * Review round 2: the RULES payload a sale carries, only when its envelope is signed by
 * this server, names this counter, was in its window when the sale was taken and hashes
 * to that payload. Null otherwise.
 */
function verifiedRulesPayload(
  command: CounterReplay,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  deviceId: string
): unknown {
  const rules = command.snapshots.find((snapshot) => snapshot.envelope.kind === 'RULES');
  if (!rules) return null;
  const ok =
    verifySnapshotSignature(rules.envelope, rules.signature) &&
    checkEnvelope({
      envelope: rules.envelope,
      scope: { organizationId: scope.organizationId, branchId: scope.branchId, deviceId },
      nowMs: Date.parse(command.leasedReceipt.originalSaleAt),
      heldVersion: null,
      payloadHash: snapshotPayloadHash(rules.payload),
    }).ok;
  return ok ? rules.payload : null;
}

/**
 * DEV-957 phase 2 (hardening 4): a sale whose seal does not check out, or that does not
 * follow on from the sale the server last recorded for this counter. Refused, and the
 * route records why in its own transaction (the refused one rolls back).
 */
class CounterChainError extends CounterTransportError {
  constructor(
    readonly reason: ChainRefusal | 'bad_seal',
    readonly report: {
      organizationId: string;
      branchId: string;
      actorId: string;
      deviceId: string;
      sequence: number;
      receiptNumber: number;
    }
  ) {
    super('offline_chain_broken', 409);
  }
}

/**
 * Check the seal the counter signed at the moment of sale, then the chain: this sale must
 * follow directly on the sale with the highest sequence the server holds for this counter
 * and name that sale's seal hash. A changed, dropped, inserted or reordered sale fails here.
 */
export async function verifyOfflineSaleChain(
  ctx: PharmacyCounterContext,
  command: CounterReplay
): Promise<void> {
  const { db, scope, deviceId, deviceSecret } = ctx;
  const sealScope = { organizationId: scope.organizationId, branchId: scope.branchId, deviceId };
  const report = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    actorId: scope.actorId,
    deviceId,
    sequence: command.sequence,
    receiptNumber: command.leasedReceipt.receiptNumber,
  };
  if (
    !sealLineTotalsValid(command, command.seal.lineTotalsMinor) ||
    !offlineSaleSealValid(sealScope, command, command.seal, deviceSecret)
  )
    throw new CounterChainError('bad_seal', report);
  const previous = await db.pharmacyOfflineCommand.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      deviceId,
      sequence: { lt: command.sequence },
    },
    orderBy: { sequence: 'desc' },
    select: { sequence: true, payload: true },
  });
  let previousHash: string | null = null;
  if (previous) {
    const parsed = counterReplaySchema.safeParse(previous.payload);
    previousHash = parsed.success ? recordedSaleSealHash(sealScope, parsed.data) : null;
  }
  const refusal = chainRefusal(
    { sequence: command.sequence, previousHash: command.seal.previousHash },
    previous ? { sequence: previous.sequence, hash: previousHash } : null
  );
  if (refusal) throw new CounterChainError(refusal, report);
}

/** Called only inside the transport-owned tenant transaction; never catches a
 * business failure here, because a returned response would commit partial work. */
export async function replayCounterCommand(
  ctx: PharmacyCounterContext,
  command: CounterReplay,
  signature: string,
  receiptSignature: string
) {
  const { db, scope, deviceId, deviceSecret } = ctx;
  // Take the exclusive lock before authentication's shared lock: concurrent
  // retries must not both hold SHARE and then deadlock upgrading to UPDATE.
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_registered_devices WHERE id=${deviceId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
  );
  await authenticatePharmacyCommand(db, scope, deviceId, command, { deviceSecret, signature });
  await authenticatePharmacyCommand(db, scope, deviceId, command.leasedReceipt, {
    deviceSecret,
    signature: receiptSignature,
  });
  validateLeasedReceiptReplay(scope, deviceId, command.leasedReceipt);
  const originalMs = Date.parse(command.leasedReceipt.originalSaleAt);
  const snapshots = command.snapshots.map((snapshot) => {
    if (
      !verifySnapshotSignature(snapshot.envelope, snapshot.signature) ||
      !checkEnvelope({
        envelope: snapshot.envelope,
        scope: { ...scope, deviceId },
        nowMs: originalMs,
        heldVersion: null,
        payloadHash: snapshotPayloadHash(snapshot.payload),
      }).ok ||
      !checkSafetyLease(
        {
          lease: snapshot.envelope.safetyLease,
          appliedRecallVersion: snapshot.envelope.safetyLease.recallVersion,
          recalledBatchIds: [],
        },
        originalMs
      ).ok
    )
      throw new CounterTransportError('invalid_snapshot', 403);
    return {
      kind: snapshot.envelope.kind,
      verified: true,
      expiresAtMs: Date.parse(snapshot.envelope.expiresAt),
    };
  });
  const recorded = await recordOfflineCommand(db, scope, {
    deviceId,
    sequence: command.sequence,
    idempotencyKey: command.idempotencyKey,
    action: command.action,
    payload: command as Prisma.InputJsonValue,
    clientOriginAt: new Date(command.leasedReceipt.originalSaleAt),
    receiptNumber: command.leasedReceipt.receiptNumber,
  });
  if (recorded.command.status === 'ACCEPTED') {
    // DEV-637: answer with the number the sale was issued, which differs from the printed
    // one when replay had to renumber it.
    const issued = recorded.command.serverRef
      ? await db.pharmacySale.findFirst({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            id: recorded.command.serverRef,
          },
          select: { receiptNumber: true, offlineReceiptReference: true },
        })
      : null;
    return {
      saleId: recorded.command.serverRef,
      receiptNumber: issued?.receiptNumber ?? recorded.command.receiptNumber,
      ...(issued?.offlineReceiptReference
        ? { offlineReference: issued.offlineReceiptReference }
        : {}),
      replayed: true,
    };
  }
  if (recorded.command.status !== 'PENDING')
    throw new CounterTransportError('command_rejected', 409);
  // DEV-957 phase 2 (hardening 4): the command log has already kept the FIFO order
  // (a skipped sequence is SEQUENCE_OUT_OF_ORDER); the seal proves this is the sale the
  // counter signed when it was taken, following on from the sale recorded before it.
  await verifyOfflineSaleChain(ctx, command);
  // Review round 2: the switch is enforced here, not only at the counter. A sale is
  // accepted only when the RULES it carries (verified above) say offline cash selling
  // was on when the counter was handed them.
  if (
    !signedRulesAllowOfflineSelling(verifiedRulesPayload(command, scope, deviceId)) ||
    !(await readOfflineCashSelling(db, scope.organizationId)).enabled
  )
    throw new CounterTransportError('offline_selling_off', 409);
  // #519: recall state is derived, never assumed. A lot the signed lease told
  // the counter was recalled, or one the server holds as recalled (or cannot
  // see) now, refuses the sale. Checked after the ACCEPTED short-circuit so a
  // retry of a sale already accepted still returns its result.
  const requestedUnits = command.lines.reduce(
    (n, line) => n + line.quantity * line.canonicalUnitsPerSaleUnit,
    0
  );
  authorizeReplayedCommand(command.action, {
    nowMs: originalMs,
    snapshots,
    receiptNumbersRemaining: 1,
    quotaUnitsAvailable: requestedUnits,
    requestedUnits,
    requestedCreditMinor: 0,
    cachedCreditRemainingMinor: 0,
    controlledMedicinesPermittedOffline: false,
    originalSaleAvailable: false,
    deviceUsable: true,
    medicineSale: true,
    // Every carried lease passed checkSafetyLease above; none carried is not ok.
    safetyLeaseOk: snapshots.length > 0,
    batchRecalled: await replayLotsRecalled(db, scope, command),
  });
  if (command.action === 'MANUAL_OTC_SALE') {
    const rules = command.snapshots.find((snapshot) => snapshot.envelope.kind === 'RULES')?.payload;
    const settings =
      rules && typeof rules === 'object' && !Array.isArray(rules)
        ? rules.manualMerchantPolicies
        : undefined;
    try {
      validateManualTenderPolicy(settings, command.manualCapture);
    } catch {
      throw new CounterTransportError('invalid_manual_capture', 409);
    }
    // applyPharmacyTender additionally checks current branch policy under lock.
  }
  const earlier = await db.pharmacyOfflineCommand.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      deviceId,
      status: 'PENDING',
      sequence: { lt: command.sequence },
    },
    select: { id: true },
  });
  if (earlier) throw new CounterTransportError('earlier_command_pending', 409);
  // The sale books on the shop's day of its own signed sale time, on the organisation's
  // stored clock (never a zone the device sends): 00:30 in Karachi is that day, not the
  // UTC day before. An organisation on UTC, or with no usable zone, keeps the UTC date.
  // Only a PENDING command reaches here, so a sale already replayed is never moved.
  // DEV-958A: on the branch's clock, whose day ends at its "day ends at" hour, so a sale
  // signed at 00:30 at a branch whose day ends at 05:00 books on the day before.
  const businessDate = pharmacyBusinessDate(
    await readPharmacyDayClock(db, scope),
    new Date(command.leasedReceipt.originalSaleAt)
  );
  // DEV-631: take the sale's day lock before any stock lock, the same order the online
  // counter uses (day, then stock), so a replay and a counter line cannot deadlock.
  // The tender below re-enters this lock and still refuses a closed day.
  await lockPharmacyDay(db, scope, businessDate);
  // addSaleLine re-enters these request locks after the command's stock locks.
  // Hold every line key up front so a concurrent online retry cannot invert that order.
  for (let index = 0; index < command.lines.length; index += 1)
    await lockSaleLineKey(db, scope, `${command.idempotencyKey}:${index}`);
  const sale = await createSale(db, scope);
  // DEV-825: one transaction adds every line and then tenders, so take the stock
  // locks for all of them up front in the global order (stock-lock-order.ts):
  // the batches the tender's safety check shares, then every candidate balance.
  // The per-line allocation and the tender then only re-enter held locks.
  await lockStockRowsFrom(
    db,
    scope.organizationId,
    Prisma.sql`SELECT lot."manufacturingBatchId" AS "batchId" FROM pharmacy_inventory_lots lot
      WHERE lot."organizationId" = ${scope.organizationId}
        AND lot.id IN (${Prisma.join(command.lines.map((line) => line.inventoryLotId))})`,
    { batch: 'share' }
  );
  await lockSaleCandidates(db, scope, [...new Set(command.lines.map((line) => line.medicineId))]);
  // DEV-830: a pack level revised after the signed sale must not refuse that sale.
  const saleUnitAt = new Date(command.leasedReceipt.originalSaleAt);
  for (const [index, line] of command.lines.entries()) {
    const medicine = await db.medicine.findFirst({
      where: { id: line.medicineId, organizationId: scope.organizationId },
      select: { controlled: true, rx: true, restricted: true, highAlert: true, lasa: true },
    });
    // DEV-957: the replay refuses exactly what the signed catalogue leaves out.
    if (
      !medicine ||
      medicine.controlled ||
      medicine.rx ||
      medicine.restricted ||
      medicine.highAlert ||
      medicine.lasa
    )
      throw new CounterTransportError('medicine_not_offline_otc', 403);
    const pack = await db.packLevel.findFirst({
      where: {
        id: line.packLevelId,
        organizationId: scope.organizationId,
        presentationId: line.presentationId,
      },
      select: { id: true },
    });
    const presentation = await db.presentation.findFirst({
      where: {
        id: line.presentationId,
        organizationId: scope.organizationId,
        medicineId: line.medicineId,
      },
      select: { id: true },
    });
    if (!pack || !presentation) throw new CounterTransportError('invalid_pack', 403);
    // DEV-830 (F05): the signed device never chooses the multiplier; it is checked
    // against the stored pack setup before any quota or stock is consumed.
    try {
      await assertSaleUnitConversion(db, scope, line, saleUnitAt);
    } catch (error) {
      if (error instanceof PharmacySaleError) throw new CounterTransportError('invalid_pack', 403);
      throw error;
    }
    const units = line.quantity * line.canonicalUnitsPerSaleUnit;
    const quota = await openDeviceLotQuota(db, scope, { ...line, deviceId });
    if (!quota || quota.quotaUnits - quota.consumedUnits < units)
      throw new CounterTransportError('quota_exhausted', 409);
    await consumeDeviceLotQuota(db, scope, { ...line, deviceId, units });
    const created = await addSaleLine(
      db,
      scope,
      { ...line, saleId: sale.id, idempotencyKey: `${command.idempotencyKey}:${index}` },
      { saleUnitAt }
    );
    const allocations = await db.pharmacySaleLineAllocation.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        saleLineId: created.line.id,
      },
    });
    if (
      allocations.some(
        (a) =>
          a.inventoryLotId !== line.inventoryLotId || a.stockLocationId !== line.stockLocationId
      )
    )
      throw new CounterTransportError('offline_lot_changed', 409);
  }
  const result = await applyPharmacyTender(
    db,
    scope,
    {
      saleId: sale.id,
      deviceId,
      businessDate,
      type: command.manualCapture?.type ?? 'CASH',
      amountMinor: command.amountMinor,
      cashReceivedMinor: command.cashReceivedMinor,
      ...(command.manualCapture
        ? {
            providerRef: command.manualCapture.providerRef,
            payerName: command.manualCapture.payerName,
            referenceSkipped: command.manualCapture.referenceSkipped,
          }
        : {}),
      idempotencyKey: command.idempotencyKey,
      leasedReceipt: command.leasedReceipt,
    },
    { deviceSecret, signature: receiptSignature },
    // DEV-821: an enrolled counter replays a sale it took offline into its own drawer;
    // the device is authenticated by its secret and the signed command above.
    { drawerOperator: { kind: 'REGISTERED_DEVICE_REPLAY' } }
  );
  if (!('settled' in result) || !result.settled)
    throw new CounterTransportError('offline_total_changed', 409);
  await settleOfflineCommand(
    db,
    scope,
    {
      commandId: recorded.command.id,
      outcome: 'ACCEPTED',
      serverRef: sale.id,
      // The command log keeps the number the counter printed.
      receiptNumber: command.leasedReceipt.receiptNumber,
    },
    new Date()
  );
  // DEV-637: a number printed from a block leased before branch-wide numbering may have
  // been replaced by a fresh branch number; the printed one is kept as the reference.
  const issued =
    'receiptNumber' in result && typeof result.receiptNumber === 'number'
      ? result.receiptNumber
      : command.leasedReceipt.receiptNumber;
  return {
    saleId: sale.id,
    receiptNumber: issued,
    ...(issued !== command.leasedReceipt.receiptNumber
      ? { offlineReference: command.leasedReceipt.receiptNumber }
      : {}),
    replayed: false,
  };
}

export type CounterOperation =
  'establish' | 'approval-proof' | 'snapshot' | 'replay' | 'lease' | 'quota' | 'reject' | 'renew';

/** DEV-957 phase 2: what an expired device secret may no longer be used for. */
const EXTENDS_OFFLINE_SELLING: ReadonlySet<CounterOperation> = new Set([
  'snapshot',
  'approval-proof',
  'lease',
  'quota',
]);

/** Live web actor plus enrolled device, with an actor/device-bound terminal
 * token after establishment. Errors are mapped only outside the transaction. */
type CounterAuditEntry = {
  action: string;
  operation: 'CREATE' | 'UPDATE' | 'EXECUTE';
  targetType: string;
  targetId: string | null;
  metadata: Record<string, string | number | boolean | null>;
};

/** Filled in by the counter route once the actor, branch and terminal are verified. */
type CounterAuditTarget = {
  scope?: { organizationId: string; branchId: string; actorId: string };
  deviceId?: string;
};

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function scalar(value: unknown): string | number | boolean | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : null;
}

/** The signed RULES payload a replayed command carried (verified before any audit is written). */
function rulesPayload(body: unknown): unknown {
  const snapshots = field(body, 'snapshots');
  if (!Array.isArray(snapshots)) return null;
  return field(
    snapshots.find((snapshot) => field(field(snapshot, 'envelope'), 'kind') === 'RULES'),
    'payload'
  );
}

/** The cashier the signed RULES named (DEV-957 phase 2), or null for an older price list. */
function offlineOperator(body: unknown): string | null {
  return text(field(field(rulesPayload(body), 'operator'), 'userId'));
}

function text(value: unknown): string | null {
  const found = scalar(value);
  return found === null ? null : String(found);
}

/**
 * DEV-913: what the audit log records for a successful counter operation, or
 * null when nothing new happened (a replay of a sale that was already posted).
 * Only identifiers and counts are kept: never the device secret, the terminal
 * session token, signatures or signed payloads.
 */
export function counterAuditEntry(
  operation: Exclude<CounterOperation, 'reject'>,
  body: unknown,
  outcome: unknown
): CounterAuditEntry | null {
  switch (operation) {
    case 'approval-proof':
      return {
        action: 'issueCounterApprovalProof',
        operation: 'EXECUTE',
        targetType: 'PharmacyRegisteredDevice',
        targetId: text(field(outcome, 'deviceId')),
        metadata: {},
      };
    case 'establish':
      return {
        action: 'openCounterSession',
        operation: 'EXECUTE',
        targetType: 'PharmacyRegisteredDevice',
        targetId: text(field(field(outcome, 'device'), 'id')),
        metadata: {},
      };
    case 'lease':
      return {
        action: 'reserveReceiptNumbers',
        operation: 'CREATE',
        targetType: 'PharmacyReceiptNumberLease',
        targetId: text(field(outcome, 'id')),
        metadata: { size: scalar(field(body, 'size')) },
      };
    case 'quota':
      return {
        action: 'grantOfflineLotQuota',
        operation: 'UPDATE',
        targetType: 'PharmacyInventoryLot',
        targetId: text(field(body, 'inventoryLotId')),
        metadata: {
          stockLocationId: scalar(field(body, 'stockLocationId')),
          units: scalar(field(body, 'units')),
        },
      };
    case 'renew':
      // Never the new secret: only when it now expires.
      return {
        action: 'renewCounterCredential',
        operation: 'UPDATE',
        targetType: 'PharmacyRegisteredDevice',
        targetId: text(field(field(outcome, 'device'), 'id')),
        metadata: { credentialExpiresAt: text(field(outcome, 'credentialExpiresAt')) },
      };
    case 'snapshot':
      return {
        action: 'issueOfflineSnapshot',
        operation: 'EXECUTE',
        targetType: 'PharmacyRegisteredDevice',
        targetId: null,
        metadata: {},
      };
    case 'replay':
      if (field(outcome, 'replayed') === true) return null;
      return {
        action: 'replayOfflineSale',
        operation: 'CREATE',
        targetType: 'PharmacySale',
        targetId: text(field(outcome, 'saleId')),
        metadata: {
          receiptNumber: scalar(field(outcome, 'receiptNumber')),
          // DEV-637: the number printed offline, when replay had to renumber the sale.
          ...(scalar(field(outcome, 'offlineReference')) !== null
            ? { offlineReference: scalar(field(outcome, 'offlineReference')) }
            : {}),
          sequence: scalar(field(body, 'sequence')),
          commandAction: scalar(field(body, 'action')),
          // DEV-957 phase 2: the cashier signed in on the counter when it was handed its
          // price list (the signed RULES snapshot the sale carried), who served the sale
          // offline. The replay itself is by the person signed in now (actorId).
          ...(offlineOperator(body) !== null ? { offlineOperatorId: offlineOperator(body) } : {}),
        },
      };
  }
}

/**
 * DEV-913: every counter operation that changes money, stock or the receipt
 * runway leaves an entry naming the person, branch and terminal, written in the
 * same transaction as the change so neither commits without the other.
 * Recovery (`reject`) writes its own entry inside the work.
 */
function withCounterAudit<T>(
  operation: CounterOperation,
  request: Request,
  user: { name?: string | null; email?: string | null; role?: string | null },
  body: unknown,
  target: CounterAuditTarget,
  work: (db: ScopedDb) => Promise<T>
) {
  return async (db: ScopedDb): Promise<T> => {
    const outcome = await work(db);
    const entry = operation === 'reject' ? null : counterAuditEntry(operation, body, outcome);
    if (entry && target.scope) {
      await db.auditLog.create({
        data: {
          organizationId: target.scope.organizationId,
          actorId: target.scope.actorId,
          actorName: user.name ?? null,
          actorEmail: user.email ?? null,
          actorRole: user.role ?? null,
          source: 'REST_API',
          category: 'PHARMACY',
          operation: entry.operation,
          action: `pharmacyOffline.${entry.action}`,
          targetType: entry.targetType,
          targetId: entry.targetId,
          httpMethod: 'POST',
          path: new URL(request.url).pathname,
          ip: clientIp(request),
          userAgent: request.headers.get('user-agent'),
          metadata: {
            branchId: target.scope.branchId,
            deviceId: target.deviceId ?? null,
            ...entry.metadata,
          },
        },
      });
    }
    return outcome;
  };
}

/**
 * DEV-957 phase 2 (hardening 4): a broken chain is refused AND recorded. The refused
 * transaction rolled back, so the record is written in a transaction of its own. Only
 * identifiers: never the sale, its seal or any credential.
 */
async function reportChainBreak(operation: CounterOperation, error: CounterChainError) {
  const { report } = error;
  try {
    await withTenantDb(report.organizationId, (db) =>
      db.auditLog.create({
        data: {
          organizationId: report.organizationId,
          actorId: report.actorId,
          source: 'REST_API',
          category: 'PHARMACY',
          operation: 'EXECUTE',
          action: 'pharmacyOffline.offlineSaleChainBroken',
          targetType: 'PharmacyRegisteredDevice',
          targetId: report.deviceId,
          metadata: {
            branchId: report.branchId,
            deviceId: report.deviceId,
            sequence: report.sequence,
            receiptNumber: report.receiptNumber,
            reason: error.reason,
            commandOperation: operation,
          },
        },
      })
    );
  } catch {
    // The refusal stands even when the record cannot be written.
  }
}

export function pharmacyCounterRoute(operation: CounterOperation) {
  return async (request: Request): Promise<Response> => {
    try {
      if (!(await rateLimit(`pharmacy-counter:${clientIp(request)}`, 120, 60_000)).ok)
        throw new CounterTransportError('rate_limited', 429);
      const origin = request.headers.get('origin');
      // DEV-957: a browser on the public host (behind a proxy, or `next start`
      // reporting its bind address in request.url) is this site too; any other
      // Origin is still refused, as before.
      if (origin && origin !== new URL(request.url).origin && !exactSameOrigin(request))
        throw new CounterTransportError('origin_denied', 403);
      const actor = await resolveTenantActor({ request });
      if (!actor || actor.support) throw new CounterTransportError('unauthorized', 401);
      // DEV-957: an enrolled browser sends its credential in the httpOnly cookie;
      // tools and tests keep the bearer header. Never both, and the cookie only
      // with this site's exact Origin, so another site cannot ride on it.
      const credential = counterDeviceCredential(request);
      if (!credential.ok) throw new CounterTransportError('unauthorized_device', 401);
      if (credential.cookie && !cookieCredentialAllowed(request))
        throw new CounterTransportError('origin_denied', 403);
      const secret = credential.secret;
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 256_000) throw new CounterTransportError('body_too_large', 413);
      const body: unknown = JSON.parse(raw || '{}');
      const audit: CounterAuditTarget = {};
      const counterWork = async (db: ScopedDb) => {
        if (
          !hasModule(
            await resolveOrganizationEntitlements(actor.organization.id, db),
            'pharmacy-counter'
          )
        )
          throw new CounterTransportError('module_disabled', 403);
        const allows = (action: 'admin:access' | 'pharmacy:orders') =>
          can(subjectFromSession(actor.session.user), action, undefined, {
            db,
            source: 'REST',
            ip: clientIp(request),
          });
        // DEV-767: a manager leases on `admin:access`; a cashier may still renew
        // their own terminal's receipt runway through the counter operator gate
        // below (live counter grant and assignment to this terminal's branch),
        // capped at one renewal block. Quota and reject stay manager-only.
        const leasingManager = operation === 'lease' && (await allows('admin:access'));
        const manager = leasingManager || operation === 'quota' || operation === 'reject';
        if (!leasingManager && !(await allows(manager ? 'admin:access' : 'pharmacy:orders')))
          throw new CounterTransportError('forbidden', 403);
        const device = await resolvePharmacyCounterBySecret(db, secret);
        if (!device) throw new CounterTransportError('unauthorized_device', 401);
        // DEV-957 phase 2: a counter revoked from another computer is told so in so many
        // words, so it can wipe its local store (only a confirmed revocation purges).
        if (device.status !== 'ACTIVE' || device.revokedAt)
          throw new CounterTransportError('device_revoked', 401);
        // An expired secret can still open a session and replay what it signed while it was
        // valid, but it is handed no new price list, receipt block or stock to sell offline.
        const credentialExpired = pharmacyDeviceSecretExpired(device, new Date());
        if (credentialExpired && (EXTENDS_OFFLINE_SELLING.has(operation) || operation === 'renew'))
          throw new CounterTransportError('device_credential_expired', 401);
        const ctx = {
          db,
          scope: {
            organizationId: actor.organization.id,
            branchId: device.branchId,
            actorId: actor.session.user.id,
          },
          deviceId: device.id,
          deviceSecret: secret,
        };
        await activeBranch(db, ctx.scope.organizationId, ctx.scope.branchId);
        audit.scope = ctx.scope;
        audit.deviceId = device.id;
        // DEV-831: an enrolled terminal does not lend its branch to the actor.
        // Establishment, snapshots and replay take the online counter's live
        // grant and branch-assignment gate before any token, snapshot or sale.
        if (!manager) {
          const denial = await counterOperatorDenial(
            db,
            actor.session.user,
            ctx.scope.organizationId,
            ctx.scope.branchId,
            { source: 'REST', ip: clientIp(request) }
          );
          if (denial) throw new CounterTransportError(denial, 403);
        } else {
          // DEV-850: lease, quota and reject act on this terminal's branch, so a
          // manager must also be assigned to it (admins span the organization).
          const denial = await counterBranchAssignmentDenial(
            db,
            actor.session.user,
            ctx.scope.organizationId,
            ctx.scope.branchId
          );
          if (denial) throw new CounterTransportError(denial, 403);
        }
        if (operation === 'establish') {
          z.object({}).strict().parse(body);
          return {
            sessionToken: establishToken(ctx),
            device: {
              id: device.id,
              branchId: device.branchId,
              organizationId: device.organizationId,
            },
            snapshotPublicKey: snapshotPublicKey(),
            credential: {
              expiresAt: device.secretExpiresAt.toISOString(),
              expired: credentialExpired,
              renewDue: pharmacyDeviceSecretDueForRenewal(device, new Date()),
            },
          };
        }
        const sessionToken = request.headers.get('x-terminal-session') ?? '';
        verifyToken(sessionToken, {
          ...ctx,
          credentialHash: hashDeviceSecret(ctx.deviceSecret),
        });
        if (operation === 'approval-proof') {
          z.object({}).strict().parse(body);
          return { deviceId: device.id, proof: issueApprovalDeviceProof(sessionToken) };
        }
        if (operation === 'renew') {
          // DEV-957 phase 2: the counter rotates its own secret while it is still valid.
          // The new secret goes back once, for this browser's non-extractable signing key
          // and (on the cookie path) its httpOnly cookie; the old one stops working here.
          z.object({}).strict().parse(body);
          const now = new Date();
          const rotated = await rotatePharmacyCounterSecret(
            db,
            ctx.scope,
            device.id,
            device.deviceSecretHash,
            { now, requireUnexpired: true }
          ).catch((error: unknown) => {
            if (error instanceof PharmacyDeviceError)
              throw new CounterTransportError(
                error.reason === 'EXPIRED' ? 'device_credential_expired' : 'device_revoked',
                401
              );
            throw error;
          });
          return {
            device: { id: rotated.device.id },
            secret: rotated.secret,
            credentialExpiresAt: rotated.device.secretExpiresAt.toISOString(),
          };
        }
        if (operation === 'lease') {
          const input = z
            .object({
              size: z
                .number()
                .int()
                .positive()
                .max(manager ? MAX_RECEIPT_LEASE_SIZE : COUNTER_LEASE_RENEWAL_SIZE),
            })
            .strict()
            .parse(body);
          return reserveReceiptNumberBlock(db, ctx.scope, {
            deviceId: device.id,
            size: input.size,
          });
        }
        if (operation === 'quota') {
          const input = z
            .object({
              inventoryLotId: id,
              stockLocationId: id,
              units: z.number().int().positive().max(100000),
            })
            .strict()
            .parse(body);
          // Review round 2: no stock is set aside while offline cash selling is off.
          if (!(await counterSetAsidesInForce(db, ctx.scope.organizationId)))
            throw new CounterTransportError('offline_selling_off', 409);
          return grantDeviceLotQuota(db, ctx.scope, { ...input, deviceId: device.id });
        }
        if (operation === 'snapshot') {
          z.object({}).strict().parse(body);
          // Serialize version allocation with replay and other snapshot requests.
          await db.$queryRaw(
            Prisma.sql`SELECT id FROM pharmacy_registered_devices WHERE id=${device.id} AND "organizationId"=${ctx.scope.organizationId} FOR UPDATE`
          );
          const lots = await db.pharmacyInventoryLot.findMany({
            where: { organizationId: ctx.scope.organizationId, branchId: device.branchId },
            select: {
              id: true,
              manufacturingBatchId: true,
              packLevelId: true,
              unitsPerPack: true,
              printedMrpMinor: true,
              receivedExpiresAt: true,
              batch: { select: { batchNumber: true } },
            },
            take: 1000,
            orderBy: { id: 'asc' },
          });
          // DEV-957 phase 2: the counter prices an offline line exactly as addSaleLine does
          // (priceFromLot with the lot's own MED-08 rounding increment), so each signed lot
          // carries that increment.
          const mrpRules = lots.length
            ? await db.medicinePackMrp.findMany({
                where: {
                  organizationId: ctx.scope.organizationId,
                  OR: lots.flatMap((lot) =>
                    lot.batch.batchNumber === null
                      ? []
                      : [{ packLevelId: lot.packLevelId, batchReference: lot.batch.batchNumber }]
                  ),
                },
                select: { packLevelId: true, batchReference: true, roundingIncrementMinor: true },
              })
            : [];
          const pricedLots = lots.map(({ batch, ...lot }) => ({
            ...lot,
            // Printed on the offline receipt, as online.
            batchNumber: batch.batchNumber,
            roundingIncrementMinor: mrpRoundingIncrementForLot(mrpRules, {
              packLevelId: lot.packLevelId,
              batchNumber: batch.batchNumber,
            }),
          }));
          // #519: every recalled lot in this branch, uncapped by the catalogue
          // limit, so the counter blocks it offline under the signed lease.
          const recalledLots = await db.pharmacyInventoryLot.findMany({
            where: {
              organizationId: ctx.scope.organizationId,
              branchId: device.branchId,
              batch: { state: 'RECALLED' },
            },
            select: { id: true },
            orderBy: { id: 'asc' },
          });
          const catalog = await db.medicine.findMany({
            where: {
              organizationId: ctx.scope.organizationId,
              saleable: true,
              rx: false,
              controlled: false,
              restricted: false,
              // DEV-957: as the online barcode cache (counter-catalogue-cache.ts),
              // high-alert and look-alike sound-alike medicines need the online
              // counter's checks, so they are never signed for offline selling.
              highAlert: false,
              lasa: false,
            },
            select: {
              id: true,
              productName: true,
              presentations: {
                select: { id: true, presentation: true, dosageForm: true, packLevels: true },
              },
            },
            take: 1000,
            orderBy: { id: 'asc' },
          });
          const quotas = await db.pharmacyDeviceLotQuota.findMany({
            where: {
              organizationId: ctx.scope.organizationId,
              branchId: device.branchId,
              deviceId: device.id,
              releasedAt: null,
            },
            select: {
              inventoryLotId: true,
              stockLocationId: true,
              quotaUnits: true,
              consumedUnits: true,
            },
          });
          const taxes = await db.pharmacyTaxProfileVersion.findMany({
            where: {
              organizationId: ctx.scope.organizationId,
              branchId: device.branchId,
              status: 'PUBLISHED',
            },
            include: { rules: true },
            take: 20,
          });
          const now = new Date();
          const expiry = new Date(now.getTime() + 8 * 60 * 60 * 1000);
          const safetyLease = {
            issuedAt: now.toISOString(),
            expiresAt: expiry.toISOString(),
            recallVersion: 0,
            licenceVersion: 0,
            ruleVersion: 0,
            recalledBatchIds: recalledLots.map((lot) => lot.id),
          };
          const merchant = await readManualPaymentSettings(db, ctx.scope);
          // DEV-957 phase 2 (review B1): the owner's offline cash selling switch, signed into
          // the rules. Off (and not available) in this phase, so a counter checks prices only.
          const cashSelling = await readOfflineCashSelling(db, ctx.scope.organizationId);
          const branchName = await db.pharmacyBranch.findFirst({
            where: { id: device.branchId, organizationId: ctx.scope.organizationId },
            select: { name: true },
          });
          const payloads = {
            CATALOG: catalog,
            PRICES: pricedLots,
            TAX: taxes,
            RULES: {
              controlledMedicinesPermittedOffline: false,
              rxPermittedOffline: false,
              manualMerchantPolicies: manualMerchantPolicies(merchant.settings),
              manualMerchantRevision: merchant.revision,
              // DEV-957 phase 2: who is signed in on this counter now. Sales it takes offline
              // under this list are attributed to them on the receipt and in the replay audit.
              operator: { userId: ctx.scope.actorId, name: actor.session.user.name ?? null },
              // The branch name the on-screen offline receipt shows.
              branchName: branchName?.name ?? null,
              // When the server stops issuing this counter new price lists.
              // (Never a key named like a credential: the counter's local store refuses those.)
              deviceAccessUntil: device.secretExpiresAt.toISOString(),
              offlineCashSelling: cashSelling.enabled,
            },
            LOT_BALANCES: quotas,
          };
          const snapshots = [];
          for (const snapshotKind of ['CATALOG', 'PRICES', 'TAX', 'RULES', 'LOT_BALANCES'] as const)
            snapshots.push(
              await issueOfflineSnapshot(db, ctx.scope, {
                deviceId: device.id,
                kind: snapshotKind,
                payload: JSON.parse(JSON.stringify(payloads[snapshotKind])),
                issuedAt: now,
                expiresAt: expiry,
                safetyLease,
              })
            );
          return { snapshots, publicKey: snapshotPublicKey(), catalogLimit: 1000 };
        }
        const rejection = operation === 'reject' ? counterRejectSchema.parse(body) : null;
        const command = rejection?.command ?? counterReplaySchema.parse(body);
        const key = request.headers.get('idempotency-key');
        if (!key || key !== command.idempotencyKey)
          throw new CounterTransportError('invalid_idempotency_key');
        if (rejection) {
          // Explicit manager recovery for a command whose failed sale rolled
          // back its log entry. Never skip a position or commit sale effects.
          // Use the same lock order as replay so a concurrent success cannot be
          // changed into a rejection, and authenticate the original command.
          await db.$queryRaw(
            Prisma.sql`SELECT id FROM pharmacy_registered_devices WHERE id=${device.id} AND "organizationId"=${ctx.scope.organizationId} AND "branchId"=${ctx.scope.branchId} FOR UPDATE`
          );
          await authenticatePharmacyCommand(db, ctx.scope, device.id, command, {
            deviceSecret: secret,
            signature: request.headers.get('x-command-signature') ?? '',
          });
          const recorded = await recordOfflineCommand(db, ctx.scope, {
            deviceId: device.id,
            sequence: command.sequence,
            idempotencyKey: command.idempotencyKey,
            action: command.action,
            payload: command as Prisma.InputJsonValue,
            clientOriginAt: new Date(command.leasedReceipt.originalSaleAt),
            receiptNumber: command.leasedReceipt.receiptNumber,
          });
          if (recorded.command.status === 'REJECTED')
            return { commandId: recorded.command.id, status: 'REJECTED', replayed: true };
          if (recorded.command.status !== 'PENDING')
            throw new CounterTransportError('command_already_settled', 409);
          // A rejected sale still takes its place in the chain, so it must belong there.
          await verifyOfflineSaleChain(
            { db, scope: ctx.scope, deviceId: device.id, deviceSecret: secret },
            command
          );
          // The receipt was already printed. Retire exactly the next number
          // under the same lease checks as settlement, so recovery preserves
          // the remaining printed receipts and never makes this one reusable.
          const { leaseId, receiptNumber, originalSaleAt } = command.leasedReceipt;
          const retired = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            UPDATE pharmacy_receipt_number_leases AS lease
            SET "nextNumber" = ${receiptNumber} + 1
            WHERE lease.id = ${leaseId}
              AND lease."organizationId" = ${ctx.scope.organizationId}
              AND lease."branchId" = ${ctx.scope.branchId}
              AND lease."deviceId" = ${device.id}
              AND lease."nextNumber" = ${receiptNumber}
              AND ${receiptNumber} BETWEEN lease."blockStart" AND lease."blockEnd"
              AND lease."issuedAt" <= ${new Date(originalSaleAt)}
            RETURNING lease.id`);
          if (!retired[0]) throw new CounterTransportError('INVALID_RECEIPT_LEASE', 409);
          // Review round 2: nor can a sale taken while offline selling was off be settled
          // this way: only one its verified signed RULES allowed (the receipt checks above
          // run first, and a refusal here rolls the retirement back).
          if (!signedRulesAllowOfflineSelling(verifiedRulesPayload(command, ctx.scope, device.id)))
            throw new CounterTransportError('offline_selling_off', 409);
          await settleOfflineCommand(
            db,
            ctx.scope,
            { commandId: recorded.command.id, outcome: 'REJECTED', reason: rejection.reason },
            new Date()
          );
          // Recovery and its audit must commit together. Do not copy the signed
          // payload, snapshots or credentials into the audit record.
          await db.auditLog.create({
            data: {
              organizationId: ctx.scope.organizationId,
              actorId: ctx.scope.actorId,
              source: 'REST_API',
              category: 'PHARMACY',
              operation: 'UPDATE',
              action: 'pharmacyOffline.rejectCommand',
              targetType: 'PharmacyOfflineCommand',
              targetId: recorded.command.id,
              metadata: {
                branchId: ctx.scope.branchId,
                deviceId: device.id,
                sequence: command.sequence,
                reason: rejection.reason,
              },
            },
          });
          return { commandId: recorded.command.id, status: 'REJECTED', replayed: false };
        }
        return replayCounterCommand(
          ctx,
          command,
          request.headers.get('x-command-signature') ?? '',
          request.headers.get('x-receipt-signature') ?? ''
        );
      };
      const result = await withTenantDb(
        actor.organization.id,
        withCounterAudit(operation, request, actor.session.user, body, audit, counterWork)
      );
      if (operation === 'renew') {
        const response = NextResponse.json(result, {
          status: 200,
          headers: { 'Cache-Control': 'no-store' },
        });
        // The browser's cookie follows the rotation; a bearer client keeps its own copy.
        if (credential.cookie)
          response.cookies.set(
            PHARMACY_COUNTER_DEVICE_COOKIE,
            (result as { secret: string }).secret,
            counterDeviceCookieOptions(request, PHARMACY_COUNTER_DEVICE_COOKIE_MAX_AGE)
          );
        return response;
      }
      return Response.json(result, {
        status: operation === 'establish' ? 201 : 200,
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      if (error instanceof CounterChainError) await reportChainBreak(operation, error);
      if (error instanceof CounterTransportError)
        return Response.json({ error: error.code }, { status: error.status });
      // DEV-877: the replay rolled back and its command stays PENDING; the
      // posting date is the server's replay time, whose period is closed.
      if (isAccountingPeriodClosedError(error))
        return Response.json({ error: 'PERIOD_CLOSED' }, { status: 409 });
      if (error instanceof BranchOperationDeniedError)
        return Response.json({ error: error.reason }, { status: 403 });
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return Response.json({ error: 'invalid_body' }, { status: 400 });
      if (error instanceof PharmacySaleError)
        return Response.json(
          { error: error.reason },
          { status: error.reason === 'INVALID_COMMAND_SIGNATURE' ? 401 : 409 }
        );
      if (error instanceof TRPCError)
        return Response.json({ error: error.message }, { status: 403 });
      // Known domain reason strings only; never serialize Prisma/provider errors.
      if (
        error instanceof Error &&
        'reason' in error &&
        typeof error.reason === 'string' &&
        /^[A-Z_]+$/.test(error.reason)
      )
        return Response.json({ error: error.reason }, { status: 409 });
      return Response.json({ error: 'internal_error' }, { status: 500 });
    }
  };
}
