import 'server-only';

import { Prisma } from '@/generated/prisma/client';

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  RESTOCK_REQUEST_TTL_DAYS,
  restockPublicToken,
  sendBackInStockNotice,
} from './back-in-stock';
import { lockPatientConsent } from './consent-writer';
import { canMessageCustomer, normalizeWhatsAppNumber } from './whatsapp/messages';
import {
  createWhatsAppProvider,
  readWhatsAppConfig,
  WhatsAppProviderError,
  type WhatsAppProvider,
  type WhatsAppSendResult,
} from './whatsapp/provider';

type RestockNotificationScope = { organizationId: string; branchId: string };

/**
 * Called only by the committed outbox drainer. Own the claim transaction here:
 * accepting a request's ScopedDb would let a later HTTP rollback erase a send.
 * Unknown provider outcomes retain PROCESSING for operator reconciliation.
 */
export async function deliverBackInStockNotification(
  { organizationId, branchId }: RestockNotificationScope,
  notificationId: string,
  options: { provider?: WhatsAppProvider; now?: Date } = {}
) {
  const scope = { organizationId, branchId };
  const config = readWhatsAppConfig();
  const transaction = <T>(run: (db: ScopedDb) => Promise<T>) =>
    withTenantDb(
      scope.organizationId,
      async (db) => {
        await db.$queryRawUnsafe(
          "SELECT set_config('app.current_branch_id', $1, true)",
          scope.branchId
        );
        return run(db);
      },
      { skipDrain: true }
    );

  const notification = await transaction(async (db) => {
    const row = await db.pharmacyRestockNotification.findFirst({
      where: { id: notificationId, ...scope, status: 'CAPTURED' },
      include: {
        interest: { select: { id: true, patientId: true, createdAt: true, status: true } },
      },
    });
    if (!row) return null;
    const unsupported =
      row.channel !== 'WHATSAPP'
        ? 'UNSUPPORTED_CHANNEL'
        : !options.provider &&
            config.provider === 'meta' &&
            config.organizationId !== scope.organizationId
          ? 'PROVIDER_ORGANIZATION_MISMATCH'
          : null;
    if (unsupported) {
      await db.pharmacyRestockNotification.updateMany({
        where: { id: row.id, ...scope, status: 'CAPTURED' },
        data: { status: 'FAILED', lastError: unsupported },
      });
      return null;
    }
    if (row.interest.status !== 'OPEN' || !row.interest.patientId) {
      await db.pharmacyRestockNotification.updateMany({
        where: { id: row.id, ...scope, status: 'CAPTURED' },
        data: {
          status: 'CANCELLED',
          cancelledAt: options.now ?? new Date(),
          lastError: 'INTEREST_CLOSED',
        },
      });
      return null;
    }
    await lockPatientConsent(db, scope.organizationId, row.interest.patientId);
    const consent = await db.patientConsent.findFirst({
      where: {
        organizationId: scope.organizationId,
        patientId: row.interest.patientId,
        purpose: 'REMINDERS',
        channel: 'WHATSAPP',
      },
      orderBy: { version: 'desc' },
    });
    const customer = await db.pharmacyCustomer.findFirst({
      where: { organizationId: scope.organizationId, patientId: row.interest.patientId },
      select: { active: true, whatsappOptIn: true, patient: { select: { phone: true } } },
    });
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - RESTOCK_REQUEST_TTL_DAYS * 86_400_000);
    if (row.interest.createdAt < cutoff) {
      await db.pharmacyRestockNotification.updateMany({
        where: { id: row.id, ...scope, status: 'CAPTURED' },
        data: { status: 'CANCELLED', cancelledAt: now, lastError: 'INTEREST_EXPIRED' },
      });
      return null;
    }
    const to = normalizeWhatsAppNumber(customer?.patient.phone);
    if (
      !consent?.granted ||
      consent.revokedAt ||
      consent.recordedAt > now ||
      !canMessageCustomer(customer) ||
      !to ||
      to !== normalizeWhatsAppNumber(row.destination)
    ) {
      await db.pharmacyRestockNotification.updateMany({
        where: { id: row.id, ...scope, status: 'CAPTURED' },
        data: { status: 'CANCELLED', cancelledAt: now, lastError: 'CONSENT_REQUIRED' },
      });
      return null;
    }
    const branchLocation = await db.pharmacyBranch.findFirst({
      where: { id: scope.branchId, organizationId: scope.organizationId },
      select: { name: true, addressLine: true, city: true },
    });
    if (!branchLocation) throw new Error('Branch not found');
    const claim = await db.pharmacyRestockNotification.updateMany({
      where: {
        id: row.id,
        ...scope,
        status: 'CAPTURED',
        interest: { status: 'OPEN', createdAt: { gte: cutoff } },
      },
      data: { status: 'PROCESSING', lastError: null },
    });
    return claim.count === 1 ? { ...row, destination: to, branchLocation } : null;
  });
  if (!notification) return 'SKIPPED' as const;

  const provider = options.provider ?? createWhatsAppProvider(config);
  let sent: WhatsAppSendResult;
  try {
    sent = await sendBackInStockNotice(provider, notification.destination, {
      branchId: notification.branchId,
      branchLocation: notification.branchLocation,
      notificationId: notification.id,
      requestedOn: notification.interest.createdAt,
    });
  } catch (error) {
    const definitive = error instanceof WhatsAppProviderError && error.definitive;
    await transaction((db) =>
      db.pharmacyRestockNotification.updateMany({
        where: { id: notification.id, ...scope, status: 'PROCESSING' },
        data: {
          ...(definitive ? { status: 'FAILED' as const } : {}),
          lastError: definitive ? error.reason : 'UNKNOWN_PROVIDER_OUTCOME',
        },
      })
    );
    return definitive ? ('FAILED' as const) : ('UNKNOWN' as const);
  }
  if (sent.acceptedByProvider !== true) {
    await transaction((db) =>
      db.pharmacyRestockNotification.updateMany({
        where: { id: notification.id, ...scope, status: 'PROCESSING' },
        data: {
          ...(sent.acceptedByProvider === false ? { status: 'FAILED' as const } : {}),
          lastError:
            sent.acceptedByProvider === false ? 'MOCK_PREPARED' : 'UNKNOWN_PROVIDER_OUTCOME',
        },
      })
    );
    return sent.acceptedByProvider === false ? ('PREPARED' as const) : ('UNKNOWN' as const);
  }

  // Persistence errors after acceptance must never release the committed claim.
  return transaction(async (db) => {
    const updated = await db.pharmacyRestockNotification.updateMany({
      where: { id: notification.id, ...scope, status: 'PROCESSING' },
      data: {
        status: 'SENT',
        sentAt: options.now ?? new Date(),
        providerMessageId: sent.providerMessageId,
        lastError: null,
      },
    });
    if (updated.count !== 1) return 'SKIPPED' as const;
    await db.pharmacyRestockInterest.updateMany({
      where: { id: notification.interest.id, ...scope, status: 'OPEN' },
      data: { status: 'NOTIFIED' },
    });
    return 'SENT' as const;
  });
}

/** Operator queue and customer-reference lookup; no destinations or patient details. */
export async function reviewRestockNotifications(
  db: ScopedDb,
  { organizationId, branchId }: RestockNotificationScope,
  reference?: string
) {
  const scope = { organizationId, branchId };
  const where: Prisma.PharmacyRestockNotificationWhereInput = {
    ...scope,
    ...(reference ? {} : { status: { in: ['CAPTURED', 'PROCESSING', 'FAILED'] } }),
  };
  const rows = await db.pharmacyRestockNotification.findMany({
    where,
    select: {
      id: true,
      interestId: true,
      status: true,
      queuedAt: true,
      sentAt: true,
      providerMessageId: true,
      lastError: true,
    },
    orderBy: { queuedAt: 'asc' },
  });
  return rows
    .map((row) => ({ ...row, reference: restockPublicToken('reference', row.id) }))
    .filter((row) => !reference || row.reference === reference);
}

/**
 * Manual acknowledgement only: never release the durable claim or resend.
 * The operator verifies the provider record before declaring an unknown send SENT.
 */
export async function reconcileRestockNotification(
  db: ScopedDb,
  { organizationId, branchId }: RestockNotificationScope,
  input: {
    notificationId: string;
    outcome: 'SENT' | 'FAILED';
    sentAt?: Date;
    providerMessageId?: string;
  },
  now = new Date()
) {
  const scope = { organizationId, branchId };
  await db.$queryRaw(Prisma.sql`
    SELECT id FROM pharmacy_restock_notifications
    WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
      AND id = ${input.notificationId} FOR UPDATE
  `);
  const row = await db.pharmacyRestockNotification.findFirst({
    where: { id: input.notificationId, ...scope, status: 'PROCESSING' },
  });
  if (!row) throw new Error('Notification is not awaiting reconciliation');
  if (
    input.outcome === 'SENT' &&
    (!input.sentAt ||
      !Number.isFinite(input.sentAt.getTime()) ||
      !input.providerMessageId?.trim() ||
      input.sentAt < row.queuedAt ||
      input.sentAt > now)
  )
    throw new Error('A valid provider acknowledgement is required');
  const updated = await db.pharmacyRestockNotification.updateMany({
    where: { id: row.id, ...scope, status: 'PROCESSING' },
    data:
      input.outcome === 'SENT'
        ? {
            status: 'SENT',
            sentAt: input.sentAt,
            providerMessageId: input.providerMessageId,
            lastError: null,
          }
        : { status: 'FAILED', lastError: 'OPERATOR_CONFIRMED_NOT_SENT' },
  });
  if (updated.count === 1 && input.outcome === 'SENT') {
    await db.pharmacyRestockInterest.updateMany({
      where: { id: row.interestId, ...scope, status: 'OPEN' },
      data: { status: 'NOTIFIED' },
    });
  }
  return updated;
}
