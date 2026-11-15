import { createHash } from 'node:crypto';

import { z } from 'zod';

import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-22 — WhatsApp strike and account-quality monitor.
 *
 * Meta posts `account_update` (strikes, restrictions, bans) and
 * `phone_number_quality_update` (quality flag / messaging-limit changes) to the
 * same signed webhook as messages. Each change is stored once as immutable
 * evidence, raises an in-app alert for the tenant owners with the appeal link,
 * and the latest evidence decides whether marketing sends are auto-paused.
 *
 * Call only after raw-body signature verification and tenant binding.
 * Alert text is account-level only and never names a product or category.
 */

export type AccountSeverity = 'INFO' | 'WARNING' | 'BLOCK' | 'CLEARED';
export type AccountField = 'account_update' | 'phone_number_quality_update';

export type AccountChange = {
  businessAccountId: string;
  field: AccountField;
  event: string;
  severity: AccountSeverity;
  detail: string | null;
  restrictedUntil: Date | null;
  occurredAt: Date;
  eventKey: string;
};

/** Meta's documented appeal surface; tenants may point at their own BSP console. */
export const DEFAULT_WHATSAPP_APPEAL_URL = 'https://business.facebook.com/business-support-home';

export function whatsappAppealUrl(env: Record<string, string | undefined> = process.env) {
  const raw = env.PHARMACY_WHATSAPP_APPEAL_URL?.trim();
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:') return url.toString();
    } catch {
      // fall through to the default
    }
  }
  return DEFAULT_WHATSAPP_APPEAL_URL;
}

const text = z.string().trim().min(1).max(128);
const unix = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number);
const changeSchema = z.object({
  field: z.string(),
  value: z
    .object({
      event: text,
      violation_info: z.object({ violation_type: text.optional() }).partial().optional(),
      ban_info: z.object({ waba_ban_state: text.optional() }).partial().optional(),
      restriction_info: z
        .array(z.object({ restriction_type: text.optional(), expiration: unix.optional() }))
        .max(20)
        .optional(),
      current_limit: text.optional(),
    })
    .passthrough(),
});
const payloadSchema = z.object({
  entry: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        time: unix.optional(),
        changes: z.array(z.unknown()).max(500),
      })
    )
    .max(500),
});

function classify(
  field: AccountField,
  value: z.infer<typeof changeSchema>['value']
): Pick<AccountChange, 'severity' | 'detail' | 'restrictedUntil'> {
  const event = value.event.toUpperCase();
  if (field === 'phone_number_quality_update') {
    const detail = value.current_limit ?? null;
    if (event === 'FLAGGED' || event === 'DOWNGRADE')
      return { severity: 'WARNING', detail, restrictedUntil: null };
    if (event === 'UNFLAGGED' || event === 'UPGRADE')
      return { severity: 'CLEARED', detail, restrictedUntil: null };
    return { severity: 'INFO', detail, restrictedUntil: null };
  }
  if (event === 'ACCOUNT_VIOLATION')
    return {
      severity: 'WARNING',
      detail: value.violation_info?.violation_type ?? null,
      restrictedUntil: null,
    };
  if (event === 'ACCOUNT_RESTRICTION') {
    const restrictions = value.restriction_info ?? [];
    const expirations = restrictions
      .map((item) => item.expiration)
      .filter((item): item is number => Number.isSafeInteger(item) && item! > 0);
    return {
      severity: 'BLOCK',
      detail:
        restrictions
          .map((item) => item.restriction_type)
          .filter(Boolean)
          .join(',') || null,
      restrictedUntil: expirations.length ? new Date(Math.max(...expirations) * 1000) : null,
    };
  }
  if (event === 'DISABLED_UPDATE') {
    const state = value.ban_info?.waba_ban_state?.toUpperCase() ?? null;
    return {
      severity: state === 'REINSTATE' ? 'CLEARED' : 'BLOCK',
      detail: state,
      restrictedUntil: null,
    };
  }
  if (event === 'ACCOUNT_DELETED')
    return { severity: 'BLOCK', detail: null, restrictedUntil: null };
  return { severity: 'INFO', detail: null, restrictedUntil: null };
}

/** Extracts account-health changes for the bound business account only. */
export function parseAccountChanges(
  payload: unknown,
  ownedBusinessAccountId: string | null | undefined,
  now = new Date()
): AccountChange[] {
  if (!ownedBusinessAccountId) return [];
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return [];
  const changes: AccountChange[] = [];
  for (const entry of parsed.data.entry) {
    if (entry.id !== ownedBusinessAccountId) continue;
    const time = entry.time && Number.isSafeInteger(entry.time) ? new Date(entry.time * 1000) : now;
    // A provider clock ahead of ours is clamped so it cannot pre-date future evidence.
    const occurredAt = time > now ? now : time;
    for (const raw of entry.changes) {
      const change = changeSchema.safeParse(raw);
      if (!change.success) continue;
      const field = change.data.field;
      if (field !== 'account_update' && field !== 'phone_number_quality_update') continue;
      const classified = classify(field, change.data.value);
      const event = change.data.value.event.toUpperCase();
      changes.push({
        businessAccountId: entry.id,
        field,
        event,
        ...classified,
        occurredAt,
        eventKey: createHash('sha256')
          .update(
            JSON.stringify([field, entry.id, event, classified.detail, occurredAt.toISOString()])
          )
          .digest('hex'),
      });
    }
  }
  return changes;
}

const ALERT_TITLES: Record<Exclude<AccountSeverity, 'INFO'>, string> = {
  WARNING: 'WhatsApp account warning',
  BLOCK: 'WhatsApp account blocked',
  CLEARED: 'WhatsApp account restored',
};

export function accountAlertMessage(change: AccountChange, appealUrl: string): string {
  const what =
    change.field === 'phone_number_quality_update'
      ? `Meta reported a quality change (${change.event}) on your WhatsApp number.`
      : `Meta reported ${change.event} on your WhatsApp business account.`;
  if (change.severity === 'CLEARED')
    return `${what} Marketing sends resume when no other block is active.`;
  const until = change.restrictedUntil ? ` until ${change.restrictedUntil.toISOString()}` : '';
  const effect =
    change.severity === 'BLOCK' || change.event === 'FLAGGED'
      ? `Marketing sends are paused${until}.`
      : 'Review your recent templates and opt-outs.';
  return `${what} ${effect} Review or appeal: ${appealUrl}`;
}

async function ownerUserIds(db: ScopedDb, organizationId: string, now: Date) {
  const users = await db.user.findMany({
    where: { organizationId, status: 'ACTIVE' },
    select: {
      id: true,
      role: true,
      status: true,
      organizationRole: { select: { key: true, isSystem: true, permissions: true } },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { capability: true, effect: true },
      },
    },
    take: 200,
  });
  return users.filter((user) => hasAllCapabilityAccess(user)).map((user) => user.id);
}

/** Stores each change once; only newly stored WARNING/BLOCK/CLEARED rows alert the owners. */
export async function recordAccountChanges(
  db: ScopedDb,
  organizationId: string,
  changes: AccountChange[],
  { now = new Date(), appealUrl = whatsappAppealUrl() }: { now?: Date; appealUrl?: string } = {}
) {
  let recorded = 0;
  let alerted = 0;
  for (const change of changes) {
    const stored = await db.pharmacyWhatsAppAccountEvent.createMany({
      skipDuplicates: true,
      data: {
        organizationId,
        businessAccountId: change.businessAccountId,
        field: change.field,
        event: change.event,
        severity: change.severity,
        detail: change.detail,
        restrictedUntil: change.restrictedUntil,
        eventKey: change.eventKey,
        occurredAt: change.occurredAt,
      },
    });
    if (!stored.count) continue;
    recorded += 1;
    if (change.severity === 'INFO') continue;
    const event = await db.pharmacyWhatsAppAccountEvent.findFirst({
      where: { organizationId, eventKey: change.eventKey },
      select: { id: true },
    });
    const owners = await ownerUserIds(db, organizationId, now);
    if (!owners.length) continue;
    await db.notification.createMany({
      data: owners.map((userId) => ({
        organizationId,
        userId,
        type: 'pharmacy_whatsapp_account',
        title: ALERT_TITLES[change.severity as Exclude<AccountSeverity, 'INFO'>],
        message: accountAlertMessage(change, appealUrl),
        entityType: 'PharmacyWhatsAppAccountEvent',
        entityId: event?.id ?? null,
      })),
    });
    alerted += owners.length;
  }
  return { recorded, alerted };
}

export type MarketingPause =
  { paused: false } | { paused: true; reason: string; until: Date | null };

/**
 * Auto-pause decision from the latest non-INFO evidence per signal: an active
 * account block, or a quality flag that Meta has not yet cleared.
 */
export async function whatsappMarketingPause(
  db: ScopedDb,
  organizationId: string,
  now = new Date()
): Promise<MarketingPause> {
  const rows = await db.pharmacyWhatsAppAccountEvent.findMany({
    where: { organizationId, severity: { in: ['WARNING', 'BLOCK', 'CLEARED'] } },
    orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
    select: { field: true, event: true, severity: true, restrictedUntil: true },
    take: 200,
  });
  const account = rows.find((row) => row.field === 'account_update' && row.severity !== 'WARNING');
  if (account?.severity === 'BLOCK' && (!account.restrictedUntil || account.restrictedUntil > now))
    return { paused: true, reason: account.event, until: account.restrictedUntil };
  const quality = rows.find(
    (row) =>
      row.field === 'phone_number_quality_update' &&
      (row.event === 'FLAGGED' || row.event === 'UNFLAGGED')
  );
  if (quality?.event === 'FLAGGED') return { paused: true, reason: quality.event, until: null };
  return { paused: false };
}
