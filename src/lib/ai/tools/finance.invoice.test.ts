import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantHelpers } from '@/lib/ai/context';

vi.mock('server-only', () => ({}));

import { buildFinanceTools } from './finance';

type Execute = { execute(input: Record<string, unknown>): Promise<Record<string, unknown>> };

function setup() {
  const db = {
    client: { findMany: vi.fn().mockResolvedValue([{ id: 'client-1', name: 'Acme' }]) },
    project: { findMany: vi.fn().mockResolvedValue([]) },
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        legalName: 'Northwind Agency LLC',
        displayName: 'Northwind',
        invoiceAddress: '42 Market Street',
        invoiceTaxId: null,
      }),
    },
    invoice: {
      findMany: vi.fn().mockResolvedValue([{ id: 'invoice-1', invoiceNumber: 'INV-2026-001' }]),
      findUnique: vi.fn().mockResolvedValue({
        invoiceNumber: 'INV-2026-001',
        status: 'SENT',
        currency: 'USD',
        subtotal: 100,
        tax: 0,
        total: 100,
        dueDate: new Date('2026-11-30T00:00:00Z'),
        sentAt: null,
        paidAt: null,
        notes: null,
        items: [],
        client: { name: 'Acme', contacts: [] },
        project: null,
      }),
      create: vi.fn(),
    },
    // createInvoice allocates its number under the organization's lock in one
    // transaction (#1226); answer those statements as finance.create-invoice.test does.
    $queryRaw: vi.fn(async (query: { sql: string }) => {
      if (query.sql.includes('current_setting')) return [{ organizationId: 'agency-1' }];
      if (query.sql.includes('pg_advisory_xact_lock')) return [];
      return [{ sequence: BigInt(0) }];
    }),
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)),
  };
  const helpers = {
    db,
    isAdmin: true,
    ctx: { userId: 'admin-1', organizationId: 'agency-1' },
    now: () => new Date('2026-11-02T00:00:00Z'),
    resolveNamed: (_query: string, rows: Array<{ id: string; name: string }>) => ({
      kind: 'one',
      value: rows[0],
    }),
    activity: vi.fn(),
    audit: vi.fn(),
    notifyUsers: vi.fn(),
  } as unknown as AssistantHelpers;
  const tools = buildFinanceTools(helpers) as unknown as Record<string, Execute>;
  return { db, helpers, tools };
}

describe('assistant getInvoice seller identity (#458)', () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports this workspace as the issuer, read under the assistant's workspace", async () => {
    const { db, tools } = setup();

    const result = await tools.getInvoice.execute({ invoiceNumber: 'INV-2026-001' });

    expect(db.invoice.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'invoice-1', organizationId: 'agency-1' } })
    );
    expect(db.organization.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'agency-1' } })
    );
    expect(result.issuer).toEqual({
      name: 'Northwind Agency LLC',
      address: '42 Market Street',
      taxId: null,
    });
  });
});

describe('assistant createInvoice tax and discount (#448)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists the shared cent-exact amounts, discount included', async () => {
    const { db, tools } = setup();
    db.invoice.create.mockResolvedValue({
      id: 'invoice-9',
      invoiceNumber: 'INV-2026-001',
      total: 1.64,
      client: { name: 'Acme' },
    });

    const result = await tools.createInvoice.execute({
      clientName: 'Acme',
      items: [
        { description: 'Pack', quantity: 3, unitPrice: 0.335 },
        { description: 'Third', quantity: 3, unitPrice: 1 / 3 },
      ],
      discount: 0.5,
      tax: 0.125,
      dueDate: '2026-11-30',
    });

    expect(db.invoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          items: [
            { description: 'Pack', quantity: 3, rate: 0.335, amount: 1.01 },
            { description: 'Third', quantity: 3, rate: 1 / 3, amount: 1 },
          ],
          subtotal: 2.01,
          discount: 0.5,
          tax: 0.13,
          total: 1.64,
        }),
      })
    );
    expect(result).toMatchObject({ subtotal: 2.01, total: 1.64 });
  });

  it('refuses a discount above the subtotal without writing', async () => {
    const { db, tools } = setup();

    const result = await tools.createInvoice.execute({
      clientName: 'Acme',
      items: [{ description: 'Work', quantity: 1, unitPrice: 100 }],
      discount: 150,
      dueDate: '2026-11-30',
    });

    expect(result).toEqual({ error: 'Discount cannot be more than the subtotal.' });
    expect(db.invoice.create).not.toHaveBeenCalled();
  });
});
