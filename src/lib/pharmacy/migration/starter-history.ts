import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export async function starterHistory(
  db: ScopedDb,
  organizationId: string,
  list: 'conflicts' | 'narcotics',
  page: number
) {
  const run = await db.pharmacyStarterImport.findUnique({ where: { organizationId } });
  const select =
    list === 'conflicts'
      ? Prisma.sql`
    SELECT m."productName",i."sourceId",c.field,c."existingValue",c."starterValue"
    FROM pharmacy_starter_conflicts c
    JOIN pharmacy_starter_identities i USING ("organizationId","sourceId")
    JOIN pharmacy_medicines m ON m.id=i."medicineId" AND m."organizationId"=i."organizationId"
    WHERE i."organizationId"=${organizationId} ORDER BY i."sourceId",c.field`
      : Prisma.sql`
    SELECT m."productName",i."sourceId",'NARCOTICS' AS field, NULL::text AS "existingValue",NULL::text AS "starterValue"
    FROM pharmacy_starter_identities i
    JOIN pharmacy_medicines m ON m.id=i."medicineId" AND m."organizationId"=i."organizationId"
    WHERE i."organizationId"=${organizationId} AND i."narcoticsReview" ORDER BY i."sourceId"`;
  const rows = await db.$queryRaw<
    {
      productName: string;
      sourceId: string;
      field: string;
      existingValue: string | null;
      starterValue: string | null;
    }[]
  >`${select} LIMIT 26 OFFSET ${(page - 1) * 25}`;
  return { run, rows: rows.slice(0, 25), more: rows.length > 25 };
}
