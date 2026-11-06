import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import { prepareExternalPaymentAttempt, prepareExternalPaymentSchema } from './payment-attempts';
import { readManualPaymentSettings } from './manual-payment-settings';
import { validateManualTender, type ManualPaymentSettings } from './manual-payments';
import { assertRxSaleAllowed } from './rx-sale-gate';
import { assertSaleBatchesSellable } from './sale-batch-safety';
import {
  applyPharmacyTender,
  requirePharmacyDayOpen,
  requireReleaseSafeAdapter,
  type PharmacyPaymentAdapter,
} from './settlement';

type Attempt = Awaited<ReturnType<typeof prepareExternalPaymentAttempt>>['attempt'];
const id = z.string().min(1).max(128);
const captureSchema = z
  .object({
    payerName: z.string().trim().min(1).max(100).optional(),
    providerRef: z
      .string()
      .trim()
      .regex(/^\d{4,6}$/)
      .optional(),
    referenceSkipped: z.boolean().optional(),
  })
  .strict();
export const beginManualCollectionSchema = prepareExternalPaymentSchema
  .extend({
    method: z.enum(['BANK_TRANSFER', 'RAAST', 'JAZZCASH', 'EASYPAISA']),
    businessDate: z.date(),
  })
  .strict();
export const completeManualCollectionSchema = captureSchema
  .extend({
    attemptId: id,
    collectionToken: z.string().length(43),
  })
  .strict();
export const resolveManualCollectionSchema = captureSchema
  .extend({
    attemptId: id,
    decision: z.enum(['CONFIRM', 'RELEASE']),
    reason: z.string().trim().min(1).max(500),
    businessDate: z.date().optional(),
  })
  .strict();
const storedInputSchema = z
  .object({
    saleId: id,
    deviceId: id,
    businessDate: z.string().datetime(),
    type: prepareExternalPaymentSchema.shape.method,
    amountMinor: z.number().int().positive(),
    idempotencyKey: z.string().min(1).max(160),
    payerName: captureSchema.shape.payerName,
    providerRef: captureSchema.shape.providerRef,
    referenceSkipped: captureSchema.shape.referenceSkipped,
    paymentAttemptId: id,
  })
  .strict();
const resultSchema = z
  .object({
    tenderId: id,
    settled: z.boolean(),
    receiptNumber: z.number().int().positive().nullable(),
    remainingMinor: z.number().int().nonnegative(),
  })
  .strict();
const secret = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const inScope = <T>(scope: LedgerScope, work: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(scope.organizationId, work, { userId: scope.actorId });

export class PaymentCollectionError extends Error {
  constructor(
    readonly reason:
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'UNRESOLVED'
      | 'REQUEST_CONFLICT'
      | 'METHOD_NOT_SETUP'
      | 'INVALID_CAPTURE'
  ) {
    super(`PAYMENT_${reason}`);
  }
}
async function allowed(db: ScopedDb, scope: LedgerScope, resolution: boolean) {
  const [row] = await db.$queryRaw<Array<{ allowed: boolean }>>(Prisma.sql`
    SELECT pharmacy_payment_actor_allowed(${scope.organizationId},${scope.branchId},${scope.actorId},${resolution}) AS allowed`);
  return row?.allowed === true;
}
async function authorize(db: ScopedDb, scope: LedgerScope, resolution = false) {
  if (!(await allowed(db, scope, resolution))) throw new PaymentCollectionError('FORBIDDEN');
}
async function locked(db: ScopedDb, scope: LedgerScope, attemptId: string) {
  const row = await db.pharmacyPaymentAttempt.findFirst({
    where: {
      id: attemptId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
  });
  if (!row) throw new PaymentCollectionError('NOT_FOUND');
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_sales WHERE id=${row.saleId}
    AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`);
  return db.pharmacyPaymentAttempt.findFirstOrThrow({
    where: { id: row.id, organizationId: scope.organizationId, branchId: scope.branchId },
  });
}
function summary(attempt: Attempt, canResolve: boolean) {
  return {
    id: attempt.id,
    saleId: attempt.saleId,
    deviceId: attempt.deviceId,
    requestKey: attempt.requestKey,
    method: attempt.method,
    amountMinor: attempt.amountMinor,
    state: attempt.state,
    canResolve: canResolve && !['CARD', 'WALLET'].includes(attempt.method),
    result: attempt.state === 'SETTLED' ? resultSchema.parse(attempt.settlementResult) : null,
  };
}
function baseInput(attempt: Attempt, businessDate?: Date) {
  if (attempt.settlementInput) return storedInputSchema.parse(attempt.settlementInput);
  if (!businessDate) throw new PaymentCollectionError('REQUEST_CONFLICT');
  return storedInputSchema.parse({
    saleId: attempt.saleId,
    deviceId: attempt.deviceId,
    businessDate: businessDate.toISOString(),
    type: attempt.method,
    amountMinor: attempt.amountMinor,
    idempotencyKey: attempt.requestKey,
    paymentAttemptId: attempt.id,
  });
}
async function capturedInput(
  db: ScopedDb,
  scope: LedgerScope,
  attempt: Attempt,
  capture: z.infer<typeof captureSchema>,
  businessDate?: Date
) {
  const base = baseInput(attempt, businessDate);
  if (attempt.method === 'BANK_TRANSFER') {
    if (Object.values(capture).some((value) => value !== undefined))
      throw new PaymentCollectionError('INVALID_CAPTURE');
    return base;
  }
  if (attempt.method === 'CARD' || attempt.method === 'WALLET') {
    if (Object.values(capture).some((value) => value !== undefined))
      throw new PaymentCollectionError('INVALID_CAPTURE');
    return base;
  }
  const settings = await readManualPaymentSettings(db, scope);
  try {
    const valid = validateManualTender(settings.settings, { type: attempt.method, ...capture });
    if (valid.providerRef !== undefined && !/^\d{4,6}$/.test(valid.providerRef))
      throw new Error('Invalid reference');
    return storedInputSchema.parse({
      ...base,
      payerName: valid.payerName,
      providerRef: valid.providerRef,
      referenceSkipped: valid.referenceSkipped,
    });
  } catch {
    throw new PaymentCollectionError('INVALID_CAPTURE');
  }
}
async function tokenContext(db: ScopedDb, key: string, value: string) {
  await db.$executeRaw(Prisma.sql`SELECT set_config(${key},${value},true)`);
}

/** Read-only recovery is authorized from current stored membership, never a submitted role. */
export function recoverPaymentCollection(
  scope: LedgerScope,
  key: { attemptId?: string; saleId?: string; deviceId?: string; requestKey?: string }
) {
  return inScope(scope, async (db) => {
    const canResolve = await allowed(db, scope, true);
    if (!canResolve) await authorize(db, scope);
    const attempt = await db.pharmacyPaymentAttempt.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        ...(key.attemptId
          ? { id: id.parse(key.attemptId) }
          : {
              saleId: id.parse(key.saleId),
              deviceId: id.parse(key.deviceId),
              requestKey: z.string().min(1).max(160).parse(key.requestKey),
            }),
      },
    });
    return attempt ? summary(attempt, canResolve) : null;
  });
}

async function beginCollection(
  scope: LedgerScope,
  raw: z.infer<typeof prepareExternalPaymentSchema> & { businessDate: Date },
  adapter?: PharmacyPaymentAdapter
) {
  if (['CARD', 'WALLET'].includes(raw.method)) {
    if (!adapter) throw new PaymentCollectionError('METHOD_NOT_SETUP');
    requireReleaseSafeAdapter(adapter);
  }
  const { businessDate, ...input } = raw;
  await inScope(scope, async (db) => {
    await authorize(db, scope);
    const prior = await db.pharmacyPaymentAttempt.findUnique({
      where: {
        organizationId_deviceId_requestKey: {
          organizationId: scope.organizationId,
          deviceId: input.deviceId,
          requestKey: input.requestKey,
        },
      },
    });
    if (prior) return;
    await requirePharmacyDayOpen(db, scope, businessDate);
    const sale = await db.pharmacySale.findFirst({
      where: {
        id: input.saleId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: 'OPEN',
      },
      include: { lines: { include: { medicine: true } } },
    });
    if (!sale) throw new PaymentCollectionError('NOT_FOUND');
    await assertRxSaleAllowed(
      db,
      scope,
      sale.lines.map((line) => line.medicine)
    );
    await assertSaleBatchesSellable(db, scope, sale.id);
    if (!['BANK_TRANSFER', 'CARD', 'WALLET'].includes(input.method)) {
      const { settings } = await readManualPaymentSettings(db, scope);
      const merchant = settings[input.method as 'RAAST' | 'JAZZCASH' | 'EASYPAISA'];
      if (!merchant || (!merchant.destination.trim() && !merchant.qrImageDataUrl))
        throw new PaymentCollectionError('METHOD_NOT_SETUP');
    }
  });
  const prepared = await prepareExternalPaymentAttempt(scope, input);
  if (prepared.replayed)
    return { attempt: summary(prepared.attempt, false), collectionToken: null, merchant: null };
  const collectionToken = secret();
  const exposed = await inScope(scope, async (db) => {
    await authorize(db, scope);
    const current = await locked(db, scope, prepared.attempt.id);
    if (current.state !== 'PREPARED') throw new PaymentCollectionError('UNRESOLVED');
    let merchant: NonNullable<ManualPaymentSettings['RAAST']> | null = null;
    let policyRevision: number | null = null;
    if (['RAAST', 'JAZZCASH', 'EASYPAISA'].includes(current.method)) {
      await db.$queryRaw(
        Prisma.sql`SELECT id FROM pharmacy_branches WHERE id=${scope.branchId} AND "organizationId"=${scope.organizationId} FOR SHARE`
      );
      const configuration = await readManualPaymentSettings(db, scope);
      const candidate = configuration.settings[current.method as keyof ManualPaymentSettings];
      if (!candidate || (!candidate.destination.trim() && !candidate.qrImageDataUrl))
        throw new PaymentCollectionError('METHOD_NOT_SETUP');
      merchant = candidate;
      policyRevision = configuration.revision;
    }
    const attempt = await db.pharmacyPaymentAttempt.update({
      where: { id: current.id },
      data: {
        state: 'EXPOSED',
        collectionTokenHash: digest(collectionToken),
        settlementInput: json(baseInput(current, businessDate)),
        collectionPolicyRevision: policyRevision,
        collectionInstructionsHash: merchant ? digest(JSON.stringify(merchant)) : null,
      },
    });
    return { attempt, merchant };
  });
  // The secret and the bound instructions are returned once, after both commits.
  // Replay/reload returns no secret and can only recover or ask a manager.
  return { attempt: summary(exposed.attempt, false), collectionToken, merchant: exposed.merchant };
}

export function beginManualCollection(
  scope: LedgerScope,
  raw: z.input<typeof beginManualCollectionSchema>
) {
  return beginCollection(scope, beginManualCollectionSchema.parse(raw));
}

/** An older client may report funds already received without our token. Record
 * uncertainty durably; never turn that report into a tender or a new collection. */
export function registerUnpreparedManualCollection(
  scope: LedgerScope,
  input: {
    saleId: string;
    deviceId: string;
    type: string;
    amountMinor: number;
    idempotencyKey: string;
    businessDate: Date;
    payerName?: string;
    providerRef?: string;
    referenceSkipped?: boolean;
  }
) {
  if (!['BANK_TRANSFER', 'RAAST', 'JAZZCASH', 'EASYPAISA', 'CARD', 'WALLET'].includes(input.type))
    throw new PaymentCollectionError('METHOD_NOT_SETUP');
  const requestHash = digest(
    JSON.stringify({
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      actorId: scope.actorId,
      ...input,
    })
  );
  return inScope(scope, async (db) => {
    if (!(await allowed(db, scope, true))) await authorize(db, scope);
    await db.$queryRaw(
      Prisma.sql`SELECT id FROM pharmacy_sales WHERE id=${input.saleId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
    );
    const sale = await db.pharmacySale.findFirst({
      where: { id: input.saleId, organizationId: scope.organizationId, branchId: scope.branchId },
      select: { paymentRevision: true },
    });
    if (!sale) throw new PaymentCollectionError('NOT_FOUND');
    const previous = await db.pharmacyPaymentAttempt.findUnique({
      where: {
        organizationId_deviceId_requestKey: {
          organizationId: scope.organizationId,
          deviceId: input.deviceId,
          requestKey: input.idempotencyKey,
        },
      },
    });
    if (previous) {
      if (
        previous.requestHash !== requestHash ||
        previous.branchId !== scope.branchId ||
        previous.saleId !== input.saleId
      )
        throw new PaymentCollectionError('REQUEST_CONFLICT');
      return summary(previous, false);
    }
    const org = await db.organization.findUniqueOrThrow({
      where: { id: scope.organizationId },
      select: { currency: true },
    });
    const attemptId = secret();
    const attempt = await db.pharmacyPaymentAttempt.create({
      data: {
        id: attemptId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        saleId: input.saleId,
        deviceId: input.deviceId,
        requestKey: input.idempotencyKey,
        requestHash,
        method: input.type,
        currency: org.currency,
        amountMinor: input.amountMinor,
        billRevision: sale.paymentRevision,
        createdByUserId: scope.actorId,
        source: 'LEGACY_CAPTURE',
        state: 'UNKNOWN',
        settlementInput: json({
          saleId: input.saleId,
          deviceId: input.deviceId,
          businessDate: input.businessDate.toISOString(),
          type: input.type,
          amountMinor: input.amountMinor,
          idempotencyKey: input.idempotencyKey,
          paymentAttemptId: attemptId,
        }),
      },
    });
    return summary(attempt, false);
  });
}

async function claim(
  scope: LedgerScope,
  attemptId: string,
  collectionToken: string,
  capture: z.infer<typeof captureSchema>
) {
  const settlementToken = secret();
  const attempt = await inScope(scope, async (db) => {
    await authorize(db, scope);
    const current = await locked(db, scope, attemptId);
    if (
      current.state !== 'EXPOSED' ||
      current.createdByUserId !== scope.actorId ||
      current.collectionTokenHash !== digest(collectionToken)
    )
      throw new PaymentCollectionError('UNRESOLVED');
    if (['RAAST', 'JAZZCASH', 'EASYPAISA'].includes(current.method)) {
      const configuration = await readManualPaymentSettings(db, scope);
      const merchant = configuration.settings[current.method as keyof ManualPaymentSettings];
      if (
        !merchant ||
        current.collectionPolicyRevision !== configuration.revision ||
        current.collectionInstructionsHash !== digest(JSON.stringify(merchant))
      )
        throw new PaymentCollectionError('UNRESOLVED');
    }
    const input = await capturedInput(db, scope, current, capture);
    await tokenContext(db, 'app.pharmacy_collection_token', collectionToken);
    return db.pharmacyPaymentAttempt.update({
      where: { id: current.id },
      data: {
        state: 'UNKNOWN',
        settlementTokenHash: digest(settlementToken),
        settlementActorId: scope.actorId,
        settlementInput: json(input),
      },
    });
  });
  return { attempt, settlementToken };
}
async function finalizeInTransaction(
  db: ScopedDb,
  scope: LedgerScope,
  attemptId: string,
  settlementToken: string
) {
  const attempt = await locked(db, scope, attemptId);
  if (attempt.state === 'SETTLED')
    return { ...resultSchema.parse(attempt.settlementResult), replayed: true };
  await tokenContext(db, 'app.pharmacy_settlement_token', settlementToken);
  const stored = storedInputSchema.parse(attempt.settlementInput);
  const result = await applyPharmacyTender(db, scope, {
    ...stored,
    businessDate: new Date(stored.businessDate),
  });
  const parsed = resultSchema.parse({
    tenderId: 'tenderId' in result ? result.tenderId : null,
    settled: 'settled' in result ? result.settled : null,
    receiptNumber: 'receiptNumber' in result ? result.receiptNumber : null,
    remainingMinor: 'remainingMinor' in result ? result.remainingMinor : null,
  });
  await db.pharmacyPaymentAttempt.update({
    where: { id: attempt.id },
    data: { settlementResult: json(parsed) },
  });
  return { ...parsed, replayed: false };
}
async function finalize(scope: LedgerScope, attemptId: string, settlementToken: string) {
  return inScope(scope, (db) => finalizeInTransaction(db, scope, attemptId, settlementToken));
}
export async function completeManualCollection(
  scope: LedgerScope,
  raw: z.input<typeof completeManualCollectionSchema>
) {
  const { attemptId, collectionToken, ...capture } = completeManualCollectionSchema.parse(raw);
  const current = await inScope(scope, async (db) => {
    await authorize(db, scope);
    return locked(db, scope, attemptId);
  });
  if (['CARD', 'WALLET'].includes(current.method))
    throw new PaymentCollectionError('METHOD_NOT_SETUP');
  if (
    current.state === 'RELEASED' &&
    current.createdByUserId === scope.actorId &&
    current.collectionTokenHash === digest(collectionToken)
  ) {
    const base = baseInput(current);
    await registerUnpreparedManualCollection(scope, {
      saleId: current.saleId,
      deviceId: current.deviceId,
      type: current.method,
      amountMinor: current.amountMinor,
      businessDate: new Date(base.businessDate),
      idempotencyKey: `late:${digest(JSON.stringify({ attemptId: current.id, ...capture }))}`,
      ...capture,
    });
    throw new PaymentCollectionError('UNRESOLVED');
  }
  if (current.state === 'SETTLED') {
    const frozen = baseInput(current);
    if (
      capture.payerName !== frozen.payerName ||
      capture.providerRef !== frozen.providerRef ||
      Boolean(capture.referenceSkipped) !== Boolean(frozen.referenceSkipped)
    )
      throw new PaymentCollectionError('REQUEST_CONFLICT');
    return { ...resultSchema.parse(current.settlementResult), replayed: true };
  }
  const claimed = await claim(scope, attemptId, collectionToken, capture);
  return finalize(scope, attemptId, claimed.settlementToken);
}
export async function resolveManualCollection(
  scope: LedgerScope,
  raw: z.input<typeof resolveManualCollectionSchema>
) {
  const { attemptId, decision, reason, businessDate, ...capture } =
    resolveManualCollectionSchema.parse(raw);
  const settlementToken = secret();
  const attempt = await inScope(scope, async (db) => {
    await authorize(db, scope, true);
    const current = await locked(db, scope, attemptId);
    if (['CARD', 'WALLET'].includes(current.method))
      throw new PaymentCollectionError('METHOD_NOT_SETUP');
    if (current.state === 'SETTLED' || (current.state === 'RELEASED' && decision === 'RELEASE'))
      return current;
    if (
      !['PREPARED', 'EXPOSED', 'UNKNOWN', 'CONFIRMED'].includes(current.state) ||
      (current.state === 'CONFIRMED' && decision === 'RELEASE')
    )
      throw new PaymentCollectionError('UNRESOLVED');
    if (decision === 'RELEASE')
      return db.pharmacyPaymentAttempt.update({
        where: { id: current.id },
        data: {
          state: 'RELEASED',
          resolvedByUserId: scope.actorId,
          resolutionReason: reason,
        },
      });
    const input =
      current.state === 'CONFIRMED'
        ? storedInputSchema.parse(current.settlementInput)
        : await capturedInput(db, scope, current, capture, businessDate);
    return db.pharmacyPaymentAttempt.update({
      where: { id: current.id },
      data: {
        state: 'CONFIRMED',
        settlementTokenHash: digest(settlementToken),
        settlementActorId: scope.actorId,
        settlementInput: json(input),
        resolvedByUserId: scope.actorId,
        resolutionReason: reason,
      },
    });
  });
  if (attempt.state === 'RELEASED') return { state: 'RELEASED' as const, result: null };
  if (attempt.state === 'SETTLED')
    return {
      state: 'SETTLED' as const,
      result: { ...resultSchema.parse(attempt.settlementResult), replayed: true },
    };
  return { state: 'SETTLED' as const, result: await finalize(scope, attemptId, settlementToken) };
}

/** Internal certified-adapter path. No public endpoint accepts an adapter or an approval. */
export async function collectProviderPayment(
  scope: LedgerScope,
  raw: z.input<typeof prepareExternalPaymentSchema> & { businessDate: Date },
  adapter: PharmacyPaymentAdapter
) {
  // Parse without the service-only business date, retaining strict request validation.
  const { businessDate, ...request } = raw;
  const parsed = prepareExternalPaymentSchema.parse(request);
  if (!['CARD', 'WALLET'].includes(parsed.method))
    throw new PaymentCollectionError('METHOD_NOT_SETUP');
  requireReleaseSafeAdapter(adapter);
  if (!adapter.certified || adapter.localSandbox || !adapter.name.trim())
    throw new PaymentCollectionError('METHOD_NOT_SETUP');
  const begun = await beginCollection(scope, { ...parsed, businessDate }, adapter);
  if (begun.attempt.state === 'SETTLED')
    return { ...resultSchema.parse(begun.attempt.result), replayed: true };
  if (!begun.collectionToken) {
    const settlementToken = secret();
    const recovered = await inScope(scope, async (db) => {
      await authorize(db, scope);
      const current = await locked(db, scope, begun.attempt.id);
      if (
        current.state !== 'CONFIRMED' ||
        !current.providerRef ||
        current.providerName !== adapter.name ||
        current.createdByUserId !== scope.actorId
      )
        throw new PaymentCollectionError('UNRESOLVED');
      return db.pharmacyPaymentAttempt.update({
        where: { id: current.id },
        data: { settlementTokenHash: digest(settlementToken), settlementActorId: scope.actorId },
      });
    });
    return finalize(scope, recovered.id, settlementToken);
  }
  const claimed = await claim(scope, begun.attempt.id, begun.collectionToken, {});
  // UNKNOWN is already committed. Preserve the existing batch locks across
  // dispatch and settlement; a financial rollback cannot erase that claim.
  const evidence: { providerRef?: string } = {};
  async function recordApproval(db: ScopedDb) {
    const current = await locked(db, scope, claimed.attempt.id);
    // A lost commit acknowledgement may mean the complete transaction succeeded.
    if (current.state === 'SETTLED' || current.state === 'CONFIRMED') return;
    await tokenContext(db, 'app.pharmacy_settlement_token', claimed.settlementToken);
    await db.pharmacyPaymentAttempt.update({
      where: { id: current.id },
      data: { state: 'CONFIRMED', providerRef: evidence.providerRef, providerName: adapter.name },
    });
  }
  try {
    return await inScope(scope, async (db) => {
      await authorize(db, scope);
      const attempt = await locked(db, scope, claimed.attempt.id);
      if (attempt.state !== 'UNKNOWN') throw new PaymentCollectionError('UNRESOLVED');
      const input = baseInput(attempt);
      await requirePharmacyDayOpen(db, scope, new Date(input.businessDate));
      const sale = await db.pharmacySale.findFirstOrThrow({
        where: {
          id: attempt.saleId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
        include: { lines: { include: { medicine: true } } },
      });
      await assertRxSaleAllowed(
        db,
        scope,
        sale.lines.map((line) => line.medicine)
      );
      await assertSaleBatchesSellable(db, scope, sale.id);
      const approval = await adapter.execute({
        capability: 'SALE',
        amountMinor: attempt.amountMinor,
        operationRef: attempt.id,
      });
      if (!approval.approved || !approval.providerRef?.trim())
        throw new PaymentCollectionError('UNRESOLVED');
      evidence.providerRef = approval.providerRef;
      await recordApproval(db);
      return finalizeInTransaction(db, scope, attempt.id, claimed.settlementToken);
    });
  } catch (error) {
    // Persist an actual adapter response after rollback so recovery can finish
    // without charging again. No response leaves UNKNOWN, never a safe retry.
    if (evidence.providerRef) {
      try {
        await inScope(scope, recordApproval);
      } catch (persistenceError) {
        throw new AggregateError([error, persistenceError], 'Payment outcome requires recovery');
      }
    }
    throw error;
  }
}
