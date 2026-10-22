import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * #518 owner policy (feat/pharmacy-owner-policy). `allowCashierRxSale` lets staff without the
 * exact pharmacy:dispense grant sell Rx/restricted non-controlled lines. It defaults to OFF.
 *
 * The ONE accessor: true only when this organization's row exists and says true. A missing row,
 * a missing table or any read failure is OFF (fail closed).
 */
export async function readAllowCashierRxSale(
  db: ScopedDb,
  organizationId: string
): Promise<boolean> {
  try {
    const rows = await db.$queryRaw<Array<{ allowCashierRxSale: unknown }>>(
      Prisma.sql`SELECT "allowCashierRxSale" FROM pharmacy_owner_policies WHERE "organizationId" = ${organizationId}`
    );
    return rows.length === 1 && rows[0]!.allowCashierRxSale === true;
  } catch {
    return false;
  }
}

/** Owner write. The table's trigger appends an audit row whenever the value changes. */
export async function setAllowCashierRxSale(
  db: ScopedDb,
  organizationId: string,
  actorUserId: string,
  allow: boolean
): Promise<void> {
  await db.$executeRaw(
    Prisma.sql`INSERT INTO pharmacy_owner_policies ("organizationId", "allowCashierRxSale", "updatedByUserId", "updatedAt")
      VALUES (${organizationId}, ${allow}, ${actorUserId}, now())
      ON CONFLICT ("organizationId") DO UPDATE
        SET "allowCashierRxSale" = EXCLUDED."allowCashierRxSale",
            "updatedByUserId" = EXCLUDED."updatedByUserId",
            "updatedAt" = EXCLUDED."updatedAt"`
  );
}
