import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  configuredFiscalAdapter,
  FiscalInvoiceSchema,
  fiscalRetryAt,
  type FiscalAdapter,
  type FiscalInvoice,
} from './adapter';

type Scope = { organizationId: string; branchId: string };

/** Must run inside the sale-completion transaction, under the session tenant. */
export async function enqueueFbrInvoice(
  db: ScopedDb,
  scope: Scope,
  saleId: string,
  invoice: Omit<FiscalInvoice, 'usin'>
) {
  if (!configuredFiscalAdapter()) return;
  const payload = FiscalInvoiceSchema.parse({
    ...invoice,
    usin: createHash('sha256')
      .update(JSON.stringify([scope.organizationId, scope.branchId, saleId]))
      .digest('hex')
      .slice(0, 50),
  });
  await db.$executeRaw(Prisma.sql`
    INSERT INTO fiscal_invoice_outbox (id, "organizationId", "branchId", "saleId", usin, payload)
    VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${saleId}, ${payload.usin}, ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT ("organizationId", "saleId") DO NOTHING`);
  await db.pharmacySale.updateMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      id: saleId,
      fbrStatus: null,
    },
    data: { fbrStatus: 'PENDING' },
  });
}

/** Caller owns the transaction. SKIP LOCKED prevents concurrent dispatch of a row;
 * crashes roll back the claim. Future network adapters MUST honor USIN idempotency.
 * Retry indefinitely with capped backoff; never discard an invoice after N attempts.
 */
export async function dispatchFbrInvoices(
  db: ScopedDb,
  scope: Scope,
  adapter: FiscalAdapter,
  now = new Date(),
  saleId?: string
) {
  const rows = await db.$queryRaw<
    Array<{ id: string; saleId: string; payload: unknown; attempts: number }>
  >(Prisma.sql`
    SELECT id, "saleId", payload, attempts FROM fiscal_invoice_outbox
    WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId}
      AND status='PENDING' AND "nextAttemptAt" <= ${now}
      ${saleId ? Prisma.sql`AND "saleId"=${saleId}` : Prisma.empty}
    ORDER BY "nextAttemptAt", id LIMIT 20 FOR UPDATE SKIP LOCKED`);
  let submitted = 0;
  for (const row of rows) {
    let result;
    try {
      result = await adapter.submit(FiscalInvoiceSchema.parse(row.payload));
      if (result.mode !== 'MOCK' || !/^MOCK-FBR-[a-f0-9]{24}$/.test(result.invoiceNumber))
        throw new Error('Invalid fiscal response');
    } catch {
      // Never persist adapter exception text: it may contain credentials/buyer data.
      await db.$executeRaw(Prisma.sql`UPDATE fiscal_invoice_outbox
        SET attempts=attempts+1, "nextAttemptAt"=${fiscalRetryAt(row.attempts + 1, now)}, "lastError"='SUBMISSION_FAILED'
        WHERE id=${row.id} AND "organizationId"=${scope.organizationId}`);
      continue;
    }
    await db.pharmacySale.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: row.saleId } },
      data: { fbrStatus: 'SUBMITTED', fbrInvoiceNumber: result.invoiceNumber },
    });
    await db.$executeRaw(Prisma.sql`UPDATE fiscal_invoice_outbox SET status='SUBMITTED',
      attempts=attempts+1, "submittedAt"=${now}, "lastError"=NULL
      WHERE id=${row.id} AND "organizationId"=${scope.organizationId}`);
    submitted++;
  }
  return { processed: rows.length, submitted };
}
