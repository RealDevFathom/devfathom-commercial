import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { inventoryCountsHref } from '@/components/pharmacy/inventory/inventory-links';

import PharmacyInventoryCountsPage from './page';

beforeEach(() => vi.clearAllMocks());

describe('/pharmacy/inventory/counts', () => {
  it('redirects to the Physical count section and keeps the working branch', async () => {
    await PharmacyInventoryCountsPage({ searchParams: Promise.resolve({ branch: 'branch_a' }) });
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith(
      '/pharmacy/inventory?branch=branch_a#counts'
    );
  });

  it('redirects without a branch when none is given', async () => {
    await PharmacyInventoryCountsPage({ searchParams: Promise.resolve({}) });
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith('/pharmacy/inventory#counts');
  });
});

describe('inventoryCountsHref', () => {
  it('encodes the branch and ignores repeated or blank values', () => {
    expect(inventoryCountsHref('a b&c')).toBe('/pharmacy/inventory?branch=a+b%26c#counts');
    expect(inventoryCountsHref(['one', 'two'])).toBe('/pharmacy/inventory#counts');
    expect(inventoryCountsHref('  ')).toBe('/pharmacy/inventory#counts');
  });
});
