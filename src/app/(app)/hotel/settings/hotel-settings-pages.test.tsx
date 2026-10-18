import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import PropertyPage from './property/page';
import ExtrasPage from './extras/page';
const h = vi.hoisted(() => ({ choices: vi.fn(), select: vi.fn(), get: vi.fn(), list: vi.fn(), order: [] as string[] }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: async () => ({ session: { user: { id: 'user', organizationId: 'org' } } }) }));
vi.mock('@/server/routers/hotel-property', () => ({ hotelPropertyRouter: { createCaller: () => ({ access: { select: h.select }, get: h.get, extras: { properties: h.choices, list: h.list } }) } }));
vi.mock('@/components/hotel/property-settings-form', () => ({ HotelPropertySettingsForm: ({ selection }: { selection: { branchId: string } }) => <div>Settings for {selection.branchId}</div> }));
vi.mock('@/components/hotel/extras-catalog', () => ({ HotelExtrasCatalog: ({ selection }: { selection: { branchId: string } }) => <div>Catalog for {selection.branchId}</div> }));
beforeEach(() => {
  vi.clearAllMocks(); h.order = [];
  h.choices.mockResolvedValue({ properties: [{ branchId: 'one', name: 'One Hotel' },{ branchId: 'two', name: 'Two Hotel' }] });
  h.select.mockImplementation(async () => { h.order.push('select'); return { name: 'Two Hotel' }; });
  h.get.mockImplementation(async () => { h.order.push('get'); return {}; });
  h.list.mockImplementation(async () => { h.order.push('list'); return {}; });
});
afterEach(cleanup);
describe('Explicit Hotel settings property selection', () => {
  it.each([{ name: 'property', page: PropertyPage },{ name: 'extras', page: ExtrasPage }])('$name never selects a default', async ({ page }) => {
    render(await page({})); expect(screen.getByRole('combobox', { name: 'Property' })).toHaveValue('');
    expect(h.select).not.toHaveBeenCalled(); expect(h.get).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled();
  });
  it.each([{ name: 'property', page: PropertyPage, read: 'get' },{ name: 'extras', page: ExtrasPage, read: 'list' }])('$name rechecks selected access before reading', async ({ page, read }) => {
    render(await page({ searchParams: Promise.resolve({ branchId: 'two' }) }));
    expect(h.order).toEqual(['select', read]); expect(h.select).toHaveBeenCalledWith({ branchId: 'two', capability: 'hotel:property-admin' });
  });
  it.each([{ name: 'property', page: PropertyPage },{ name: 'extras', page: ExtrasPage }])('$name offers reselection after missing branch', async ({ page, name }) => {
    h.select.mockRejectedValueOnce(new TRPCError({ code: 'NOT_FOUND' }));
    render(await page({ searchParams: Promise.resolve({ branchId: 'gone' }) }));
    expect(screen.getByRole('link', { name: 'Choose another property' })).toHaveAttribute('href', `/hotel/settings/${name}`);
    expect(h.get).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled(); expect(screen.queryByText(/finish provisioning/)).not.toBeInTheDocument();
  });
});
