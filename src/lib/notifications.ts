import type { PrismaClient } from '@/generated/prisma/client';
import { sendEmail } from '@/lib/email';
import type { EmailContent } from '@/lib/email';

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
  // 1) In-app notification rows (best-effort).
  await db.notification
    .createMany({
      data: userIds.map((userId) => ({
        userId,
        title: args.title,
        message: args.message,
        type: args.type,
        entityType: args.entityType ?? null,
        entityId: args.entityId ?? null,
      })),
    })
    .catch((err) => console.error('[notify] notification insert failed', args.type, err));

  // 2) Emails (best-effort, per recipient). Skip deactivated accounts.
  if (!args.email) return;
  const users = await db.user.findMany({
    where: { id: { in: userIds }, status: { not: 'INACTIVE' } },
    select: { id: true, name: true, email: true },
  });

  await Promise.all(
    users.map(async (u) => {
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
