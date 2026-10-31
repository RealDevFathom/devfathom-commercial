import 'server-only';

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import { sendBackInStockNotice } from './back-in-stock';
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
  if (
    !options.provider &&
    config.provider === 'meta' &&
    config.organizationId !== scope.organizationId
  )
    return 'SKIPPED' as const;
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
      where: { id: notificationId, ...scope, status: 'CAPTURED', channel: 'WHATSAPP' },
      include: {
        interest: { select: { id: true, patientId: true, createdAt: true, status: true } },
      },
    });
    if (!row || row.interest.status !== 'OPEN' || !row.interest.patientId) return null;
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
    const claim = await db.pharmacyRestockNotification.updateMany({
      where: { id: row.id, ...scope, status: 'CAPTURED', interest: { status: 'OPEN' } },
      data: { status: 'PROCESSING', lastError: null },
    });
    return claim.count === 1 ? { ...row, destination: to } : null;
  });
  if (!notification) return 'SKIPPED' as const;

  const provider = options.provider ?? createWhatsAppProvider(config);
  let sent: WhatsAppSendResult;
  try {
    sent = await sendBackInStockNotice(provider, notification.destination, {
      branchId: notification.branchId,
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
