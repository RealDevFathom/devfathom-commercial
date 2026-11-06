import { Prisma, type PrismaClient } from '@/generated/prisma/client';

type InvoiceNumberingTx = Pick<Prisma.TransactionClient, '$queryRaw'>;

export function formatInvoiceNumber(year: number, sequence: number): string {
  return `INV-${year}-${String(sequence).padStart(3, '0')}`;
}

/**
 * Allocate the next `INV-<year>-<sequence>` for the organization bound to `tx`.
 *
 * Invoice numbers are unique per organization (`@@unique([organizationId,
 * invoiceNumber])`), and the sequence restarts at -001 each year (FIN-09).
 *
 * The caller must insert the invoice in the SAME transaction: the advisory lock
 * taken here is held until that transaction ends, so a concurrent create in the
 * same organization waits for this one to commit (or roll back) before it reads
 * the sequence. Other organizations take a different lock and never wait.
 *
 * The tenant comes from `app.current_organization_id` — the setting the RLS
 * policy and the `organizationId` column default read — so the lock, the
 * sequence read and the inserted row always belong to the same organization.
 */
export async function allocateInvoiceNumber(
  tx: InvoiceNumberingTx,
  now: Date = new Date()
): Promise<string> {
  const [scope] = await tx.$queryRaw<{ organizationId: string | null }[]>(
    Prisma.sql`SELECT NULLIF(current_setting('app.current_organization_id', true), '') AS "organizationId"`
  );
  const organizationId = scope?.organizationId;
  if (!organizationId) {
    throw new Error('Invoice numbers can only be allocated inside a tenant transaction.');
  }

  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`invoice-number:${organizationId}`}, 0))`
  );

  // Keep this a separate statement from the lock: under READ COMMITTED each
  // statement takes a fresh snapshot, so it sees the invoice that the previous
  // lock holder committed while this transaction waited. MAX (not COUNT) keeps
  // the sequence ahead of every existing number even after a deletion.
  const year = now.getFullYear();
  const [latest] = await tx.$queryRaw<{ sequence: bigint | number | null }[]>(Prisma.sql`
    SELECT MAX(substring("invoiceNumber" FROM ${`^INV-${year}-([0-9]+)$`}::text)::bigint) AS "sequence"
      FROM "invoices"
     WHERE "organizationId" = ${organizationId}
       AND "invoiceNumber" LIKE ${`INV-${year}-%`}
  `);
  return formatInvoiceNumber(year, Number(latest?.sequence ?? 0) + 1);
}

/**
 * Create an invoice under the next number for the current organization. Every
 * invoice creator goes through here so numbering and insert share one
 * transaction (a request-level transaction is reused when one is open).
 */
export function createWithNextInvoiceNumber<T>(
  db: Pick<PrismaClient, '$transaction'>,
  create: (tx: Prisma.TransactionClient, invoiceNumber: string) => Promise<T>
): Promise<T> {
  return db.$transaction(async (tx) => create(tx, await allocateInvoiceNumber(tx)));
}
