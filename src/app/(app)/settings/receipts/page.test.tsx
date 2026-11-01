import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  notFound: vi.fn(),
}));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/components/receipts/receipt-designer', () => ({ ReceiptDesigner: () => null }));

import ReceiptDesignerPage from './page';
import { ReceiptDesigner } from '@/components/receipts/receipt-designer';

function actor(vertical?: string) {
  return { session: { user: { id: 'user_1' } }, organization: { id: 'org_1', vertical } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notFound.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND');
  });
});

describe('ReceiptDesignerPage', () => {
  it('renders the designer for restaurant organizations', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor('RESTAURANT'));
    const page = await ReceiptDesignerPage();
    expect(page.type).toBe(ReceiptDesigner);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it.each(['PHARMACY', 'HOSPITALITY', 'AGENCY', undefined])(
    'returns not found for vertical %s',
    async (vertical) => {
      mocks.resolveTenantActor.mockResolvedValue(actor(vertical));
      await expect(ReceiptDesignerPage()).rejects.toThrow('NEXT_NOT_FOUND');
    }
  );

  it('returns not found without a tenant actor', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);
    await expect(ReceiptDesignerPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
