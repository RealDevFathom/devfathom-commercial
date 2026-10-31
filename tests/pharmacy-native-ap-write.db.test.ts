// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
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
      expect((await supplierExpenseAging(tx, scope, {})).rows).toEqual([expect.objectContaining({ id: invoice.id, outstandingMinor: 10_000 })]);
      const paymentInput = {
        invoiceId: invoice.id, amountMinor: 7_000, occurredAt: new Date('2024-03-01Z'),
        reference: 'PAY-1', idempotencyKey: 'pay',
      };
      const settlement = await settleSupplierExpenseInvoice(tx, scope, paymentInput);
      expect(settlement.createdByUserId).toBe(actor.id);
      expect((await settleSupplierExpenseInvoice(tx, scope, paymentInput)).id).toBe(settlement.id);
      await expect(voidSupplierExpenseInvoice(tx, scope, { invoiceId: invoice.id, reason: 'Mistake', at: new Date('2024-03-02Z'), idempotencyKey: 'void' })).rejects.toMatchObject({ reason: 'INVALID_STATE' });
      const reversalInput = { settlementId: settlement.id, reason: 'Mistake', at: new Date('2024-03-02Z'), idempotencyKey: 'reverse' };
      const reversal = await reverseSupplierExpenseSettlement(tx, scope, reversalInput);
      expect((await reverseSupplierExpenseSettlement(tx, scope, reversalInput)).id).toBe(reversal.id);
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
      // Always roll back: no cleanup can erase append-only accounting evidence.
      throw rollback;
    }, { timeout: 30_000 })).rejects.toBe(rollback);
  });
});
