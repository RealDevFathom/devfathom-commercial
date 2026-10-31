import 'server-only';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  createCustomerOtp,
  verifyCustomerOtp,
  transitionRxRequest,
  type CustomerOtpChallenge,
} from './customer-pwa';
import {
  customerPortalSettingsSchema,
  type CustomerPortalSettings,
  type CustomerPortalSummary,
} from './customer-portal-contract';
import { normalizeWhatsAppNumber } from './whatsapp/messages';
import { readKhataBalance } from './family-khata';
import { readCounterReceipt } from './counter';
import { persistPrescriptionFile } from './prescription-files';

export class CustomerPortalError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export const portalHash = (value: string) => createHash('sha256').update(value).digest('hex');
export type PortalScope = {
  organizationId: string;
  branchId: string;
  customerId: string;
  patientId: string;
};
export type PortalRequest = {
  id: string;
  organizationId: string;
  branchId: string;
  customerId: string;
  kind: 'REFILL' | 'RX_PHOTO';
  status: 'AWAITING_PHARMACIST' | 'APPROVED' | 'DECLINED' | 'FULFILLED';
  sourceSaleId: string | null;
  sourceFileRef: string | null;
  fulfilledSaleId: string | null;
  payloadHash: string;
  createdAt: Date;
};

export async function portalSettings(db: ScopedDb, organizationId: string, branchId: string) {
  const rows = await db.$queryRaw<{ config: unknown }[]>(Prisma.sql`
    SELECT config FROM pharmacy_customer_portal_settings
    WHERE "organizationId"=${organizationId} AND "branchId"=${branchId}`);
  return customerPortalSettingsSchema.parse(rows[0]?.config ?? {});
}

export async function portalEvent(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; customerId?: string },
  kind: string,
  actorId: string,
  requestId: string | null = null
) {
  await db.$executeRaw(Prisma.sql`INSERT INTO pharmacy_customer_portal_events
    (id, "organizationId", "branchId", "customerId", "actorId", kind, "requestId")
    VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${scope.customerId ?? null}, ${actorId}, ${kind}, ${requestId})`);
}

export async function activePortalBranch(db: ScopedDb, organizationId: string, branchId: string) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: branchId, organizationId, active: true },
    select: { id: true, name: true },
  });
  if (!branch || !(await portalSettings(db, organizationId, branchId)).enabled)
    throw new CustomerPortalError(
      404,
      'Customer service is unavailable at this branch. Contact the pharmacy.'
    );
  await db.$queryRaw(Prisma.sql`SELECT set_config('app.current_branch_id', ${branchId}, true)`);
  return branch;
}

/** Delivery occurs after the transaction commits. A missing/ambiguous phone never identifies a customer. */
export async function issuePortalOtp(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  phone: string,
  challengeId: string
) {
  await activePortalBranch(db, organizationId, branchId);
  const normalized = normalizeWhatsAppNumber(phone);
  if (!normalized) return null;
  const candidates = await db.$queryRaw<{ id: string; phone: string }[]>(Prisma.sql`
    SELECT c.id, p.phone FROM pharmacy_customers c JOIN pharmacy_patients p
    ON p."organizationId"=c."organizationId" AND p.id=c."patientId"
    WHERE c."organizationId"=${organizationId} AND c.active
      AND right(regexp_replace(p.phone, '[^0-9]', '', 'g'), 4)=${normalized.slice(-4)}
    ORDER BY c.id LIMIT 51`);
  if (candidates.length > 50) return null;
  const matches = candidates.filter((c) => normalizeWhatsAppNumber(c.phone) === normalized);
  if (matches.length !== 1) return null;
  const customer = matches[0];
  const config = await portalSettings(db, organizationId, branchId);
  const { code, challenge } = createCustomerOtp(
    customer.id,
    organizationId,
    new Date(),
    config.otpTtlMinutes
  );
  // One live challenge per customer/branch; serialize resends across instances.
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_customers WHERE "organizationId"=${organizationId} AND id=${customer.id} FOR UPDATE`
  );
  await db.$executeRaw(Prisma.sql`UPDATE pharmacy_customer_otp_challenges SET "consumedAt"=CURRENT_TIMESTAMP
    WHERE "organizationId"=${organizationId} AND "branchId"=${branchId} AND "customerId"=${customer.id} AND "consumedAt" IS NULL`);
  await db.$executeRaw(Prisma.sql`INSERT INTO pharmacy_customer_otp_challenges
    (id, "organizationId", "branchId", "customerId", "phoneHash", digest, salt, "expiresAt", "maxAttempts", audit)
    VALUES (${challengeId}, ${organizationId}, ${branchId}, ${customer.id}, ${portalHash(normalized)}, ${challenge.digest}, ${challenge.salt}, ${challenge.expiresAt}, ${config.otpMaxAttempts}, ${JSON.stringify(challenge.audit)}::jsonb)`);
  await portalEvent(
    db,
    { organizationId, branchId, customerId: customer.id },
    'OTP_ISSUED',
    `customer:${customer.id}`
  );
  return { code, phone: normalized };
}

export async function consumePortalOtp(
  db: ScopedDb,
  organizationId: string,
  challengeId: string,
  code: string,
  now = new Date()
) {
  // Resends lock customer -> challenge. Verification must use the same order:
  // inserting a session acquires the customer FK lock as well.
  const identities = await db.$queryRaw<{ customerId: string }[]>(Prisma.sql`
    SELECT "customerId" FROM pharmacy_customer_otp_challenges
    WHERE id=${challengeId} AND "organizationId"=${organizationId}`);
  if (!identities[0]) return null;
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_customers
    WHERE "organizationId"=${organizationId} AND id=${identities[0].customerId} FOR UPDATE`);
  const rows = await db.$queryRaw<
    (CustomerOtpChallenge & { branchId: string; phoneHash: string; maxAttempts: number })[]
  >(Prisma.sql`
    SELECT * FROM pharmacy_customer_otp_challenges WHERE id=${challengeId} AND "organizationId"=${organizationId} FOR UPDATE`);
  const challenge = rows[0];
  if (!challenge) return null;
  await activePortalBranch(db, organizationId, challenge.branchId);
  // pg/Prisma raw bytea is a Uint8Array; the policy compares bytes, never strings.
  challenge.digest = Buffer.from(challenge.digest);
  const result = verifyCustomerOtp(
    challenge,
    { organizationId, customerId: challenge.customerId, code },
    now,
    challenge.maxAttempts
  );
  await db.$executeRaw(Prisma.sql`UPDATE pharmacy_customer_otp_challenges
    SET attempts=${challenge.attempts}, "consumedAt"=${challenge.consumedAt}, audit=${JSON.stringify(challenge.audit)}::jsonb
    WHERE id=${challengeId} AND "organizationId"=${organizationId}`);
  await portalEvent(
    db,
    challenge,
    result.ok ? 'OTP_VERIFIED' : `OTP_${result.reason}`,
    `customer:${challenge.customerId}`
  );
  if (!result.ok) return null; // Return instead of throwing: failed-attempt counters must commit.
  const customer = await db.pharmacyCustomer.findFirst({
    where: { organizationId, id: challenge.customerId, active: true },
    include: { patient: { select: { phone: true } } },
  });
  const phone = normalizeWhatsAppNumber(customer?.patient.phone);
  if (!customer || !phone || portalHash(phone) !== challenge.phoneHash) return null;
  const config = await portalSettings(db, organizationId, challenge.branchId);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + config.sessionMinutes * 60_000);
  await db.$executeRaw(Prisma.sql`INSERT INTO pharmacy_customer_sessions
    ("tokenHash", "organizationId", "branchId", "customerId", "phoneHash", "expiresAt")
    VALUES (${portalHash(token)}, ${organizationId}, ${challenge.branchId}, ${customer.id}, ${challenge.phoneHash}, ${expiresAt})`);
  return { token, maxAge: config.sessionMinutes * 60 };
}

export async function customerPortalScope(
  db: ScopedDb,
  organizationId: string,
  token: string | null,
  now = new Date()
): Promise<PortalScope> {
  if (!token || !/^[\w-]{43}$/.test(token))
    throw new CustomerPortalError(401, 'Verify your phone to continue.');
  const sessions = await db.$queryRaw<
    { branchId: string; customerId: string; phoneHash: string }[]
  >(Prisma.sql`
    SELECT "branchId", "customerId", "phoneHash" FROM pharmacy_customer_sessions
    WHERE "tokenHash"=${portalHash(token)} AND "organizationId"=${organizationId} AND "revokedAt" IS NULL AND "expiresAt">${now}`);
  const session = sessions[0];
  if (!session)
    throw new CustomerPortalError(401, 'Your session has expired. Verify your phone again.');
  const customer = await db.pharmacyCustomer.findFirst({
    where: { organizationId, id: session.customerId, active: true },
    select: { patientId: true, patient: { select: { phone: true } } },
  });
  const phone = normalizeWhatsAppNumber(customer?.patient.phone);
  if (!customer || !phone || portalHash(phone) !== session.phoneHash)
    throw new CustomerPortalError(401, 'Verify your phone again.');
  await activePortalBranch(db, organizationId, session.branchId);
  return {
    organizationId,
    branchId: session.branchId,
    customerId: session.customerId,
    patientId: customer.patientId,
  };
}

export async function portalReceipt(
  db: ScopedDb,
  scope: PortalScope,
  saleId: string,
  currency: string
) {
  const sale = await db.pharmacySale.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: scope.customerId,
      id: saleId,
      status: 'COMPLETED',
      receiptNumber: { not: null },
    },
    select: { id: true },
  });
  if (!sale) throw new CustomerPortalError(404, 'Receipt unavailable.');
  const branch = await activePortalBranch(db, scope.organizationId, scope.branchId);
  await portalEvent(db, scope, 'RECEIPT_READ', `customer:${scope.customerId}`);
  return readCounterReceipt(
    db,
    { organizationId: scope.organizationId, branchId: scope.branchId },
    sale.id,
    { name: branch.name, currency }
  );
}

export async function customerPortalSummary(
  db: ScopedDb,
  scope: PortalScope,
  currency: string
): Promise<CustomerPortalSummary> {
  const branch = await activePortalBranch(db, scope.organizationId, scope.branchId);
  const config = await portalSettings(db, scope.organizationId, scope.branchId);
  const customer = await db.pharmacyCustomer.findFirstOrThrow({
    where: { organizationId: scope.organizationId, id: scope.customerId },
    select: { displayName: true },
  });
  const receipts = await db.pharmacySale.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: scope.customerId,
      status: 'COMPLETED',
      receiptNumber: { not: null },
    },
    select: { id: true, receiptNumber: true, completedAt: true },
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
    take: 100,
  });
  const requests = await db.$queryRaw<
    Pick<PortalRequest, 'id' | 'kind' | 'status' | 'createdAt'>[]
  >(Prisma.sql`
    SELECT id, kind, status, "createdAt" FROM pharmacy_customer_requests
    WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND "customerId"=${scope.customerId}
    ORDER BY "createdAt" DESC, id DESC LIMIT 100`);
  const consent = await db.patientConsent.findFirst({
    where: { organizationId: scope.organizationId, patientId: scope.patientId, purpose: 'LOYALTY' },
    orderBy: [{ version: 'desc' }, { recordedAt: 'desc' }],
    select: { granted: true, revokedAt: true },
  });
  const points =
    consent?.granted && !consent.revokedAt
      ? await db.pharmacyLoyaltyPointsEntry.aggregate({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            customerId: scope.customerId,
          },
          _sum: { points: true },
        })
      : null;
  // Only the designated payer sees a family account's full balance.
  const accounts = await db.pharmacyFamilyAccount.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      payerCustomerId: scope.customerId,
      active: true,
    },
    select: { id: true, displayName: true },
    take: 100,
  });
  const balances = [];
  for (const account of accounts)
    balances.push({
      ...account,
      balanceMinor: await readKhataBalance(
        db,
        { ...scope, actorId: `customer:${scope.customerId}` },
        account.id
      ),
    });
  await portalEvent(db, scope, 'PORTAL_READ', `customer:${scope.customerId}`);
  return {
    customerName: customer.displayName,
    branchName: branch.name,
    currency,
    loyaltyLabel: config.loyaltyLabel,
    pointsBalance: points ? (points._sum.points ?? 0) : null,
    offers:
      config.nonDrugOffersEnabled && config.deliveryFeeWaived
        ? ['Delivery fee waived. Ask the pharmacy to confirm availability.']
        : [],
    receipts: receipts.map((s) => ({ ...s, completedAt: s.completedAt?.toISOString() ?? null })),
    requests: requests.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    accounts: balances,
    raast: config.raastId ? { id: config.raastId, payee: config.raastPayeeLabel } : null,
  };
}

export async function createPortalRequest(
  db: ScopedDb,
  scope: PortalScope,
  input:
    | { action: 'refill'; saleId: string; idempotencyKey: string }
    | {
        action: 'photo';
        contentType: 'image/png' | 'image/jpeg' | 'image/webp';
        dataBase64: string;
        idempotencyKey: string;
      }
) {
  const payloadHash = portalHash(
    JSON.stringify(
      input.action === 'refill'
        ? ['REFILL', input.saleId]
        : ['RX_PHOTO', input.contentType, portalHash(input.dataBase64)]
    )
  );
  // Serialize retries before uploading; the same key can never produce two requests.
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_customers WHERE "organizationId"=${scope.organizationId} AND id=${scope.customerId} FOR UPDATE`
  );
  const previous = await db.$queryRaw<
    PortalRequest[]
  >(Prisma.sql`SELECT * FROM pharmacy_customer_requests
    WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND "customerId"=${scope.customerId} AND "idempotencyKey"=${input.idempotencyKey}`);
  if (previous[0]) {
    if (
      previous[0].payloadHash !== payloadHash ||
      previous[0].kind !== (input.action === 'refill' ? 'REFILL' : 'RX_PHOTO') ||
      (input.action === 'refill' && previous[0].sourceSaleId !== input.saleId)
    )
      throw new CustomerPortalError(409, 'This request key was already used.');
    return { id: previous[0].id, status: previous[0].status };
  }
  let sourceFileRef: string | null = null;
  if (input.action === 'refill') {
    const sale = await db.pharmacySale.findFirst({
      where: {
        id: input.saleId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        customerId: scope.customerId,
        status: 'COMPLETED',
      },
      select: { id: true },
    });
    if (!sale) throw new CustomerPortalError(404, 'Previous purchase unavailable.');
  } else {
    const file = await persistPrescriptionFile(
      scope.organizationId,
      `customer:${scope.customerId}`,
      { patientId: scope.patientId, contentType: input.contentType, dataBase64: input.dataBase64 }
    );
    sourceFileRef = file.sourceFileRef;
  }
  const id = randomUUID();
  await db.$executeRaw(Prisma.sql`INSERT INTO pharmacy_customer_requests
    (id, "organizationId", "branchId", "customerId", kind, "sourceSaleId", "sourceFileRef", "idempotencyKey", "payloadHash")
    VALUES (${id}, ${scope.organizationId}, ${scope.branchId}, ${scope.customerId}, ${input.action === 'refill' ? 'REFILL' : 'RX_PHOTO'}, ${input.action === 'refill' ? input.saleId : null}, ${sourceFileRef}, ${input.idempotencyKey}, ${payloadHash})`);
  await portalEvent(db, scope, 'REQUEST_CREATED', `customer:${scope.customerId}`, id);
  return { id, status: 'AWAITING_PHARMACIST' };
}

export async function updatePortalRequest(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; actorId: string },
  requestId: string,
  action: 'APPROVE' | 'DECLINE' | 'FULFIL',
  saleId?: string
) {
  const rows = await db.$queryRaw<
    PortalRequest[]
  >(Prisma.sql`SELECT * FROM pharmacy_customer_requests
    WHERE id=${requestId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`);
  const request = rows[0];
  if (!request) throw new CustomerPortalError(404, 'Request unavailable.');
  let status: PortalRequest['status'];
  try {
    status = transitionRxRequest(request.status, action);
  } catch {
    throw new CustomerPortalError(
      409,
      'A pharmacist must approve the pending request before fulfilment.'
    );
  }
  if (action === 'FULFIL') {
    if (!saleId) throw new CustomerPortalError(400, 'Link the completed dispensing sale.');
    const sale = await db.pharmacySale.findFirst({
      where: {
        id: saleId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        customerId: request.customerId,
        status: 'COMPLETED',
        completedAt: { gte: request.createdAt },
      },
      include: { lines: { include: { prescriptionLine: { include: { prescription: true } } } } },
    });
    if (
      !sale ||
      (request.kind === 'RX_PHOTO' &&
        !sale.lines.some(
          (l) => l.prescriptionLine?.prescription.sourceFileRef === request.sourceFileRef
        ))
    )
      throw new CustomerPortalError(
        409,
        'Complete the verified dispensing sale for this customer and source Rx first.'
      );
    // Existing sale completion enforces RX-03 SIGN, consent, limits, stock and money.
  }
  await db.$executeRaw(Prisma.sql`UPDATE pharmacy_customer_requests SET status=${status}, "fulfilledSaleId"=${action === 'FULFIL' ? saleId! : null}
    WHERE id=${requestId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId}`);
  await portalEvent(db, request, `REQUEST_${status}`, scope.actorId, request.id);
  return { id: request.id, status };
}

export async function savePortalSettings(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; actorId: string },
  settings: CustomerPortalSettings
) {
  const config = customerPortalSettingsSchema.parse(settings);
  await db.$executeRaw(Prisma.sql`INSERT INTO pharmacy_customer_portal_settings ("organizationId", "branchId", config, "updatedByUserId")
    VALUES (${scope.organizationId}, ${scope.branchId}, ${JSON.stringify(config)}::jsonb, ${scope.actorId})
    ON CONFLICT ("organizationId", "branchId") DO UPDATE SET config=EXCLUDED.config, "updatedByUserId"=EXCLUDED."updatedByUserId"`);
  await portalEvent(db, scope, 'SETTINGS_VERIFIED', scope.actorId);
  return config;
}
