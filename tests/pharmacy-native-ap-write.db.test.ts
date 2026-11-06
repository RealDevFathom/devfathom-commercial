// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { postBookkeepingTransaction } from '@/lib/pharmacy/bookkeeping';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  createSupplierExpenseInvoice,
  reverseSupplierExpenseSettlement,
  settleSupplierExpenseInvoice,
  supplierExpenseAging,
  voidSupplierExpenseInvoice,
} from '@/lib/pharmacy/native-ap';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;
const db = url ? new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }) : null;

suite('native AP writes through the generated Prisma client and PostgreSQL', () => {
  beforeAll(() => {
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url!).hostname))
      throw new Error('Refusing to run the native AP write probe against a non-local database.');
  });
  afterAll(async () => { await db?.$disconnect(); });

  it('creates nested evidence, preserves old balances, and audits each money mutation exactly once', async () => {
    const rollback = new Error('rollback native AP fixtures');
    await expect(db!.$transaction(async transaction => {
      const tx = transaction as ScopedDb;
      const organizationId = `ap_${randomUUID()}`;
      await tx.$queryRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.organization.create({ data: {
        id: organizationId, slug: organizationId, legalName: 'AP probe', displayName: 'AP probe',
      } });
      await tx.organizationDepartment.create({ data: { organizationId, key: 'finance', name: 'Finance' } });
      const actor = await tx.user.create({ data: {
        organizationId, name: 'AP administrator', email: `${organizationId}@example.invalid`,
        role: 'ADMIN', department: 'finance', title: 'Administrator',
      } });
      const branch = await tx.pharmacyBranch.create({ data: {
        organizationId, code: 'MAIN', name: 'Main', addressLine: 'Test', city: 'Test', provinceCode: 'PB',
      } });
      const supplier = await tx.pharmacySupplier.create({ data: { organizationId, name: 'Utilities', authorized: true } });
      await tx.$queryRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true),
        set_config('app.current_user_id', ${actor.id}, true), set_config('app.is_platform_admin', 'false', true)`;
      const scope = { organizationId, branchId: branch.id, actorId: actor.id };
      // Each probe rolls back both its attempted mutation and any fixture rows.
      // Forcing deferred constraints exercises the same boundary as COMMIT.
      const rejectedWrite = async (operation: () => Promise<unknown>, message: RegExp) => {
        await tx.$executeRawUnsafe('SAVEPOINT native_ap_guard_probe');
        try {
          await expect((async () => {
            await operation();
            await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
          })()).rejects.toThrow(message);
        } finally {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT native_ap_guard_probe');
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT native_ap_guard_probe');
        }
      };
      const input = {
        supplierId: supplier.id, supplierInvoiceRef: 'OLD-UTILITIES', description: 'Utilities',
        issuedAt: new Date('2024-01-01Z'), dueAt: new Date('2024-02-01Z'), amountMinor: 10_000,
        idempotencyKey: 'create', lines: [{ description: 'Utilities', amountMinor: 10_000 }],
      };
      const invoice = await createSupplierExpenseInvoice(tx, scope, input);
      expect(invoice.lines).toEqual([expect.objectContaining({ organizationId, invoiceId: invoice.id, amountMinor: 10_000 })]);
      expect((await createSupplierExpenseInvoice(tx, scope, input)).id).toBe(invoice.id);
      await expect(createSupplierExpenseInvoice(tx, scope, { ...input, idempotencyKey: 'duplicate' })).rejects.toMatchObject({ reason: 'INVALID_STATE' });
      expect(await tx.financeJournalEntry.count({ where: { organizationId } })).toBe(1);
      await rejectedWrite(() => tx.$executeRaw`UPDATE pharmacy_supplier_expense_invoices SET "amountMinor" = 1 WHERE id = ${invoice.id}`, /PHARMACY_NATIVE_AP_IMMUTABLE/);
      await rejectedWrite(() => tx.$executeRaw`DELETE FROM pharmacy_supplier_expense_invoices WHERE id = ${invoice.id}`, /PHARMACY_NATIVE_AP_IMMUTABLE/);
      await rejectedWrite(() => tx.$executeRaw`UPDATE pharmacy_supplier_expense_invoice_lines SET description = 'rewritten' WHERE "invoiceId" = ${invoice.id}`, /PHARMACY_NATIVE_AP_IMMUTABLE/);
      await rejectedWrite(() => tx.$executeRaw`DELETE FROM pharmacy_supplier_expense_invoice_lines WHERE "invoiceId" = ${invoice.id}`, /PHARMACY_NATIVE_AP_IMMUTABLE/);
      await rejectedWrite(() => tx.$executeRaw`UPDATE pharmacy_supplier_expense_invoice_events SET detail = 'rewritten' WHERE "invoiceId" = ${invoice.id}`, /PHARMACY_NATIVE_AP_IMMUTABLE/);
      await rejectedWrite(() => tx.$executeRaw`DELETE FROM pharmacy_supplier_expense_invoice_events WHERE "invoiceId" = ${invoice.id}`, /PHARMACY_NATIVE_AP_IMMUTABLE/);
      await rejectedWrite(() => tx.pharmacySupplierExpenseInvoiceLine.create({ data: {
        organizationId, invoiceId: invoice.id, description: 'Extra line', amountMinor: 1,
      } }), /PHARMACY_NATIVE_AP_LINE_TOTAL/);
      await rejectedWrite(async () => {
        await tx.pharmacyAccountingPeriod.create({ data: {
          organizationId, branchId: branch.id, startsAt: new Date('2024-01-01Z'), endsAt: new Date('2024-02-01Z'),
          status: 'CLOSED', closedAt: new Date(), closedByUserId: actor.id,
        } });
        // Direct DB write bypasses the application's period check.
        await tx.$executeRaw`INSERT INTO pharmacy_supplier_expense_invoices
          (id, "organizationId", "branchId", "supplierId", "supplierInvoiceRef", description, "issuedAt", "dueAt", "amountMinor", "idempotencyKey", "journalEntryId", "createdByUserId")
          VALUES (${randomUUID()}, ${organizationId}, ${branch.id}, ${supplier.id}, 'CLOSED', 'Closed period', ${input.issuedAt}, ${input.dueAt}, 1, 'closed', ${invoice.journalEntryId}, ${actor.id})`;
      }, /PHARMACY_ACCOUNTING_PERIOD_CLOSED/);
      expect((await supplierExpenseAging(tx, scope, {})).rows).toEqual([expect.objectContaining({ id: invoice.id, outstandingMinor: 10_000 })]);
      const paymentInput = {
        invoiceId: invoice.id, amountMinor: 7_000, occurredAt: new Date('2024-03-01Z'),
        reference: 'PAY-1', idempotencyKey: 'pay',
      };
      const settlement = await settleSupplierExpenseInvoice(tx, scope, paymentInput);
      expect(settlement.createdByUserId).toBe(actor.id);
      expect((await settleSupplierExpenseInvoice(tx, scope, paymentInput)).id).toBe(settlement.id);
      await rejectedWrite(() => tx.$executeRaw`UPDATE pharmacy_supplier_expense_settlements SET "amountMinor" = 1 WHERE id = ${settlement.id}`, /PHARMACY_NATIVE_AP_IMMUTABLE/);
      await rejectedWrite(() => tx.$executeRaw`DELETE FROM pharmacy_supplier_expense_settlements WHERE id = ${settlement.id}`, /PHARMACY_NATIVE_AP_IMMUTABLE/);
      await rejectedWrite(() => tx.$executeRaw`UPDATE pharmacy_supplier_expense_settlements SET status = 'REVERSED' WHERE id = ${settlement.id}`, /PHARMACY_NATIVE_AP_REVERSAL_EVIDENCE/);
      const directPayment = async (fundingAccount: string, occurredAt = paymentInput.occurredAt) => {
        const transaction = await postBookkeepingTransaction(tx, scope, {
          kind: 'SUPPLIER_PAYMENT', reference: 'DIRECT', idempotencyKey: 'direct', amountMinor: 4_000,
          occurredAt, fundingAccount: 'BANK',
        });
        return tx.$executeRaw`INSERT INTO pharmacy_supplier_expense_settlements
          (id, "organizationId", "invoiceId", "bookkeepingTransactionId", "amountMinor", "occurredAt", "fundingAccount", reference, "idempotencyKey", "createdByUserId")
          VALUES (${randomUUID()}, ${organizationId}, ${invoice.id}, ${transaction.id}, 4000, ${occurredAt}, ${fundingAccount}, 'DIRECT', 'direct', ${actor.id})`;
      };
      await rejectedWrite(() => directPayment('CARD'), /pharmacy_native_ap_funding_account/);
      await rejectedWrite(() => directPayment('BANK'), /PHARMACY_NATIVE_AP_OVERPAYMENT/);
      await rejectedWrite(async () => {
        await tx.pharmacyAccountingPeriod.create({ data: {
          organizationId, branchId: branch.id, startsAt: new Date('2024-04-01Z'), endsAt: new Date('2024-05-01Z'),
          status: 'CLOSED', closedAt: new Date(), closedByUserId: actor.id,
        } });
        // Use the existing canonical payment so only the native guard can refuse it.
        await tx.$executeRaw`INSERT INTO pharmacy_supplier_expense_settlements
          (id, "organizationId", "invoiceId", "bookkeepingTransactionId", "amountMinor", "occurredAt", "fundingAccount", reference, "idempotencyKey", "createdByUserId")
          VALUES (${randomUUID()}, ${organizationId}, ${invoice.id}, ${settlement.bookkeepingTransactionId}, 1, ${new Date('2024-04-02Z')}, 'BANK', 'CLOSED', 'closed-pay', ${actor.id})`;
      }, /PHARMACY_ACCOUNTING_PERIOD_CLOSED/);
      await rejectedWrite(async () => {
        await tx.pharmacyAccountingPeriod.create({ data: {
          organizationId, branchId: branch.id, startsAt: new Date('2024-04-01Z'), endsAt: new Date('2024-05-01Z'),
          status: 'CLOSED', closedAt: new Date(), closedByUserId: actor.id,
        } });
        await tx.$executeRaw`INSERT INTO pharmacy_supplier_expense_settlement_reversals
          (id, "organizationId", "settlementId", "idempotencyKey", reason, "reversedAt", "createdByUserId")
          VALUES (${randomUUID()}, ${organizationId}, ${settlement.id}, 'closed-reverse', 'Mistake', ${new Date('2024-04-02Z')}, ${actor.id})`;
      }, /PHARMACY_ACCOUNTING_PERIOD_CLOSED/);
      await rejectedWrite(async () => {
        await tx.pharmacyAccountingPeriod.create({ data: {
          organizationId, branchId: branch.id, startsAt: new Date('2024-04-01Z'), endsAt: new Date('2024-05-01Z'),
          status: 'CLOSED', closedAt: new Date(), closedByUserId: actor.id,
        } });
        await tx.$executeRaw`INSERT INTO pharmacy_supplier_expense_invoice_events
          (id, "organizationId", "invoiceId", kind, "actorId", "occurredAt")
          VALUES (${randomUUID()}, ${organizationId}, ${invoice.id}, 'VOID', ${actor.id}, ${new Date('2024-04-02Z')})`;
      }, /PHARMACY_ACCOUNTING_PERIOD_CLOSED/);
      await expect(voidSupplierExpenseInvoice(tx, scope, { invoiceId: invoice.id, reason: 'Mistake', at: new Date('2024-03-02Z'), idempotencyKey: 'void' })).rejects.toMatchObject({ reason: 'INVALID_STATE' });
      const reversalInput = { settlementId: settlement.id, reason: 'Mistake', at: new Date('2024-03-02Z'), idempotencyKey: 'reverse' };
      const reversal = await reverseSupplierExpenseSettlement(tx, scope, reversalInput);
      expect((await reverseSupplierExpenseSettlement(tx, scope, reversalInput)).id).toBe(reversal.id);
      await rejectedWrite(() => tx.$executeRaw`UPDATE pharmacy_supplier_expense_settlement_reversals SET reason = 'rewritten' WHERE id = ${reversal.id}`, /PHARMACY_NATIVE_AP_IMMUTABLE/);
      await rejectedWrite(() => tx.$executeRaw`DELETE FROM pharmacy_supplier_expense_settlement_reversals WHERE id = ${reversal.id}`, /PHARMACY_NATIVE_AP_IMMUTABLE/);
      expect((await supplierExpenseAging(tx, scope, {})).rows[0]?.outstandingMinor).toBe(10_000);
      const voidInput = { invoiceId: invoice.id, reason: 'Mistake', at: new Date('2024-03-03Z'), idempotencyKey: 'void' };
      await voidSupplierExpenseInvoice(tx, scope, voidInput);
      await voidSupplierExpenseInvoice(tx, scope, voidInput);
      expect((await supplierExpenseAging(tx, scope, {})).rows).toEqual([]);
      const events = await tx.pharmacySupplierExpenseInvoiceEvent.findMany({ where: { organizationId } });
      expect(events.map(event => event.kind).sort()).toEqual(['CREATED', 'SETTLED', 'SETTLEMENT_REVERSED', 'VOID']);
      expect(events.every(event => event.actorId === actor.id)).toBe(true);
      const audits = await tx.auditLog.findMany({ where: { organizationId, category: 'FINANCE' } });
      expect(audits.map(audit => audit.action).sort()).toEqual([
        'pharmacyFinance.createExpenseInvoice', 'pharmacyFinance.reverseExpenseSettlement',
        'pharmacyFinance.settleExpenseInvoice', 'pharmacyFinance.voidExpenseInvoice',
      ]);
      expect(audits.every(audit => audit.actorId === actor.id)).toBe(true);
      const replacement = await createSupplierExpenseInvoice(tx, scope, { ...input, idempotencyKey: 'replacement' });
      expect(replacement.id).not.toBe(invoice.id);
      expect((await tx.pharmacySupplierExpenseInvoice.findFirst({ where: { organizationId, id: invoice.id } }))?.status).toBe('VOID');
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      // Always roll back: no cleanup can erase append-only accounting evidence.
      throw rollback;
    }, { timeout: 30_000 })).rejects.toBe(rollback);
  });
});
