import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const PAUSE_REASON = 'WhatsApp account-quality hold';
const RECOVERY_EVENTS = new Set(['UNBAN', 'ACCOUNT_REINSTATEMENT', 'REINSTATED']);
const BLOCK_EVENTS = new Set(['BAN', 'DISABLED_UPDATE', 'ACCOUNT_DISABLED', 'ACCOUNT_RESTRICTION']);

type AccountQualityUpdate = {
  key: string;
  level: 'warning' | 'block';
  event: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse only Meta `account_update` changes. Customer/message fields are never copied to alerts. */
export function parseAccountQualityUpdates(payload: unknown): AccountQualityUpdate[] {
  const root = object(payload);
  if (root?.object !== 'whatsapp_business_account' || !Array.isArray(root.entry)) return [];
  const updates: AccountQualityUpdate[] = [];
  for (const rawEntry of root.entry) {
    const entry = object(rawEntry);
    if (!entry || !Array.isArray(entry.changes)) continue;
    for (const rawChange of entry.changes) {
      const change = object(rawChange);
      if (change?.field !== 'account_update') continue;
      const value = object(change.value);
      const rawEvent = value?.event;
      if (typeof rawEvent !== 'string') continue;
      const event = rawEvent.trim().toUpperCase().slice(0, 80);
      if (!event || RECOVERY_EVENTS.has(event)) continue;
      const level = BLOCK_EVENTS.has(event) ? 'block' : 'warning';
      // WABA id + event is stable enough to suppress Meta retries without retaining payload data.
      updates.push({ key: `${String(entry.id ?? 'account')}:${event}`, level, event });
    }
  }
  return updates;
}

/**
 * Creates an in-app alert for every active owner and pauses runnable campaign feeds.
 * This deliberately does not touch owner/PIN approval policy.
 */
export async function applyAccountQualityUpdates(
  db: ScopedDb,
  organizationId: string,
  updates: AccountQualityUpdate[],
  appealUrl: string
) {
  if (updates.length === 0) return { alerts: 0, paused: 0 };
  const owners = await db.user.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      OR: [{ organizationRole: { key: 'owner' } }, { role: 'ADMIN' }],
    },
    select: { id: true },
  });
  let alerts = 0;
  let paused = 0;
  for (const update of updates) {
    const entityId = `whatsapp-account:${update.key}`;
    const exists = await db.notification.findFirst({
      where: { organizationId, type: 'pharmacy_whatsapp_account_quality', entityId },
      select: { id: true },
    });
    if (!exists && owners.length) {
      const result = await db.notification.createMany({
        data: owners.map(({ id: userId }) => ({
          organizationId,
          userId,
          type: 'pharmacy_whatsapp_account_quality',
          title: update.level === 'block' ? 'WhatsApp sending blocked' : 'WhatsApp account warning',
          message: `Outbound WhatsApp feeds were paused after an account-quality ${update.level}. Review or appeal: ${appealUrl}`,
          entityType: 'whatsapp_account_quality',
          entityId,
        })),
      });
      alerts += result.count;
    }
    const result = await db.pharmacyCampaign.updateMany({
      where: { organizationId, status: { in: ['APPROVED', 'CAPTURED'] } },
      data: { status: 'REFUSED', refusalReason: PAUSE_REASON },
    });
    paused += result.count;
  }
  return { alerts, paused };
}
