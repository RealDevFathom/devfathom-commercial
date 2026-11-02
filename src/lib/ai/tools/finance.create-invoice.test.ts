import { describe, expect, it, vi } from 'vitest';
import type { AssistantHelpers } from '@/lib/ai/context';

vi.mock('server-only', () => ({}));

import { buildFinanceTools } from './finance';

// DEV-258: the assistant numbers invoices the same way as the routers, inside
// one transaction that holds the organization's numbering lock.
function setup() {
  const tx = {
    $queryRaw: vi.fn(async (query: { sql: string }) => {
      if (query.sql.includes('current_setting')) return [{ organizationId: 'org-1' }];
      if (query.sql.includes('pg_advisory_xact_lock')) return [];
      return [{ sequence: BigInt(11) }];
    }),
    invoice: {
      create: vi.fn(async ({ data }: { data: { invoiceNumber: string } }) => ({
        id: 'invoice-1',
        invoiceNumber: data.invoiceNumber,
        total: 300,
        status: 'DRAFT',
        dueDate: new Date('2026-12-31T00:00:00Z'),
        client: { name: 'Acme' },
      })),
    },
  };
  const db = {
    client: { findMany: vi.fn().mockResolvedValue([{ id: 'client-1', name: 'Acme' }]) },
    // Numbering and insert must not run on the per-operation client.
    invoice: { count: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(async (work: (inner: typeof tx) => unknown) => work(tx)),
  };
  const helpers = {
    db,
    isAdmin: true,
    ctx: { userId: 'admin-1' },
    now: () => new Date('2026-10-21T00:00:00Z'),
    resolveNamed: (_query: string, rows: { id: string; name: string }[]) => ({
      kind: 'resolved',
      value: rows[0],
    }),
    activity: vi.fn(),
    audit: vi.fn(),
    notifyUsers: vi.fn(),
  } as unknown as AssistantHelpers;
  const tool = buildFinanceTools(helpers).createInvoice as unknown as {
    execute(input: Record<string, unknown>): Promise<{ invoiceNumber?: string; error?: string }>;
  };
  return { db, tx, tool };
}

describe('assistant createInvoice numbering', () => {
  it('allocates the next number and inserts in the same transaction', async () => {
    const { db, tx, tool } = setup();
    const year = new Date().getFullYear();

    const result = await tool.execute({
      clientName: 'Acme',
      items: [{ description: 'Retainer', quantity: 3, unitPrice: 100 }],
      dueDate: '2026-12-31',
    });

    expect(result.invoiceNumber).toBe(`INV-${year}-012`);
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(tx.invoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ invoiceNumber: `INV-${year}-012` }),
      })
    );
    expect(tx.$queryRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(
      tx.invoice.create.mock.invocationCallOrder[0]!
    );
    expect(db.invoice.count).not.toHaveBeenCalled();
    expect(db.invoice.create).not.toHaveBeenCalled();
  });
});
