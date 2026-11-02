import { describe, expect, it, vi } from 'vitest';

import {
  allocateInvoiceNumber,
  createWithNextInvoiceNumber,
  formatInvoiceNumber,
} from './invoice-number';

type RawQuery = { sql: string; values: unknown[] };

function tenantTx(organizationId: string | null, sequence: bigint | number | null) {
  const $queryRaw = vi.fn(async (query: RawQuery) => {
    if (query.sql.includes('current_setting')) return [{ organizationId }];
    if (query.sql.includes('pg_advisory_xact_lock')) return [];
    return [{ sequence }];
  });
  return { $queryRaw };
}

describe('formatInvoiceNumber', () => {
  it('pads the sequence to three digits and keeps growing past 999', () => {
    expect(formatInvoiceNumber(2026, 1)).toBe('INV-2026-001');
    expect(formatInvoiceNumber(2026, 42)).toBe('INV-2026-042');
    expect(formatInvoiceNumber(2026, 1000)).toBe('INV-2026-1000');
  });
});

describe('allocateInvoiceNumber', () => {
  const now = new Date(2027, 0, 15);

  it('locks the organization, then reads its latest number for the year', async () => {
    const tx = tenantTx('org-a', 7n);

    await expect(allocateInvoiceNumber(tx as never, now)).resolves.toBe('INV-2027-008');

    const [tenant, lock, latest] = tx.$queryRaw.mock.calls.map(([query]) => query);
    expect(tenant.sql).toContain("current_setting('app.current_organization_id', true)");
    expect(lock.sql).toMatch(/^SELECT pg_advisory_xact_lock\(hashtextextended\(/);
    expect(lock.values).toEqual(['invoice-number:org-a']);
    expect(latest.sql).toContain('MAX(');
    expect(latest.values).toEqual(['^INV-2027-([0-9]+)$', 'org-a', 'INV-2027-%']);
  });

  it('starts the year at -001 when the organization has no invoice for it yet', async () => {
    await expect(allocateInvoiceNumber(tenantTx('org-a', null) as never, now)).resolves.toBe(
      'INV-2027-001'
    );
  });

  it('uses a different lock for each organization', async () => {
    const a = tenantTx('org-a', null);
    const b = tenantTx('org-b', null);

    await allocateInvoiceNumber(a as never, now);
    await allocateInvoiceNumber(b as never, now);

    expect(a.$queryRaw.mock.calls[1]![0].values).toEqual(['invoice-number:org-a']);
    expect(b.$queryRaw.mock.calls[1]![0].values).toEqual(['invoice-number:org-b']);
  });

  it('refuses to number an invoice outside a tenant transaction', async () => {
    const tx = tenantTx(null, null);

    await expect(allocateInvoiceNumber(tx as never, now)).rejects.toThrow(/tenant transaction/);
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
  });
});

describe('createWithNextInvoiceNumber', () => {
  it('allocates and creates inside the same transaction', async () => {
    const tx = tenantTx('org-a', 2);
    const db = { $transaction: vi.fn(async (work: (inner: typeof tx) => unknown) => work(tx)) };
    const create = vi.fn(async (_tx: unknown, invoiceNumber: string) => ({ invoiceNumber }));

    const invoice = await createWithNextInvoiceNumber(db as never, create);

    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(tx, `INV-${new Date().getFullYear()}-003`);
    expect(invoice).toEqual({ invoiceNumber: `INV-${new Date().getFullYear()}-003` });
  });
});
