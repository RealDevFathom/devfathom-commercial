import 'server-only';

import { z } from 'zod';

import type { Prisma } from '@/generated/prisma/client';

/**
 * M7-L5 / D21 — restaurant notifications: the channel matrix, the fan-out that
 * turns one notification request into an in-app row plus per-channel delivery
 * records, and the per-recipient read-state reads the notifications center is
 * built on.
 *
 * What is REAL vs STUBBED in M7 (never blurred):
 *   - IN_APP is REAL. A fanned-out request creates ONE persisted
 *     `RestaurantNotification` row (the durable inbox entry + per-recipient read
 *     state) and, when IN_APP is enabled for the category, a `DELIVERED_IN_APP`
 *     delivery record. The inbox list is exactly the notifications that carry
 *     such a record.
 *   - EMAIL / SMS / WEBHOOK are STUBBED. Their adapters ({@link deliverViaStub})
 *     do NO provider I/O — no SDKs, no secrets, no network — and ONLY persist a
 *     `RestaurantNotificationDelivery` row with status `STUBBED`. They are never
 *     claimed as sent. D21 stays OPEN for the real providers; this is the seam a
 *     later integration fills without a schema change.
 *
 * Channel matrix (`RestaurantNotificationChannelSetting`): a category × channel
 * enable/disable grid. A row with a null `branchId` is the org default; a row
 * with a set `branchId` is a branch override that wins for that branch. A channel
 * with NO row anywhere defaults to ENABLED (the D21 "IN_APP is always delivered"
 * default, applied uniformly so a category is fully wired out of the box). An
 * explicit `enabled = false` row therefore SUPPRESSES the channel — a suppressed
 * channel yields NO delivery record (matrix-off = nothing recorded).
 */

// ---------------------------------------------------------------------------
// Channels.
// ---------------------------------------------------------------------------

/** Every delivery channel, matching the `RestaurantNotificationChannel` enum. */
export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'WEBHOOK'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** The channels whose adapters are STUBBED in M7 (everything except IN_APP). */
export const EXTERNAL_STUB_CHANNELS = ['EMAIL', 'SMS', 'WEBHOOK'] as const;
export type ExternalStubChannel = (typeof EXTERNAL_STUB_CHANNELS)[number];

/** The delivery statuses this lane writes (FAILED is reserved for a real adapter). */
export type NotificationDeliveryStatus = 'DELIVERED_IN_APP' | 'STUBBED';

// ---------------------------------------------------------------------------
// The notification-request contract.
// ---------------------------------------------------------------------------

/**
 * One notification request: what a producing lane hands the fan-out. It carries
 * the business fields only — `organizationId` is NEVER part of a request (it is
 * the RLS-forced tenant default on every row). `entityType` + `entityId` are a
 * loose (un-foreign-keyed) reference to the thing the notification is about; when
 * both are present they also anchor idempotency (see {@link fanOutNotification}).
 */
export const NotificationRequestSchema = z
  .object({
    recipientStaffProfileId: z.string().min(1),
    branchId: z.string().min(1).nullable().optional(),
    category: z.string().min(1).max(255),
    title: z.string().min(1).max(500),
    body: z.string().max(4_000).nullable().optional(),
    entityType: z.string().min(1).max(255).nullable().optional(),
    entityId: z.string().min(1).max(255).nullable().optional(),
  })
  .strict();

export type NotificationRequest = z.infer<typeof NotificationRequestSchema>;

// ---------------------------------------------------------------------------
// Transaction-client surfaces (the minimal delegates each operation needs).
// ---------------------------------------------------------------------------

/** The delegates the fan-out + matrix resolution touch. The Prisma interactive
 * transaction client satisfies it, so the fan-out runs inside ONE tenant tx. */
export type NotificationFanOutClient = Pick<
  Prisma.TransactionClient,
  | 'restaurantNotification'
  | 'restaurantNotificationDelivery'
  | 'restaurantNotificationChannelSetting'
>;

/** The delegates the recipient-facing reads + read-state writes touch. */
export type NotificationReadClient = Pick<Prisma.TransactionClient, 'restaurantNotification'>;

/** The delegates the channel-matrix admin surface touches. */
export type ChannelSettingClient = Pick<
  Prisma.TransactionClient,
  'restaurantNotificationChannelSetting'
>;

// ---------------------------------------------------------------------------
// Channel-matrix resolution.
// ---------------------------------------------------------------------------

export type ChannelMatrix = Record<NotificationChannel, boolean>;

/**
 * Resolve the effective enable/disable matrix for a `(branchId, category)`. Branch
 * overrides win over org defaults; a channel with no row defaults to enabled. Pass
 * `branchId = null` (an org-level request) to consider org defaults only.
 */
export async function resolveChannelMatrix(
  db: ChannelSettingClient,
  params: { branchId?: string | null; category: string }
): Promise<ChannelMatrix> {
  const branchId = params.branchId ?? null;
  const rows = await db.restaurantNotificationChannelSetting.findMany({
    where: {
      category: params.category,
      OR: branchId ? [{ branchId: null }, { branchId }] : [{ branchId: null }],
    },
    select: { branchId: true, channel: true, enabled: true },
  });

  const orgDefaults = new Map<string, boolean>();
  const branchOverrides = new Map<string, boolean>();
  for (const row of rows) {
    if (row.branchId === null) orgDefaults.set(row.channel, row.enabled);
    else branchOverrides.set(row.channel, row.enabled);
  }

  const matrix = {} as ChannelMatrix;
  for (const channel of NOTIFICATION_CHANNELS) {
    if (branchId && branchOverrides.has(channel)) {
      matrix[channel] = branchOverrides.get(channel)!;
    } else if (orgDefaults.has(channel)) {
      matrix[channel] = orgDefaults.get(channel)!;
    } else {
      matrix[channel] = true; // default-enabled when no setting row exists
    }
  }
  return matrix;
}

// ---------------------------------------------------------------------------
// Stub adapters (EMAIL / SMS / WEBHOOK) — D21 seam, no real delivery.
// ---------------------------------------------------------------------------

export type StubDeliveryResult = { channel: ExternalStubChannel; status: 'STUBBED' };

/**
 * The stub adapter for a non-in-app channel. It performs NO provider I/O — no SDK,
 * no secret, no network call — and only reports the `STUBBED` outcome the fan-out
 * persists. This is the entire external-channel surface in M7: recorded, never
 * sent. A real provider integration replaces the body here (D21) without touching
 * the fan-out or the schema.
 */
export function deliverViaStub(channel: ExternalStubChannel): StubDeliveryResult {
  return { channel, status: 'STUBBED' };
}

// ---------------------------------------------------------------------------
// Fan-out.
// ---------------------------------------------------------------------------

export type NotificationDeliveryOutcome = {
  channel: NotificationChannel;
  status: NotificationDeliveryStatus;
};

export type FanOutResult = {
  /** The in-app notification row's id, or null when the request was suppressed. */
  notificationId: string | null;
  /** True when a NEW notification row was created (false = suppressed or idempotent no-op). */
  created: boolean;
  /** True when every channel is matrix-off, so nothing was recorded. */
  suppressed: boolean;
  /** The delivery records written this call (empty on suppression / idempotent no-op). */
  deliveries: NotificationDeliveryOutcome[];
};

/**
 * Fan ONE notification request out across its enabled channels, inside the caller's
 * tenant transaction. Resolves the channel matrix, then:
 *   - if EVERY channel is matrix-off → records NOTHING (suppressed);
 *   - otherwise creates ONE `RestaurantNotification` row (the durable inbox entry)
 *     and, for each enabled channel, one `RestaurantNotificationDelivery` row:
 *     IN_APP → `DELIVERED_IN_APP` (real), EMAIL/SMS/WEBHOOK → `STUBBED` (via
 *     {@link deliverViaStub}). A matrix-off channel gets NO delivery record.
 *
 * Idempotency (at-least-once safe): when the request carries an entity reference
 * (`entityType` + `entityId`), a re-run that matches an existing notification with
 * the same recipient, category, entity, and title is a no-op — the guard that lets
 * this run as an outbox consumer (redelivery after a crash) or a retried job. A
 * request with no entity reference relies on the transport's own dedupe (the
 * scheduler `idempotencyKey`); this caveat is recorded in BUILD-ASSUMPTIONS.
 */
export async function fanOutNotification(
  db: NotificationFanOutClient,
  request: NotificationRequest
): Promise<FanOutResult> {
  const branchId = request.branchId ?? null;
  const entityType = request.entityType ?? null;
  const entityId = request.entityId ?? null;

  const matrix = await resolveChannelMatrix(db, { branchId, category: request.category });
  const channels = NOTIFICATION_CHANNELS.filter((channel) => matrix[channel]);
  if (channels.length === 0) {
    return { notificationId: null, created: false, suppressed: true, deliveries: [] };
  }

  // Idempotency guard — only when the request is entity-anchored.
  if (entityType && entityId) {
    const existing = await db.restaurantNotification.findFirst({
      where: {
        recipientStaffProfileId: request.recipientStaffProfileId,
        category: request.category,
        entityType,
        entityId,
        title: request.title,
      },
      select: { id: true },
    });
    if (existing) {
      return { notificationId: existing.id, created: false, suppressed: false, deliveries: [] };
    }
  }

  const notification = await db.restaurantNotification.create({
    data: {
      recipientStaffProfileId: request.recipientStaffProfileId,
      branchId,
      category: request.category,
      title: request.title,
      body: request.body ?? null,
      entityType,
      entityId,
    },
    select: { id: true },
  });

  const deliveries: NotificationDeliveryOutcome[] = [];
  for (const channel of channels) {
    const status: NotificationDeliveryStatus =
      channel === 'IN_APP' ? 'DELIVERED_IN_APP' : deliverViaStub(channel).status;
    await db.restaurantNotificationDelivery.create({
      data: { notificationId: notification.id, channel, status },
    });
    deliveries.push({ channel, status });
  }

  return { notificationId: notification.id, created: true, suppressed: false, deliveries };
}

// ---------------------------------------------------------------------------
// Recipient-facing reads + read state (the notifications center contract).
// ---------------------------------------------------------------------------

/** A notification is "in-app" iff it carries a real DELIVERED_IN_APP delivery. */
const IN_APP_DELIVERED = {
  deliveries: { some: { channel: 'IN_APP', status: 'DELIVERED_IN_APP' } },
} as const;

export type NotificationListItem = {
  id: string;
  category: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  branchId: string | null;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
};

export type NotificationListResult = {
  items: NotificationListItem[];
  unreadCount: number;
  nextCursor: string | null;
};

/**
 * List a recipient's in-app notifications, newest first, with the recipient's
 * unread count. Only notifications with a DELIVERED_IN_APP record appear (a
 * category delivered on EMAIL only is never in the inbox). `unreadCount` is the
 * total unread across the inbox, independent of the current page / `unreadOnly`.
 */
export async function listInAppNotifications(
  db: NotificationReadClient,
  params: {
    recipientStaffProfileId: string;
    unreadOnly?: boolean;
    limit?: number;
    cursor?: string | null;
  }
): Promise<NotificationListResult> {
  const limit = params.limit ?? 50;
  const where = {
    recipientStaffProfileId: params.recipientStaffProfileId,
    ...IN_APP_DELIVERED,
    ...(params.unreadOnly ? { isRead: false } : {}),
  };

  const rows = await db.restaurantNotification.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      category: true,
      title: true,
      body: true,
      entityType: true,
      entityId: true,
      branchId: true,
      isRead: true,
      readAt: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  const unreadCount = await db.restaurantNotification.count({
    where: {
      recipientStaffProfileId: params.recipientStaffProfileId,
      isRead: false,
      ...IN_APP_DELIVERED,
    },
  });

  return {
    items,
    unreadCount,
    nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
  };
}

export type MarkReadResult = { found: boolean; updated: boolean };

/**
 * Mark ONE notification read for its recipient. Ownership is enforced in the
 * `where` clause (a caller can only read-mark their own row). Re-marking an
 * already-read notification is a no-op that leaves the original `readAt` intact.
 * Returns whether the row was found (for the recipient) and whether this call
 * flipped it to read.
 */
export async function markNotificationRead(
  db: NotificationReadClient,
  params: { notificationId: string; recipientStaffProfileId: string; now?: Date }
): Promise<MarkReadResult> {
  const now = params.now ?? new Date();
  const result = await db.restaurantNotification.updateMany({
    where: {
      id: params.notificationId,
      recipientStaffProfileId: params.recipientStaffProfileId,
      isRead: false,
    },
    data: { isRead: true, readAt: now },
  });
  if (result.count > 0) return { found: true, updated: true };

  // Nothing updated: either the row isn't the recipient's (not found) or it was
  // already read. Distinguish so the caller can return NOT_FOUND vs a benign no-op.
  const owned = await db.restaurantNotification.findFirst({
    where: {
      id: params.notificationId,
      recipientStaffProfileId: params.recipientStaffProfileId,
    },
    select: { id: true },
  });
  return { found: Boolean(owned), updated: false };
}

/**
 * Mark every unread notification read for a recipient. Returns the number flipped.
 * Idempotent — a second call with nothing unread returns 0.
 */
export async function markAllNotificationsRead(
  db: NotificationReadClient,
  params: { recipientStaffProfileId: string; now?: Date }
): Promise<{ updated: number }> {
  const now = params.now ?? new Date();
  const result = await db.restaurantNotification.updateMany({
    where: { recipientStaffProfileId: params.recipientStaffProfileId, isRead: false },
    data: { isRead: true, readAt: now },
  });
  return { updated: result.count };
}

// ---------------------------------------------------------------------------
// Channel-matrix admin (read + upsert).
// ---------------------------------------------------------------------------

export type ChannelSettingRow = {
  id: string;
  branchId: string | null;
  category: string;
  channel: NotificationChannel;
  enabled: boolean;
};

/** List the raw channel-setting rows (org defaults + branch overrides), filtered
 * by branch and/or category when provided. Ordered for a stable admin view. */
export async function listChannelSettings(
  db: ChannelSettingClient,
  params: { branchId?: string | null; category?: string } = {}
): Promise<ChannelSettingRow[]> {
  const where: Record<string, unknown> = {};
  if (params.branchId !== undefined) where['branchId'] = params.branchId;
  if (params.category !== undefined) where['category'] = params.category;
  return db.restaurantNotificationChannelSetting.findMany({
    where,
    orderBy: [{ category: 'asc' }, { branchId: 'asc' }, { channel: 'asc' }],
    select: { id: true, branchId: true, category: true, channel: true, enabled: true },
  });
}

/**
 * Enable or disable ONE `(branchId, category, channel)` cell of the matrix. A null
 * `branchId` writes the org default; a set `branchId` writes a branch override.
 * Implemented as find-then-write (not a compound upsert) because `organizationId`
 * is the RLS-forced default and is never supplied by app code; the tenant scope
 * makes the `findFirst` see only this org's row.
 */
export async function upsertChannelSetting(
  db: ChannelSettingClient,
  params: {
    branchId?: string | null;
    category: string;
    channel: NotificationChannel;
    enabled: boolean;
  }
): Promise<ChannelSettingRow> {
  const branchId = params.branchId ?? null;
  const existing = await db.restaurantNotificationChannelSetting.findFirst({
    where: { branchId, category: params.category, channel: params.channel },
    select: { id: true },
  });
  if (existing) {
    return db.restaurantNotificationChannelSetting.update({
      where: { id: existing.id },
      data: { enabled: params.enabled },
      select: { id: true, branchId: true, category: true, channel: true, enabled: true },
    });
  }
  return db.restaurantNotificationChannelSetting.create({
    data: { branchId, category: params.category, channel: params.channel, enabled: params.enabled },
    select: { id: true, branchId: true, category: true, channel: true, enabled: true },
  });
}
