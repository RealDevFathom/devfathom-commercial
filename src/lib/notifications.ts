import type { PrismaClient } from '@/generated/prisma/client';
import { sendEmail } from '@/lib/email';
import type { EmailContent } from '@/lib/email';

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

/**
 * Notify one or more users: write an in-app Notification row for each and,
 * when `args.email` is provided, send each recipient a branded email.
 *
 * Fire-and-forget — mirrors logActivity(). It never blocks or rejects the
 * surrounding mutation: the user's action already succeeded, so a failed
 * notification or email must not surface an error to the client.
 */
export function notify(db: PrismaClient, userIds: string[], args: NotifyArgs): void {
  const recipients = [...new Set(userIds)].filter(Boolean);
  if (recipients.length === 0) return;
  void deliver(db, recipients, args).catch((err) => {
    console.error('[notify] failed', args.type, err);
  });
}

async function deliver(db: PrismaClient, userIds: string[], args: NotifyArgs): Promise<void> {
  const category = categoryForType(args.type);

  // IMP-AUTH-04: load each recipient's prefs once (also reused for the email
  // step's name/email/status). If the lookup itself fails, fall back to the
  // legacy behaviour — deliver everything — so prefs never silence a real event.
  let users: Array<{
    id: string;
    name: string;
    email: string;
    status: string;
    notificationPrefs: unknown;
  }> = [];
  try {
    users = await db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true, status: true, notificationPrefs: true },
    });
  } catch (err) {
    console.error('[notify] prefs lookup failed', args.type, err);
  }
  const byId = new Map(users.map((u) => [u.id, u] as const));

  // 1) In-app notification rows (best-effort). Drop recipients who opted OUT of
  // the in-app channel for this category. Unknown ids (lookup miss/failure)
  // default to ON so existing behaviour is preserved.
  const inAppUserIds = userIds.filter((id) =>
    isChannelAllowed(byId.get(id)?.notificationPrefs, category, 'inApp')
  );
  if (inAppUserIds.length > 0) {
    await db.notification
      .createMany({
        data: inAppUserIds.map((userId) => ({
          userId,
          title: args.title,
          message: args.message,
          type: args.type,
          entityType: args.entityType ?? null,
          entityId: args.entityId ?? null,
        })),
      })
      .catch((err) => console.error('[notify] notification insert failed', args.type, err));
  }

  // 2) Emails (best-effort, per recipient). Skip deactivated accounts and
  // anyone who opted OUT of the email channel for this category.
  if (!args.email) return;
  await Promise.all(
    users.map(async (u) => {
      if (u.status === 'INACTIVE') return;
      if (!isChannelAllowed(u.notificationPrefs, category, 'email')) return;
      const content = args.email?.(u);
      if (!content) return;
      try {
        await sendEmail({
          to: { email: u.email, name: u.name },
          subject: content.subject,
          html: content.html,
          text: content.text,
        });
      } catch (err) {
        console.error('[notify] email failed for', u.email, args.type, err);
      }
    })
  );
}
