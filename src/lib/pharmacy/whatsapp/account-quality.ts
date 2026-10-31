import { createHash } from 'node:crypto';

import type { PharmacyCampaignStatus } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * Meta `account_update` events that affect sending. `DISABLED_UPDATE` carries the
 * real ban state in `value.ban_info.waba_ban_state`; that state, not the event
 * name, decides between a scheduled disable, a disable and a reinstatement.
 */
type AccountQualityIssue = 'DISABLED' | 'RESTRICTION' | 'VIOLATION';

export type AccountQualityUpdate = {
  /** Unique per provider occurrence; retried deliveries of the same occurrence repeat it. */
  key: string;
  action: 'hold' | 'recover';
  level: 'warning' | 'block' | 'recovery';
  issue: AccountQualityIssue;
  event: string;
  occurredAt: Date | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const BAN_STATES = new Set(['SCHEDULE_FOR_DISABLE', 'DISABLE', 'REINSTATE']);

function banState(value: Record<string, unknown> | null): string | null {
  const raw = object(value?.ban_info)?.waba_ban_state;
  const states = (Array.isArray(raw) ? raw : [raw])
    .filter((state): state is string => typeof state === 'string')
    .map((state) => state.trim().toUpperCase());
  return states.find((state) => BAN_STATES.has(state)) ?? null;
}

function classify(
  event: string,
  value: Record<string, unknown> | null
): (Pick<AccountQualityUpdate, 'action' | 'level' | 'issue'> & { state: string | null }) | null {
  if (event === 'DISABLED_UPDATE') {
    const state = banState(value);
    if (state === 'REINSTATE')
      return { action: 'recover', level: 'recovery', issue: 'DISABLED', state };
    if (state === 'SCHEDULE_FOR_DISABLE')
      return { action: 'hold', level: 'warning', issue: 'DISABLED', state };
    // DISABLE, or an unreadable ban state on a disable notice: fail closed.
    return { action: 'hold', level: 'block', issue: 'DISABLED', state };
  }
  if (event === 'ACCOUNT_RESTRICTION')
    return { action: 'hold', level: 'block', issue: 'RESTRICTION', state: null };
  if (event === 'ACCOUNT_VIOLATION')
    return { action: 'hold', level: 'warning', issue: 'VIOLATION', state: null };
  return null;
}

/** Parse only explicitly supported Meta `account_update` events. Unknown events fail open. */
export function parseAccountQualityUpdates(
  payload: unknown,
  ownedBusinessAccountId: string | null | undefined
): AccountQualityUpdate[] {
  if (!ownedBusinessAccountId) return [];
  const root = object(payload);
  if (root?.object !== 'whatsapp_business_account' || !Array.isArray(root.entry)) return [];
  const updates: AccountQualityUpdate[] = [];
  for (const rawEntry of root.entry) {
    const entry = object(rawEntry);
    if (entry?.id !== ownedBusinessAccountId || !Array.isArray(entry.changes)) continue;
    const time = typeof entry.time === 'number' && Number.isFinite(entry.time) ? entry.time : null;
    for (const rawChange of entry.changes) {
      const change = object(rawChange);
      if (change?.field !== 'account_update') continue;
      const value = object(change.value);
      const rawEvent = value?.event;
      if (typeof rawEvent !== 'string') continue;
      const event = rawEvent.trim().toUpperCase().slice(0, 80);
      const result = classify(event, value);
      if (!result) continue;
      const { state, ...classified } = result;
      // Meta retries the identical entry; a later strike differs in time or details.
      const occurrence = createHash('sha256')
        .update(JSON.stringify({ time, value }))
        .digest('hex')
        .slice(0, 24);
      updates.push({
        key: [ownedBusinessAccountId, event, state, occurrence].filter(Boolean).join(':'),
        ...classified,
        event: state ? `${event}:${state}` : event,
        occurredAt: time === null ? null : new Date(time * 1000),
      });
    }
  }
  return updates;
}

const HOLD_EVENTS_UNRESOLVED = (organizationId: string) => ({
  organizationId,
  action: 'HOLD',
  resolvedAt: null,
});

/** True while any provider account-quality hold is unresolved for the tenant. */
export async function isWhatsAppAccountQualityHeld(db: ScopedDb, organizationId: string) {
  const hold = await db.pharmacyWhatsAppQualityEvent.findFirst({
    where: HOLD_EVENTS_UNRESOLVED(organizationId),
    select: { id: true },
  });
  return hold !== null;
}

/** Owner-facing summary of the unresolved holds. */
export async function whatsAppAccountQualityStatus(db: ScopedDb, organizationId: string) {
  const [holds, heldCampaigns] = await Promise.all([
    db.pharmacyWhatsAppQualityEvent.findMany({
      where: HOLD_EVENTS_UNRESOLVED(organizationId),
      select: { event: true, level: true, issue: true, occurredAt: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 10,
    }),
    db.pharmacyCampaign.count({ where: { organizationId, status: 'ACCOUNT_QUALITY_HOLD' } }),
  ]);
  return { held: holds.length > 0, holds, heldCampaigns };
}

async function alertOwners(
  db: ScopedDb,
  organizationId: string,
  ownerIds: string[],
  update: AccountQualityUpdate,
  message: { title: string; body: string }
) {
  if (!ownerIds.length) return 0;
  const result = await db.notification.createMany({
    data: ownerIds.map((userId) => ({
      organizationId,
      userId,
      type: 'pharmacy_whatsapp_account_quality',
      title: message.title,
      message: message.body,
      entityType: 'whatsapp_account_quality',
      entityId: `whatsapp-account:${update.key}`,
    })),
    skipDuplicates: true,
  });
  return result.count;
}

type CampaignChange = {
  id: string;
  previous: PharmacyCampaignStatus;
  next: PharmacyCampaignStatus;
};

async function holdCampaigns(db: ScopedDb, organizationId: string) {
  const changed: CampaignChange[] = [];
  for (const previous of ['APPROVED', 'CAPTURED'] as const) {
    const rows = await db.pharmacyCampaign.updateManyAndReturn({
      where: { organizationId, status: previous },
      data: { status: 'ACCOUNT_QUALITY_HOLD', holdPreviousStatus: previous },
      select: { id: true },
    });
    changed.push(
      ...rows.map(({ id }) => ({ id, previous, next: 'ACCOUNT_QUALITY_HOLD' as const }))
    );
  }
  return changed;
}

async function restoreCampaigns(db: ScopedDb, organizationId: string) {
  const changed: CampaignChange[] = [];
  for (const next of ['APPROVED', 'CAPTURED'] as const) {
    const rows = await db.pharmacyCampaign.updateManyAndReturn({
      where: { organizationId, status: 'ACCOUNT_QUALITY_HOLD', holdPreviousStatus: next },
      data: { status: next, holdPreviousStatus: null },
      select: { id: true },
    });
    changed.push(
      ...rows.map(({ id }) => ({ id, previous: 'ACCOUNT_QUALITY_HOLD' as const, next }))
    );
  }
  return changed;
}

/**
 * Record each new provider occurrence once, alert owners, hold or restore feeds,
 * and retain an immutable system audit. Retried deliveries are a durable no-op.
 */
export async function applyAccountQualityUpdates(
  db: ScopedDb,
  organizationId: string,
  updates: AccountQualityUpdate[],
  appealUrl: string,
  now = new Date()
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
  const ownerIds = owners.map(({ id }) => id);
  let alerts = 0;
  let paused = 0;
  let restored = 0;
  for (const update of updates) {
    const recorded = await db.pharmacyWhatsAppQualityEvent.createMany({
      data: [
        {
          organizationId,
          eventKey: update.key,
          event: update.event,
          issue: update.issue,
          action: update.action === 'hold' ? 'HOLD' : 'RECOVER',
          level: update.level,
          occurredAt: update.occurredAt,
        },
      ],
      skipDuplicates: true,
    });
    if (recorded.count === 0) continue;

    let changed: CampaignChange[] = [];
    let resolvedHolds = 0;
    let remainingHolds = 0;
    let message: { title: string; body: string } | null = null;
    if (update.action === 'hold') {
      changed = await holdCampaigns(db, organizationId);
      paused += changed.length;
      message = {
        title: update.level === 'block' ? 'WhatsApp sending blocked' : 'WhatsApp account warning',
        body: `Meta reported ${update.event}. Outbound WhatsApp feeds are on hold until Meta reinstates the account or an owner resumes sending from Pharmacy marketing. Review or appeal: ${appealUrl}`,
      };
    } else {
      resolvedHolds = (
        await db.pharmacyWhatsAppQualityEvent.updateMany({
          where: { ...HOLD_EVENTS_UNRESOLVED(organizationId), issue: update.issue },
          data: { resolvedAt: now },
        })
      ).count;
      remainingHolds = await db.pharmacyWhatsAppQualityEvent.count({
        where: HOLD_EVENTS_UNRESOLVED(organizationId),
      });
      if (remainingHolds === 0) changed = await restoreCampaigns(db, organizationId);
      restored += changed.length;
      if (resolvedHolds > 0 || changed.length > 0)
        message =
          remainingHolds === 0
            ? {
                title: 'WhatsApp sending restored',
                body: 'Meta reinstated the WhatsApp account. Outbound WhatsApp feeds held by account quality were restored.',
              }
            : {
                title: 'WhatsApp account reinstated; other holds remain',
                body: `Meta reinstated the WhatsApp account, but other account-quality issues still hold outbound WhatsApp feeds. Resume from Pharmacy marketing once they are resolved: ${appealUrl}`,
              };
    }
    const updateAlerts = message
      ? await alertOwners(db, organizationId, ownerIds, update, message)
      : 0;
    alerts += updateAlerts;
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
          resolvedHoldCount: resolvedHolds,
          remainingHoldCount: remainingHolds,
        },
      },
    });
  }
  return { alerts, paused, restored };
}

/**
 * Owner confirms the account is healthy in Meta Account Quality: resolve every
 * open hold and return held campaigns to their pre-hold state.
 */
export async function resumeWhatsAppAccountQualityHold(
  db: ScopedDb,
  organizationId: string,
  actorId: string,
  now = new Date()
) {
  const resolved = await db.pharmacyWhatsAppQualityEvent.updateMany({
    where: HOLD_EVENTS_UNRESOLVED(organizationId),
    data: { resolvedAt: now, resolvedByUserId: actorId },
  });
  const changed = await restoreCampaigns(db, organizationId);
  if (resolved.count === 0 && changed.length === 0) return { resolved: 0, restored: 0 };
  await db.auditLog.create({
    data: {
      organizationId,
      actorType: 'USER',
      actorId,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'UPDATE',
      action: 'pharmacy.whatsapp.accountQuality.ownerResume',
      targetType: 'PharmacyCampaign',
      targetId: 'whatsapp-account',
      description: 'Owner resumed WhatsApp feeds held by account quality.',
      changes: { campaigns: changed },
      result: {
        affectedCampaignIds: changed.map(({ id }) => id),
        campaignCount: changed.length,
        resolvedHoldCount: resolved.count,
      },
    },
  });
  return { resolved: resolved.count, restored: changed.length };
}
