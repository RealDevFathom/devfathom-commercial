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
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
    },
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
