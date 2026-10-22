import { Prisma } from '@/generated/prisma/client';

type InvoiceNumberDb = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
};

/** Atomically reserve the next annual invoice number for one organization. */
export async function allocateInvoiceNumber(
  db: InvoiceNumberDb,
  organizationId: string,
  year = new Date().getFullYear()
): Promise<string> {
  const rows = await db.$queryRaw<Array<{ nextNumber: number }>>(Prisma.sql`
    INSERT INTO "invoice_number_sequences" ("organizationId", "year", "nextNumber", "updatedAt")
    VALUES (
      ${organizationId},
      ${year},
      COALESCE((
        SELECT MAX(substring("invoiceNumber" FROM '^INV-[0-9]{4}-([0-9]+)$')::INTEGER) + 1
        FROM "invoices"
        WHERE "organizationId" = ${organizationId}
          AND "invoiceNumber" ~ ${`^INV-${year}-[0-9]+$`}
      ), 1),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("organizationId", "year") DO UPDATE
      SET "nextNumber" = GREATEST(
            "invoice_number_sequences"."nextNumber" + 1,
            COALESCE((
              SELECT MAX(substring("invoiceNumber" FROM '^INV-[0-9]{4}-([0-9]+)$')::INTEGER) + 1
              FROM "invoices"
              WHERE "organizationId" = ${organizationId}
                AND "invoiceNumber" ~ ${`^INV-${year}-[0-9]+$`}
            ), 1)
          ),
          "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "nextNumber"
  `);
  const nextNumber = rows[0]?.nextNumber;
  if (!Number.isSafeInteger(nextNumber) || nextNumber < 1) {
    throw new Error('Failed to allocate an invoice number.');
  }
  return `INV-${year}-${String(nextNumber).padStart(3, '0')}`;
}
