import 'server-only';

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { sendEmail } from '@/lib/email';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

export type AIBudgetEvent = 'EIGHTY_PERCENT' | 'BEDROCK_SWITCH';

export type AIBudgetNotice = {
  event: AIBudgetEvent;
  organizationId?: string | null;
  monthStart: Date;
  monthEnd: Date;
  spendUsd: number;
  budgetUsd: number;
};

const copy = {
  EIGHTY_PERCENT: {
    title: 'DevFathom AI budget at 80%',
    message: (spend: number, budget: number) =>
      `Anthropic month-to-date spend is $${spend.toFixed(2)} of the $${budget.toFixed(2)} budget.`,
  },
  BEDROCK_SWITCH: {
    title: 'DevFathom AI switched to Bedrock',
    message: (spend: number, budget: number) =>
      `Anthropic month-to-date spend reached $${spend.toFixed(2)} of the $${budget.toFixed(2)} budget. DevFathom AI is now routing through Bedrock.`,
  },
} as const;

/**
 * Claims a monthly event before delivering it. The database unique key makes
 * concurrent router calls idempotent; a failed email never duplicates the
 * durable in-app notices on retry.
 */
export async function sendAIBudgetNotice(notice: AIBudgetNotice): Promise<boolean> {
  const content = copy[notice.event];
  const message = content.message(notice.spendUsd, notice.budgetUsd);

  const recipients = await withPlatformDb(async (db) => {
    const claimed = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "ai_budget_alerts" ("id", "event", "monthStart", "organizationId", "spendUsd", "budgetUsd")
      VALUES (${randomUUID()}, ${notice.event}, ${notice.monthStart}, ${notice.organizationId ?? null}, ${notice.spendUsd}, ${notice.budgetUsd})
      ON CONFLICT ("event", "monthStart") DO NOTHING
      RETURNING "id"`);
    if (!claimed[0]) return null;

    const platformUsers = await db.$queryRaw<Array<{ id: string; name: string; email: string }>>(Prisma.sql`
      SELECT "id", "name", "email" FROM "platform_users"
      WHERE "role" = 'SUPER_ADMIN' AND "active" = true`);

    const owners = notice.organizationId
      ? await db.$queryRaw<Array<{ id: string; name: string; email: string }>>(Prisma.sql`
          SELECT u."id", u."name", u."email" FROM "users" u
          INNER JOIN "organization_roles" r
            ON r."organizationId" = u."organizationId" AND r."id" = u."organizationRoleId"
          WHERE u."organizationId" = ${notice.organizationId}
            AND r."organizationId" = ${notice.organizationId}
            AND r."key" = 'owner' AND u."status" <> 'INACTIVE'`)
      : [];

    if (platformUsers.length) {
      await db.$executeRaw(Prisma.sql`
        INSERT INTO "platform_notifications" ("id", "platformUserId", "title", "message", "type", "entityId")
        SELECT gen_random_uuid()::text, p."id", ${content.title}, ${message}, 'ai_budget', ${claimed[0].id}
        FROM "platform_users" p
        WHERE p."role" = 'SUPER_ADMIN' AND p."active" = true`);
    }
    if (owners.length && notice.organizationId) {
      await db.$executeRaw(Prisma.sql`
        INSERT INTO "notifications" ("id", "organizationId", "userId", "title", "message", "type", "entityType", "entityId")
        SELECT gen_random_uuid()::text, u."organizationId", u."id", ${content.title}, ${message}, 'ai_budget', 'AIBudgetAlert', ${claimed[0].id}
        FROM "users" u
        INNER JOIN "organization_roles" r
          ON r."organizationId" = u."organizationId" AND r."id" = u."organizationRoleId"
        WHERE u."organizationId" = ${notice.organizationId}
          AND r."organizationId" = ${notice.organizationId}
          AND r."key" = 'owner' AND u."status" <> 'INACTIVE'`);
    }
    return [...platformUsers, ...owners];
  });

  if (!recipients) return false;
  await Promise.allSettled(
    recipients.map((recipient) =>
      sendEmail({
        to: { name: recipient.name, email: recipient.email },
        subject: content.title,
        text: message,
        html: `<p>${message}</p>`,
      })
    )
  );
  return true;
}
