import type { PharmacyCampaignStatus } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const PAUSE_REASON = 'WhatsApp account-quality hold';
const RECOVERY_EVENTS = new Set(['UNBAN', 'ACCOUNT_REINSTATEMENT', 'REINSTATED']);
const WARNING_EVENTS = new Set(['ACCOUNT_VIOLATION', 'ACCOUNT_WARNING', 'POLICY_VIOLATION']);
const BLOCK_EVENTS = new Set(['BAN', 'DISABLED_UPDATE', 'ACCOUNT_DISABLED', 'ACCOUNT_RESTRICTION']);

type AccountQualityUpdate = {
  key: string;
  action: 'hold' | 'recover';
  level: 'warning' | 'block' | 'recovery';
  event: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse only explicitly supported Meta `account_update` events. Unknown events fail open. */
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
      const rawEvent = object(change.value)?.event;
      if (typeof rawEvent !== 'string') continue;
      const event = rawEvent.trim().toUpperCase().slice(0, 80);
      const action = RECOVERY_EVENTS.has(event) ? 'recover' : 'hold';
      const level = BLOCK_EVENTS.has(event)
        ? 'block'
        : WARNING_EVENTS.has(event)
          ? 'warning'
          : RECOVERY_EVENTS.has(event)
            ? 'recovery'
            : null;
      if (!level) continue;
      updates.push({ key: `${String(entry.id ?? 'account')}:${event}`, action, level, event });
    }
  }
  return updates;
}

async function alertOwners(
  db: ScopedDb,
  organizationId: string,
  ownerIds: string[],
  update: AccountQualityUpdate,
  appealUrl: string
) {
  if (!ownerIds.length) return 0;
  const entityId = `whatsapp-account:${update.key}`;
  const recovered = update.action === 'recover';
  const result = await db.notification.createMany({
    data: ownerIds.map((userId) => ({
      organizationId,
      userId,
      type: 'pharmacy_whatsapp_account_quality',
      title: recovered
        ? 'WhatsApp sending restored'
        : update.level === 'block'
          ? 'WhatsApp sending blocked'
          : 'WhatsApp account warning',
      message: recovered
        ? 'Outbound WhatsApp feeds held by account quality were restored.'
        : `Outbound WhatsApp feeds were placed on a resumable account-quality hold. Review or appeal: ${appealUrl}`,
      entityType: 'whatsapp_account_quality',
      entityId,
    })),
    skipDuplicates: true,
  });
  return result.count;
}

async function changeCampaigns(db: ScopedDb, organizationId: string, update: AccountQualityUpdate) {
  const changed: Array<{
    id: string;
    previous: PharmacyCampaignStatus;
    next: PharmacyCampaignStatus;
  }> = [];
  if (update.action === 'hold') {
    for (const previous of ['APPROVED', 'CAPTURED'] as const) {
      const rows = await db.pharmacyCampaign.updateManyAndReturn({
        where: { organizationId, status: previous },
        data: {
          status: 'ACCOUNT_QUALITY_HOLD',
          holdPreviousStatus: previous,
          refusalReason: PAUSE_REASON,
        },
        select: { id: true },
      });
      changed.push(
        ...rows.map(({ id }) => ({ id, previous, next: 'ACCOUNT_QUALITY_HOLD' as const }))
      );
    }
  } else {
    for (const next of ['APPROVED', 'CAPTURED'] as const) {
      const rows = await db.pharmacyCampaign.updateManyAndReturn({
        where: { organizationId, status: 'ACCOUNT_QUALITY_HOLD', holdPreviousStatus: next },
        data: { status: next, holdPreviousStatus: null, refusalReason: null },
        select: { id: true },
      });
      changed.push(
        ...rows.map(({ id }) => ({ id, previous: 'ACCOUNT_QUALITY_HOLD' as const, next }))
      );
    }
  }
  return changed;
}

/** Alert owners and retain an immutable system audit of every campaign hold/recovery. */
export async function applyAccountQualityUpdates(
  db: ScopedDb,
  organizationId: string,
  updates: AccountQualityUpdate[],
  appealUrl: string
) {
  if (updates.length === 0) return { alerts: 0, paused: 0, restored: 0 };
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
  let restored = 0;
  for (const update of updates) {
    const updateAlerts = await alertOwners(
      db,
      organizationId,
      owners.map(({ id }) => id),
      update,
      appealUrl
    );
    alerts += updateAlerts;
    const changed = await changeCampaigns(db, organizationId, update);
    if (update.action === 'hold') paused += changed.length;
    else restored += changed.length;
    if (updateAlerts === 0 && changed.length === 0) continue;
    await db.auditLog.create({
      data: {
        organizationId,
        actorType: 'SYSTEM',
        actorName: 'Meta WhatsApp webhook',
        source: 'SYSTEM',
        category: 'PHARMACY',
        operation: 'UPDATE',
        action: `pharmacy.whatsapp.accountQuality.${update.action}`,
        targetType: 'PharmacyCampaign',
        targetId: `whatsapp-account:${update.key}`,
        description: `Processed WhatsApp account-quality ${update.level} event.`,
        input: { providerEvent: update.event, eventKey: update.key },
        changes: { campaigns: changed },
        result: {
          affectedCampaignIds: changed.map(({ id }) => id),
          campaignCount: changed.length,
          ownerAlertCount: updateAlerts,
        },
      },
    });
  }
  return { alerts, paused, restored };
}
