import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ db: { pharmacySale: { findFirst: vi.fn() } } }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: (_organizationId: string, run: (db: unknown) => unknown) => run(mocks.db),
}));

import {
  hostedReceiptRecipientOptedOut,
  tenantHostedReceiptRecipientOptedOut,
} from './hosted-receipt-store';

const phone = '923001234567';

function fixture() {
  const customer = {
    findFirst: vi.fn(async () => null as { id: string } | null),
    findMany: vi.fn(async () => [] as { id: string; patient: { phone: string } }[]),
  };
  return { customer, db: { pharmacyCustomer: customer } as unknown as ScopedDb };
}

beforeEach(() => vi.clearAllMocks());

describe('hosted receipt recipient opt-out', () => {
  it('checks the linked opted-out customer independently of all suffix matches', async () => {
    const { db, customer } = fixture();
    customer.findFirst.mockResolvedValue({ id: 'linked' });
    customer.findMany.mockResolvedValue(
      Array.from({ length: 60 }, (_, index) => ({ id: `other-${index}`, patient: { phone: '923119994567' } }))
    );
    expect(await hostedReceiptRecipientOptedOut(db, 'org-a', phone, 'linked')).toBe(true);
    expect(customer.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: 'linked', whatsappOptIn: false },
      select: { id: true },
    });
    expect(customer.findMany).not.toHaveBeenCalled();
  });

  it('finds a normalized matching phone beyond the first page', async () => {
    const { db, customer } = fixture();
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      id: String(index).padStart(3, '0'), patient: { phone: '923119994567' },
    }));
    customer.findMany.mockResolvedValueOnce(firstPage).mockResolvedValueOnce([
      { id: '200', patient: { phone: '۰۳۰۰ ۱۲۳۴۵۶۷  ' } },
    ]);
    expect(await hostedReceiptRecipientOptedOut(db, 'org-a', phone)).toBe(true);
    expect(customer.findMany).toHaveBeenNthCalledWith(2, {
      where: { organizationId: 'org-a', whatsappOptIn: false, id: { gt: '199' } },
      select: { id: true, patient: { select: { phone: true } } },
      orderBy: { id: 'asc' }, take: 200,
    });
  });

  it.each(['0300 1234567 ', '+92 (300) 123-4567', '٠٣٠٠ ١٢٣٤٥٦٧'])(
    'normalizes %s before matching', async (raw) => {
      const { db, customer } = fixture();
      customer.findMany.mockResolvedValue([{ id: 'match', patient: { phone: raw } }]);
      expect(await hostedReceiptRecipientOptedOut(db, 'org-a', phone)).toBe(true);
    }
  );

  it('allows an unrelated opted-out identity after exhausting all pages', async () => {
    const { db, customer } = fixture();
    customer.findMany.mockResolvedValue([{ id: 'other', patient: { phone: '923119994567' } }]);
    expect(await hostedReceiptRecipientOptedOut(db, 'org-a', phone, 'linked')).toBe(false);
    expect(customer.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: 'org-a', whatsappOptIn: false },
    }));
  });

  it('rechecks the sale-linked customer for resends even if their phone changed', async () => {
    const { db, customer } = fixture();
    Object.assign(mocks.db, db);
    mocks.db.pharmacySale.findFirst.mockResolvedValue({ customerId: 'linked' });
    customer.findFirst.mockResolvedValue({ id: 'linked' });
    expect(await tenantHostedReceiptRecipientOptedOut('org-a', phone, 'sale-a')).toBe(true);
    expect(mocks.db.pharmacySale.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: 'sale-a' }, select: { customerId: true },
    });
  });
});
