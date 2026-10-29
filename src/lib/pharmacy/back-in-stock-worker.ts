import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { sendBackInStockNotice } from './back-in-stock';
import {
  createWhatsAppProvider,
  readWhatsAppConfig,
  WhatsAppProviderError,
  type WhatsAppProvider,
} from './whatsapp/provider';

type RestockNotificationScope = { organizationId: string; branchId: string };

/**
 * Delivers one durable CAPTURED notification. The status predicate is the
 * retry/idempotency claim: SENT/CANCELLED rows can never be delivered again.
 * Unknown transport outcomes remain PROCESSING for operator reconciliation;
 * definitive configuration failures are audited as FAILED.
 */
export async function deliverBackInStockNotification(
  db: ScopedDb,
  scope: RestockNotificationScope,
  notificationId: string,
  options: { provider?: WhatsAppProvider; now?: Date } = {}
) {
  const notification = await db.pharmacyRestockNotification.findFirst({
    where: {
      id: notificationId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'CAPTURED',
      channel: 'WHATSAPP',
    },
    include: { interest: { select: { id: true, createdAt: true, status: true } } },
  });
  if (!notification || notification.interest.status === 'OPTED_OUT') return 'SKIPPED' as const;

  // Claim before the external side effect. Concurrent invocations and retries
  // observe PROCESSING and cannot duplicate a provider send. An unknown
  // provider outcome intentionally remains PROCESSING for manual reconciliation.
  const claim = await db.pharmacyRestockNotification.updateMany({
    where: {
      id: notification.id,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'CAPTURED',
    },
    data: { status: 'PROCESSING', lastError: null },
  });
  if (claim.count !== 1) return 'SKIPPED' as const;

  const provider = options.provider ?? createWhatsAppProvider(readWhatsAppConfig());
  try {
    const sent = await sendBackInStockNotice(provider, notification.destination, {
      branchId: notification.branchId,
      notificationId: notification.id,
      requestedOn: notification.interest.createdAt,
    });
    if (sent.acceptedByProvider !== true) return 'PREPARED' as const;
    const sentAt = options.now ?? new Date();
    const updated = await db.pharmacyRestockNotification.updateMany({
      where: {
        id: notification.id,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: 'PROCESSING',
      },
      data: { status: 'SENT', sentAt, providerMessageId: sent.providerMessageId, lastError: null },
    });
    if (updated.count !== 1) return 'SKIPPED' as const;
    await db.pharmacyRestockInterest.update({
      where: {
        organizationId_id: { organizationId: scope.organizationId, id: notification.interest.id },
      },
      data: { status: 'NOTIFIED' },
    });
    return 'SENT' as const;
  } catch (error) {
    const definitive = error instanceof WhatsAppProviderError && error.definitive;
    await db.pharmacyRestockNotification.updateMany({
      where: {
        id: notification.id,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: 'PROCESSING',
      },
      data: {
        ...(definitive ? { status: 'FAILED' as const } : {}),
        lastError: definitive ? error.reason : 'UNKNOWN_PROVIDER_OUTCOME',
      },
    });
    return definitive ? ('FAILED' as const) : ('UNKNOWN' as const);
  }
}
