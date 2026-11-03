import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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
  rotatePharmacyCounterSecret,
  revokePharmacyCounter,
  resolvePharmacyCounterBySecret,
} from '@/lib/pharmacy/offline-devices';
import {
  issueOfflineSnapshot,
  snapshotPayloadHash,
  snapshotPublicKey,
  verifySnapshotSignature,
} from '@/lib/pharmacy/offline-snapshots';
import { checkEnvelope } from '@/lib/pharmacy/offline-snapshot-envelope';
import { checkSafetyLease } from '@/lib/pharmacy/offline-safety-lease';
import {
  reserveReceiptNumberBlock,
  MAX_RECEIPT_LEASE_SIZE,
} from '@/lib/pharmacy/offline-receipt-leases';
import {
  grantDeviceLotQuota,
  consumeDeviceLotQuota,
  openDeviceLotQuota,
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
  PharmacySaleError,
} from '@/lib/pharmacy/sales';
import { applyPharmacyTender } from '@/lib/pharmacy/settlement';
import {
  manualTenderCaptureSchema,
  validateManualTenderPolicy,
  manualMerchantPolicies,
} from '@/lib/pharmacy/manual-payments';
import { readManualPaymentSettings } from '@/lib/pharmacy/manual-payment-settings';
import type { LedgerScope } from '@/lib/pharmacy/stock-ledger';
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
export const pharmacyOfflineRouter = router({
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
        await activeBranch(db, scope.organizationId, scope.branchId);
        const { device, secret } = await enrollPharmacyCounter(db, scope, input);
        return { device: { id: device.id, name: device.name, branchId: device.branchId }, secret };
      })
    ),
  rotate: adminProcedure.input(branchInput.extend({ deviceId: id })).mutation(({ ctx, input }) =>
    ctx.db.$transaction(async (tx) => {
      const db = tx as ScopedDb;
      const scope = {
        organizationId: ctx.entitlements.organizationId,
        branchId: input.branchId,
        actorId: ctx.session.user.id,
      };
      await activeBranch(db, scope.organizationId, scope.branchId);
      const current = await db.pharmacyRegisteredDevice.findFirst({
        where: {
          id: input.deviceId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
      });
      if (!current) throw new TRPCError({ code: 'NOT_FOUND' });
      const { device, secret } = await rotatePharmacyCounterSecret(
        db,
        scope,
        current.id,
        current.deviceSecretHash
      );
      return { deviceId: device.id, secret };
    })
  ),
  revoke: adminProcedure.input(branchInput.extend({ deviceId: id })).mutation(({ ctx, input }) =>
    ctx.db.$transaction(async (tx) => {
      const device = await revokePharmacyCounter(
        tx as ScopedDb,
        {
          organizationId: ctx.entitlements.organizationId,
          branchId: input.branchId,
          actorId: ctx.session.user.id,
        },
        input.deviceId,
        new Date()
      );
      return { deviceId: device.id, status: device.status };
    })
  ),
});

class CounterTransportError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400
  ) {
    super(code);
  }
}
const safety = z
  .object({
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    recallVersion: z.number().int().nonnegative(),
    licenceVersion: z.number().int().nonnegative(),
    ruleVersion: z.number().int().nonnegative(),
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
export type PharmacyCounterContext = {
  db: ScopedDb;
  scope: LedgerScope;
  deviceId: string;
  deviceSecret: string;
};

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
    safetyLeaseOk: true,
    batchRecalled: false,
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
  if (recorded.command.status === 'ACCEPTED')
    return {
      saleId: recorded.command.serverRef,
      receiptNumber: recorded.command.receiptNumber,
      replayed: true,
    };
  if (recorded.command.status !== 'PENDING')
    throw new CounterTransportError('command_rejected', 409);
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
  const sale = await createSale(db, scope);
  for (const [index, line] of command.lines.entries()) {
    const medicine = await db.medicine.findFirst({
      where: { id: line.medicineId, organizationId: scope.organizationId },
      select: { controlled: true, rx: true, restricted: true },
    });
    if (!medicine || medicine.controlled || medicine.rx || medicine.restricted)
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
    const units = line.quantity * line.canonicalUnitsPerSaleUnit;
    const quota = await openDeviceLotQuota(db, scope, { ...line, deviceId });
    if (!quota || quota.quotaUnits - quota.consumedUnits < units)
      throw new CounterTransportError('quota_exhausted', 409);
    await consumeDeviceLotQuota(db, scope, { ...line, deviceId, units });
    const created = await addSaleLine(db, scope, {
      ...line,
      saleId: sale.id,
      idempotencyKey: `${command.idempotencyKey}:${index}`,
    });
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
      businessDate: new Date(command.leasedReceipt.originalSaleAt.slice(0, 10) + 'T00:00:00Z'),
      type: command.manualCapture?.type ?? 'CASH',
      amountMinor: command.amountMinor,
      cashReceivedMinor: command.cashReceivedMinor,
      ...(command.manualCapture
        ? {
            providerRef: command.manualCapture.providerRef,
            approvalCode: command.manualCapture.approvalCode,
            payerName: command.manualCapture.payerName,
            referenceSkipped: command.manualCapture.referenceSkipped,
          }
        : {}),
      idempotencyKey: command.idempotencyKey,
      leasedReceipt: command.leasedReceipt,
    },
    { deviceSecret, signature: receiptSignature }
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
      receiptNumber: command.leasedReceipt.receiptNumber,
    },
    new Date()
  );
  return { saleId: sale.id, receiptNumber: command.leasedReceipt.receiptNumber, replayed: false };
}

const sessionSchema = z
  .object({
    actorId: id,
    organizationId: id,
    branchId: id,
    deviceId: id,
    credentialHash: z.string(),
    expiresAt: z.number(),
    nonce: z.string(),
  })
  .strict();
function sessionMac(payload: string) {
  const key = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!key) throw new CounterTransportError('session_unavailable', 503);
  return createHmac('sha256', key)
    .update('pharmacy-counter-session:v1\n')
    .update(payload)
    .digest('hex');
}
function establishToken(ctx: PharmacyCounterContext) {
  const payload = Buffer.from(
    JSON.stringify({
      ...ctx.scope,
      actorId: ctx.scope.actorId,
      deviceId: ctx.deviceId,
      credentialHash: hashDeviceSecret(ctx.deviceSecret),
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      nonce: randomUUID(),
    })
  ).toString('base64url');
  return payload + '.' + sessionMac(payload);
}
function verifyToken(token: string, ctx: PharmacyCounterContext) {
  const [payload, signature, ...extra] = token.split('.');
  if (
    !payload ||
    !signature ||
    extra.length ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sessionMac(payload), 'hex'))
  )
    throw new CounterTransportError('invalid_terminal_session', 401);
  const parsed = sessionSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
  if (
    !parsed.success ||
    parsed.data.expiresAt <= Date.now() ||
    parsed.data.actorId !== ctx.scope.actorId ||
    parsed.data.organizationId !== ctx.scope.organizationId ||
    parsed.data.branchId !== ctx.scope.branchId ||
    parsed.data.deviceId !== ctx.deviceId ||
    parsed.data.credentialHash !== hashDeviceSecret(ctx.deviceSecret)
  )
    throw new CounterTransportError('invalid_terminal_session', 401);
}
export type CounterOperation = 'establish' | 'snapshot' | 'replay' | 'lease' | 'quota';

/** Live web actor plus enrolled device, with an actor/device-bound terminal
 * token after establishment. Errors are mapped only outside the transaction. */
export function pharmacyCounterRoute(operation: CounterOperation) {
  return async (request: Request): Promise<Response> => {
    try {
      if (!(await rateLimit(`pharmacy-counter:${clientIp(request)}`, 120, 60_000)).ok)
        throw new CounterTransportError('rate_limited', 429);
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin)
        throw new CounterTransportError('origin_denied', 403);
      const actor = await resolveTenantActor({ request });
      if (!actor || actor.support) throw new CounterTransportError('unauthorized', 401);
      const secret = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (!/^pcd_[A-Za-z0-9_-]{43}$/.test(secret))
        throw new CounterTransportError('unauthorized_device', 401);
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 256_000) throw new CounterTransportError('body_too_large', 413);
      const body: unknown = JSON.parse(raw || '{}');
      const result = await withTenantDb(actor.organization.id, async (db) => {
        if (
          !hasModule(
            await resolveOrganizationEntitlements(actor.organization.id, db),
            'pharmacy-counter'
          )
        )
          throw new CounterTransportError('module_disabled', 403);
        const manager = operation === 'lease' || operation === 'quota';
        if (
          !(await can(
            subjectFromSession(actor.session.user),
            manager ? 'admin:access' : 'pharmacy:orders',
            undefined,
            { db, source: 'REST', ip: clientIp(request) }
          ))
        )
          throw new CounterTransportError('forbidden', 403);
        const device = await resolvePharmacyCounterBySecret(db, secret);
        if (!device || device.status !== 'ACTIVE' || device.revokedAt)
          throw new CounterTransportError('unauthorized_device', 401);
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
          };
        }
        verifyToken(request.headers.get('x-terminal-session') ?? '', ctx);
        if (operation === 'lease') {
          const input = z
            .object({ size: z.number().int().positive().max(MAX_RECEIPT_LEASE_SIZE) })
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
            },
            take: 1000,
            orderBy: { id: 'asc' },
          });
          const catalog = await db.medicine.findMany({
            where: {
              organizationId: ctx.scope.organizationId,
              saleable: true,
              rx: false,
              controlled: false,
              restricted: false,
            },
            select: {
              id: true,
              productName: true,
              presentations: { select: { id: true, presentation: true, packLevels: true } },
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
          const merchant = await readManualPaymentSettings(db, ctx.scope);
          const payloads = {
            CATALOG: catalog,
            PRICES: lots,
            TAX: taxes,
            RULES: {
              controlledMedicinesPermittedOffline: false,
              rxPermittedOffline: false,
              manualMerchantPolicies: manualMerchantPolicies(merchant.settings),
              manualMerchantRevision: merchant.revision,
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
              })
            );
          return { snapshots, publicKey: snapshotPublicKey(), catalogLimit: 1000 };
        }
        const command = counterReplaySchema.parse(body);
        const key = request.headers.get('idempotency-key');
        if (!key || key !== command.idempotencyKey)
          throw new CounterTransportError('invalid_idempotency_key');
        return replayCounterCommand(
          ctx,
          command,
          request.headers.get('x-command-signature') ?? '',
          request.headers.get('x-receipt-signature') ?? ''
        );
      });
      return Response.json(result, {
        status: operation === 'establish' ? 201 : 200,
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      if (error instanceof CounterTransportError)
        return Response.json({ error: error.code }, { status: error.status });
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
