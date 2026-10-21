import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import { sendEmail } from '@/lib/email';
import type { EmailContent } from '@/lib/email';
import { inSideEffectScope, trackSideEffect } from '@/lib/side-effects/scope';

/* ============================================================
   IMP-AUTH-04 — per-user notification preferences
   ============================================================
   A small, typed model layered over notify(). Each NotifyArgs.type
   maps to one CATEGORY; each delivery flows through one of two
   CHANNELS (in-app row + email). Users may opt OUT of any
   category × channel cell. Anything unset defaults to ON. */

export const NOTIFICATION_CATEGORIES = [
  'task',
  'mention',
  'meeting',
  'leave',
  'invoice',
  'project',
  'client',
  'resignation',
  'note',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CHANNELS = ['inApp', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Stored on User.notificationPrefs (Json?). Sparse by design: a missing
 * category, a missing channel, or `true` all mean "opted in". Only an
 * explicit `false` opts the user out of that category × channel cell, so an
 * absent/empty record = everything ON.
 */
export type NotificationPrefs = Partial<
  Record<NotificationCategory, Partial<Record<NotificationChannel, boolean>>>
>;

/**
 * Map a NotifyArgs.type tag onto its category. Returns null for unrecognized
 * tags — callers treat null as "never suppress" so a new/unmapped type is
 * always delivered (fail-open, like the rest of notify()).
 */
export function categoryForType(type: string): NotificationCategory | null {
  if (type.startsWith('task_')) return 'task';
  if (type === 'mention') return 'mention';
  if (type.startsWith('meeting_')) return 'meeting';
  if (type.startsWith('leave_')) return 'leave';
  if (type.startsWith('invoice_')) return 'invoice';
  if (type.startsWith('project_')) return 'project';
  if (type.startsWith('client_') || type.startsWith('contract_')) return 'client';
  if (type.startsWith('resignation_')) return 'resignation';
  if (type.startsWith('note_')) return 'note';
  return null;
}

/**
 * Decide whether `channel` is permitted for `category` given a user's raw
 * (untrusted, possibly malformed) prefs blob. Defaults to ON for anything
 * missing/unparseable, and never suppresses an unrecognized category.
 */
export function isChannelAllowed(
  prefs: unknown,
  category: NotificationCategory | null,
  channel: NotificationChannel
): boolean {
  if (!category) return true; // unmapped type → always deliver
  if (!prefs || typeof prefs !== 'object') return true; // missing/malformed → ON
  const cat = (prefs as Record<string, unknown>)[category];
  if (!cat || typeof cat !== 'object') return true;
  // Only an explicit boolean false opts out; anything else (true/undefined/junk) = ON.
  return (cat as Record<string, unknown>)[channel] !== false;
}

export interface NotifyArgs {
  /** Notification type tag, e.g. 'task_assigned' (mirrors Activity types). */
  type: string;
  /** In-app notification title. */
  title: string;
  /** In-app notification message. */
  message: string;
  entityType?: string;
  entityId?: string;
  /**
   * Build the email for a given recipient, or return null to skip email for
   * them (the in-app notification is still written). Omit entirely for
   * in-app-only notifications.
   */
  email?: (recipient: { id: string; name: string; email: string }) => EmailContent | null;
}

type Recipient = {
  id: string;
  name: string;
  email: string;
  status: string;
  notificationPrefs: unknown;
  organization?: { isDemo: boolean };
};

type EmailJob = {
  to: { email: string; name: string };
  subject: string;
  html: string;
  text: string;
};

type PlannedNotification = { inAppUserIds: string[]; emails: EmailJob[] };

/**
 * Notify one or more users: write an in-app Notification row for each and,
 * when `args.email` is provided, send each recipient a branded email.
 *
 * Inside a tenant transaction the rows (and an outbox row per email) commit
 * with the mutation. SMTP runs after commit. Outside a transaction this stays
 * fire-and-forget and never rejects the caller.
 */
export function notify(db: PrismaClient, userIds: string[], args: NotifyArgs): void {
  const recipients = [...new Set(userIds)].filter(Boolean);
  if (recipients.length === 0) return;
  if (inSideEffectScope()) {
    trackSideEffect(persistNotify(db, recipients, args));
    return;
  }
  void deliver(db, recipients, args).catch((err) => {
    console.error('[notify] failed', args.type, err);
  });
}

async function loadRecipients(db: PrismaClient, userIds: string[]): Promise<Recipient[]> {
  return db.user.findMany({
    where: { id: { in: userIds } },
    select: {
      id: true,
      name: true,
      email: true,
      status: true,
      notificationPrefs: true,
      organization: { select: { isDemo: true } },
    },
  });
}

function planFrom(userIds: string[], users: Recipient[], args: NotifyArgs): PlannedNotification {
  const category = categoryForType(args.type);
  const byId = new Map(users.map((user) => [user.id, user] as const));
  const inAppUserIds = userIds.filter((id) =>
    isChannelAllowed(byId.get(id)?.notificationPrefs, category, 'inApp')
  );
  const emails: EmailJob[] = [];
  if (args.email) {
    for (const user of users) {
      if (user.status === 'INACTIVE' || user.organization?.isDemo) continue;
      if (!isChannelAllowed(user.notificationPrefs, category, 'email')) continue;
      const content = args.email(user);
      if (!content) continue;
      emails.push({
        to: { email: user.email, name: user.name },
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
    }
  }
  return { inAppUserIds, emails };
}

function notificationRows(userIds: string[], args: NotifyArgs) {
  return userIds.map((userId) => ({
    userId,
    title: args.title,
    message: args.message,
    type: args.type,
    entityType: args.entityType ?? null,
    entityId: args.entityId ?? null,
  }));
}

async function planOrFallback(
  db: PrismaClient,
  userIds: string[],
  args: NotifyArgs
): Promise<PlannedNotification> {
  try {
    return planFrom(userIds, await loadRecipients(db, userIds), args);
  } catch (err) {
    console.error('[notify] prefs lookup failed', args.type, err);
    return { inAppUserIds: userIds, emails: [] };
  }
}

async function persistNotify(db: PrismaClient, userIds: string[], args: NotifyArgs): Promise<void> {
  const planned = await planOrFallback(db, userIds, args);
  if (planned.inAppUserIds.length > 0) {
    await db.notification.createMany({ data: notificationRows(planned.inAppUserIds, args) });
  }
  if (planned.emails.length > 0) {
    await db.outboundEffect.createMany({
      data: planned.emails.map((payload) => ({
        kind: 'email',
        payload: payload as Prisma.InputJsonValue,
        status: 'PENDING',
      })),
    });
  }
}

async function deliver(db: PrismaClient, userIds: string[], args: NotifyArgs): Promise<void> {
  const planned = await planOrFallback(db, userIds, args);
  if (planned.inAppUserIds.length > 0) {
    await db.notification
      .createMany({ data: notificationRows(planned.inAppUserIds, args) })
      .catch((err) => console.error('[notify] notification insert failed', args.type, err));
  }
  await Promise.all(
    planned.emails.map(async (email) => {
      try {
        await sendEmail(email);
      } catch (err) {
        console.error('[notify] email failed for', email.to.email, args.type, err);
      }
    })
  );
}
