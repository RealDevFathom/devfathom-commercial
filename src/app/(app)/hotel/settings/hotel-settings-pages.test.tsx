import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import PropertyPage from './property/page';
import ExtrasPage from './extras/page';
import RoomsPage from './rooms/page';
const h = vi.hoisted(() => ({
  choices: vi.fn(),
  select: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  roomTypes: vi.fn(),
  rooms: vi.fn(),
  order: [] as string[],
}));
vi.mock('@/server/trpc', () => ({
  createTRPCContext: async () => ({ session: { user: { id: 'user', organizationId: 'org' } } }),
}));
vi.mock('@/server/routers/hotel-property', () => ({
  hotelPropertyRouter: {
    createCaller: () => ({
      access: { select: h.select },
      get: h.get,
      extras: { properties: h.choices, list: h.list },
      inventory: { roomTypes: { list: h.roomTypes }, rooms: { list: h.rooms } },
    }),
  },
}));
vi.mock('@/components/hotel/property-settings-form', () => ({
  HotelPropertySettingsForm: ({ selection }: { selection: { branchId: string } }) => (
    <div>Settings for {selection.branchId}</div>
  ),
}));
vi.mock('@/components/hotel/extras-catalog', () => ({
  HotelExtrasCatalog: ({ selection }: { selection: { branchId: string } }) => (
    <div>Catalog for {selection.branchId}</div>
  ),
}));
vi.mock('@/components/hotel/inventory-panel', () => ({
  HotelInventoryPanel: ({ selection }: { selection: { branchId: string } }) => (
    <div>Rooms for {selection.branchId}</div>
  ),
}));
const reads = [h.get, h.list, h.roomTypes, h.rooms];
beforeEach(() => {
  vi.clearAllMocks();
  h.order = [];
  h.choices.mockResolvedValue({
    properties: [
      { branchId: 'one', name: 'One Hotel' },
      { branchId: 'two', name: 'Two Hotel' },
    ],
  });
  h.select.mockImplementation(async () => {
    h.order.push('select');
    return { name: 'Two Hotel' };
  });
  h.get.mockImplementation(async () => {
    h.order.push('get');
    return {};
  });
  h.list.mockImplementation(async () => {
    h.order.push('list');
    return {};
  });
  h.roomTypes.mockImplementation(async () => {
    h.order.push('roomTypes');
    return {};
  });
  h.rooms.mockImplementation(async () => {
    h.order.push('rooms');
    return {};
  });
});
afterEach(cleanup);
const pages = [
  { name: 'property', page: PropertyPage, reads: ['get'] },
  { name: 'extras', page: ExtrasPage, reads: ['list'] },
  { name: 'rooms', page: RoomsPage, reads: ['roomTypes', 'rooms'] },
];
describe('Explicit Hotel settings property selection', () => {
  it.each(pages)('$name never selects a default', async ({ page }) => {
    render(await page({}));
    expect(screen.getByRole('combobox', { name: 'Property' })).toHaveValue('');
    expect(h.select).not.toHaveBeenCalled();
    for (const read of reads) expect(read).not.toHaveBeenCalled();
  });
  it.each(pages)(
    '$name rechecks selected access before reading',
    async ({ page, reads: expected }) => {
      render(await page({ searchParams: Promise.resolve({ branchId: 'two' }) }));
      expect(h.order).toEqual(['select', ...expected]);
      expect(h.select).toHaveBeenCalledWith({
        branchId: 'two',
        capability: 'hotel:property-admin',
      });
      for (const read of reads)
        for (const [input] of read.mock.calls) expect(input).toMatchObject({ branchId: 'two' });
    }
  );
  it.each(pages)('$name offers reselection after missing branch', async ({ page, name }) => {
    h.select.mockRejectedValueOnce(new TRPCError({ code: 'NOT_FOUND' }));
    render(await page({ searchParams: Promise.resolve({ branchId: 'gone' }) }));
    expect(screen.getByRole('link', { name: 'Choose another property' })).toHaveAttribute(
      'href',
      `/hotel/settings/${name}`
    );
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(screen.queryByText(/finish provisioning/)).not.toBeInTheDocument();
  });
  it('mounts the rooms panel with the selection it was opened for', async () => {
    render(await RoomsPage({ searchParams: Promise.resolve({ branchId: 'two' }) }));
    expect(screen.getByText('Rooms for two')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Two Hotel' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change property' })).toHaveAttribute(
      'href',
      '/hotel/settings/rooms'
    );
  });
});
