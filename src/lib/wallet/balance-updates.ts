import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  AppleApnsError,
  sendApplePassPush,
  type AppleApnsCredentials,
  type AppleApnsTransport,
} from './apple-apns';
import type { GoogleWalletClient } from './google';

export const WALLET_UPDATE_MAX_ATTEMPTS = 8;
export const WALLET_UPDATE_BATCH_SIZE = 50;

export type WalletDelivery = {
  apple(input: {
    passId: string;
    serialNumber: string;
    balance: number;
    revoked?: boolean;
  }): Promise<void>;
  google(input: {
    passId: string;
    serialNumber: string;
    balance: number;
    revoked?: boolean;
  }): Promise<void>;
};

/** Bind orchestration to the accepted provider clients. Missing live credentials
 * fail explicitly; an accepted push response is not treated as device delivery. */
export function createWalletProviderDelivery(input: {
  db: ScopedDb;
  appleCredentials?: AppleApnsCredentials;
  appleTransport?: AppleApnsTransport;
  googleClient?: GoogleWalletClient;
}): WalletDelivery {
  return {
    async apple({ passId }) {
      if (!input.appleCredentials)
        throw new Error('Apple APNs wallet update credentials are not configured.');
      const registrations = await input.db.walletPassRegistration.findMany({
        where: { passId },
        select: { id: true, pushToken: true },
      });
      for (const registration of registrations) {
        try {
          await sendApplePassPush({
            credentials: input.appleCredentials,
            pushToken: registration.pushToken,
            transport: input.appleTransport,
          });
        } catch (error) {
          if (error instanceof AppleApnsError && error.invalidPushToken) {
            await input.db.walletPassRegistration.delete({ where: { id: registration.id } });
            continue;
          }
          throw error;
        }
      }
    },
    async google({ serialNumber, balance, revoked }) {
      if (!input.googleClient)
        throw new Error('Google Wallet issuer credentials are not configured.');
      if (revoked) return input.googleClient.expireLoyaltyObject({ serialNumber });
      await input.googleClient.patchLoyaltyObjectBalance({ serialNumber, balance });
    },
  };
}

type ClaimedUpdate = {
  id: string;
  passId: string;
  platform: 'APPLE' | 'GOOGLE';
  serialNumber: string;
  attempts: number;
  balance: number;
  revoked: boolean;
};

export type WalletUpdateSummary = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
};

function retryAt(now: Date, attempts: number) {
  const seconds = Math.min(3600, 2 ** Math.max(0, attempts - 1) * 30);
  return new Date(now.getTime() + seconds * 1000);
}

// The tenant worker reads the authoritative ledger named by each carrier.
const walletBalance = Prisma.sql`CASE WHEN p."pharmacyCardId" IS NULL THEN
  (SELECT COALESCE(sum(e.points),0)::int FROM restaurant_loyalty_points_entries e
   WHERE e."organizationId"=p."organizationId" AND e."accountId"=p."loyaltyAccountId")
  ELSE (SELECT COALESCE(sum(e.points),0)::int FROM pharmacy_loyalty_cards c
    JOIN pharmacy_loyalty_points_entries e ON e."organizationId"=c."organizationId" AND e."customerId"=c."customerId"
    WHERE c."organizationId"=p."organizationId" AND c.id=p."pharmacyCardId") END`;

/** Claim once under row locks. The status transition commits before provider I/O. */
export async function claimWalletUpdates(
  db: ScopedDb,
  now = new Date(),
  limit = WALLET_UPDATE_BATCH_SIZE
): Promise<ClaimedUpdate[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > WALLET_UPDATE_BATCH_SIZE)
    throw new Error(`Wallet update batch size must be between 1 and ${WALLET_UPDATE_BATCH_SIZE}.`);
  return db.$queryRaw<ClaimedUpdate[]>(Prisma.sql`
    WITH claimed AS (
      SELECT u."id"
      FROM "restaurant_wallet_pass_updates" u
      WHERE u."status" = 'PENDING' AND u."nextAttemptAt" <= ${now}
      ORDER BY u."nextAttemptAt", u."id"
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    ), marked AS (
      UPDATE "restaurant_wallet_pass_updates" u
      SET "status" = 'FAILED', "attempts" = u."attempts" + 1, "updatedAt" = ${now}
      FROM claimed WHERE u."id" = claimed."id"
      RETURNING u."id", u."passId", u."attempts"
    )
    SELECT marked."id", marked."passId", marked."attempts", p."platform", p."serialNumber",
           (p.status = 'REVOKED') AS revoked, ${walletBalance} AS balance
    FROM marked
    JOIN "restaurant_wallet_passes" p ON p."id" = marked."passId" AND p."organizationId" = current_setting('app.current_organization_id', true)
  `);
}

export async function deliverWalletUpdates(
  db: ScopedDb,
  delivery: WalletDelivery,
  options: { now?: Date; limit?: number } = {}
): Promise<WalletUpdateSummary> {
  const now = options.now ?? new Date();
  const rows = await claimWalletUpdates(db, now, options.limit);
  const summary: WalletUpdateSummary = { claimed: rows.length, sent: 0, retried: 0, failed: 0 };
  for (const row of rows) {
    try {
      await delivery[row.platform === 'APPLE' ? 'apple' : 'google']({
        passId: row.passId,
        serialNumber: row.serialNumber,
        balance: row.balance,
        ...(row.revoked ? { revoked: true } : {}),
      });
      await db.$transaction([
        db.walletPassUpdate.update({
          where: { id: row.id },
          data: { status: 'SENT', lastError: null },
        }),
        db.walletPass.update({
          where: { id: row.passId },
          data: { lastPushedBalance: row.balance, lastPushedAt: now },
        }),
      ]);
      summary.sent += 1;
    } catch {
      const terminal = row.attempts >= WALLET_UPDATE_MAX_ATTEMPTS;
      await db.walletPassUpdate.update({
        where: { id: row.id },
        data: {
          status: terminal ? 'FAILED' : 'PENDING',
          nextAttemptAt: retryAt(now, row.attempts),
          lastError: 'Provider update failed.',
        },
      });
      summary[terminal ? 'failed' : 'retried'] += 1;
    }
  }
  return summary;
}

/** Repair projection drift and failed deliveries without ever mutating the ledger. */
export async function reconcileWalletUpdates(db: ScopedDb, now = new Date()): Promise<number> {
  const repaired = await db.$executeRaw(Prisma.sql`
    INSERT INTO "restaurant_wallet_pass_updates"
      ("id", "organizationId", "passId", "reason", "status", "attempts", "nextAttemptAt", "createdAt", "updatedAt")
    SELECT concat('wpu_', replace(gen_random_uuid()::text, '-', '')), p."organizationId", p."id",
           'RECONCILE', 'PENDING', 0, ${now}, ${now}, ${now}
    FROM "restaurant_wallet_passes" p
    WHERE p."status" = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1
        FROM "restaurant_wallet_pass_updates" terminal
        WHERE terminal."passId" = p."id"
          AND terminal."status" = 'FAILED'
          AND terminal."attempts" >= ${WALLET_UPDATE_MAX_ATTEMPTS}
      )
      AND p."lastPushedBalance" IS DISTINCT FROM ${walletBalance}
    ON CONFLICT ("passId") WHERE "status" = 'PENDING'
    DO NOTHING
  `);
  return repaired;
}
