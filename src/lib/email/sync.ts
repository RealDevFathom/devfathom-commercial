import type { PrismaClient } from '@/generated/prisma/client';
import { Prisma } from '@/generated/prisma/client';
import { adapterForMailbox, type ProviderType } from './adapter';

export interface SyncableMailbox {
  id: string;
  type: ProviderType;
  credentials: string;
  emailAddress: string;
}

/**
 * Pull the most-recent inbox page for a mailbox and upsert it into the unified
 * store. Deliberately fast (one page, ~25–50) so the inbox can render on first
 * paint; deeper backfill can run later. Read-state and bodies already stored are
 * preserved — only metadata/snippet/flags are refreshed.
 */
export async function syncMailbox(
  db: PrismaClient,
  mailbox: SyncableMailbox,
  opts: { limit?: number } = {}
): Promise<number> {
  const adapter = adapterForMailbox(mailbox);
  const { messages } = await adapter.sync({ limit: opts.limit ?? 30 });

  for (const m of messages) {
    await db.emailMessage.upsert({
      where: {
        mailboxId_providerMessageId: {
          mailboxId: mailbox.id,
          providerMessageId: m.providerMessageId,
        },
      },
      create: {
        mailboxId: mailbox.id,
        providerMessageId: m.providerMessageId,
        threadId: m.threadId,
        fromAddr: m.fromAddr,
        toAddrs: m.toAddrs as unknown as Prisma.InputJsonValue,
        ccAddrs: m.ccAddrs as unknown as Prisma.InputJsonValue,
        subject: m.subject,
        snippet: m.snippet,
        isRead: m.isRead,
        hasAttachments: m.hasAttachments,
        sentAt: m.sentAt,
      },
      update: {
        snippet: m.snippet,
        isRead: m.isRead,
        hasAttachments: m.hasAttachments,
      },
    });
  }

  await db.mailbox.update({ where: { id: mailbox.id }, data: { lastSyncedAt: new Date() } });
  return messages.length;
}
