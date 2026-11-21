import { selectFieldControl } from '@/lib/testing/select-field';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import PropertyPage from './property/page';
import ExtrasPage from './extras/page';
import RoomsPage from './rooms/page';
import MealPlansPage from './meal-plans/page';
import SpacesPage from './spaces/page';
import JourneyPage from './journey/page';
const h = vi.hoisted(() => ({
  choices: vi.fn(),
  accessChoices: vi.fn(),
  byCapability: vi.fn(),
  select: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  roomTypes: vi.fn(),
  rooms: vi.fn(),
  mealPlans: vi.fn(),
  spaces: vi.fn(),
  journey: vi.fn(),
  order: [] as string[],
}));
vi.mock('@/server/trpc', () => ({
  createTRPCContext: async () => ({ session: { user: { id: 'user', organizationId: 'org' } } }),
}));
vi.mock('@/server/routers/hotel-property', () => ({
  hotelPropertyRouter: {
    createCaller: () => ({
      access: {
        select: h.select,
        properties: h.accessChoices,
        propertiesByCapability: h.byCapability,
      },
      get: h.get,
      extras: { properties: h.choices, list: h.list },
      inventory: { roomTypes: { list: h.roomTypes }, rooms: { list: h.rooms } },
      spaces: { list: h.spaces },
      journeyTemplates: { list: h.journey },
    }),
  },
}));
vi.mock('@/server/routers/hotel-rates', () => ({
  hotelRatesRouter: { createCaller: () => ({ mealPlans: { list: h.mealPlans } }) },
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
vi.mock('@/components/hotel/meal-plans-panel', () => ({
  HotelMealPlansPanel: ({ selection }: { selection: { branchId: string } }) => (
    <div>Meal plans for {selection.branchId}</div>
  ),
}));
vi.mock('@/components/hotel/function-spaces-panel', () => ({
  HotelFunctionSpacesPanel: ({ selection }: { selection: { branchId: string } }) => (
    <div>Function spaces for {selection.branchId}</div>
  ),
}));
vi.mock('@/components/hotel/journey-templates-editor', () => ({
  HotelJourneyTemplatesEditor: ({ selection }: { selection: { branchId: string } }) => (
    <div>Guest messages for {selection.branchId}</div>
  ),
}));
const reads = [h.get, h.list, h.roomTypes, h.rooms, h.mealPlans, h.spaces, h.journey];
beforeEach(() => {
  vi.clearAllMocks();
  h.order = [];
  h.choices.mockResolvedValue({
    properties: [
      { branchId: 'one', name: 'One Hotel' },
      { branchId: 'two', name: 'Two Hotel' },
    ],
  });
  h.accessChoices.mockResolvedValue({
    properties: [
      { branchId: 'one', name: 'One Hotel' },
      { branchId: 'two', name: 'Two Hotel' },
    ],
  });
  h.byCapability.mockResolvedValue({
    properties: [
      { branchId: 'one', name: 'One Hotel', capabilities: ['hotel:marketing'] },
      { branchId: 'two', name: 'Two Hotel', capabilities: ['hotel:property-admin'] },
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
  h.mealPlans.mockImplementation(async () => {
    h.order.push('mealPlans');
    return {};
  });
  h.spaces.mockImplementation(async () => {
    h.order.push('spaces');
    return {};
  });
  h.journey.mockImplementation(async () => {
    h.order.push('journey');
    return {};
  });
});
afterEach(cleanup);
const pages = [
  { name: 'property', page: PropertyPage, reads: ['get'], capability: 'hotel:property-admin' },
  { name: 'extras', page: ExtrasPage, reads: ['list'], capability: 'hotel:property-admin' },
  {
    name: 'rooms',
    page: RoomsPage,
    reads: ['roomTypes', 'rooms'],
    capability: 'hotel:property-admin',
  },
  // Meal plans are rate administration, so the page's gate and chooser use `hotel:rates`.
  { name: 'meal-plans', page: MealPlansPage, reads: ['mealPlans'], capability: 'hotel:rates' },
  { name: 'spaces', page: SpacesPage, reads: ['spaces'], capability: 'hotel:property-admin' },
  // Guest messages open under property administration OR marketing; the page
  // asks for property administration first, exactly as the router's resolver does.
  { name: 'journey', page: JourneyPage, reads: ['journey'], capability: 'hotel:property-admin' },
];
describe('Explicit Hotel settings property selection', () => {
  it.each(pages)('$name never selects a default', async ({ page }) => {
    render(await page({}));
    expect(selectFieldControl(screen.getByRole('combobox', { name: 'Property' }))).toHaveValue('');
    expect(h.select).not.toHaveBeenCalled();
    for (const read of reads) expect(read).not.toHaveBeenCalled();
  });
  it.each(pages)(
    '$name rechecks selected access before reading',
    async ({ page, reads: expected, capability }) => {
      render(await page({ searchParams: Promise.resolve({ branchId: 'two' }) }));
      expect(h.order).toEqual(['select', ...expected]);
      expect(h.select).toHaveBeenCalledWith({ branchId: 'two', capability });
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
  it('offers the meal-plans chooser under hotel:rates, never the property-admin list', async () => {
    render(await MealPlansPage({}));
    expect(h.accessChoices).toHaveBeenCalledWith({ capability: 'hotel:rates' });
    expect(h.choices).not.toHaveBeenCalled();
    expect(selectFieldControl(screen.getByRole('combobox', { name: 'Property' }))).toHaveValue('');
    expect(screen.getByRole('option', { hidden: true, name: 'Two Hotel' })).toBeInTheDocument();
  });
  it('mounts the meal-plans panel with the selection it was opened for', async () => {
    render(await MealPlansPage({ searchParams: Promise.resolve({ branchId: 'two' }) }));
    expect(screen.getByText('Meal plans for two')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Two Hotel' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change property' })).toHaveAttribute(
      'href',
      '/hotel/settings/meal-plans'
    );
  });
  it('explains a denied meal-plans read as missing rate administration', async () => {
    h.select.mockRejectedValueOnce(new TRPCError({ code: 'FORBIDDEN' }));
    render(await MealPlansPage({ searchParams: Promise.resolve({ branchId: 'two' }) }));
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'You cannot manage this property’s meal plans',
      })
    ).toBeInTheDocument();
    expect(screen.getByText(/rate administration/)).toBeInTheDocument();
    expect(h.mealPlans).not.toHaveBeenCalled();
  });
  it('offers a retry when the meal-plans read itself fails', async () => {
    h.mealPlans.mockRejectedValueOnce(new TRPCError({ code: 'INTERNAL_SERVER_ERROR' }));
    render(await MealPlansPage({ searchParams: Promise.resolve({ branchId: 'two' }) }));
    expect(screen.getByRole('link', { name: 'Retry loading meal plans' })).toHaveAttribute(
      'href',
      '/hotel/settings/meal-plans?branchId=two'
    );
  });
  it('mounts the spaces panel with the selection it was opened for', async () => {
    render(await SpacesPage({ searchParams: Promise.resolve({ branchId: 'two' }) }));
    expect(screen.getByText('Function spaces for two')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Two Hotel' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change property' })).toHaveAttribute(
      'href',
      '/hotel/settings/spaces'
    );
  });
  it('tells a workspace without Banquets and Events apart from a member without access', async () => {
    h.spaces.mockRejectedValueOnce(
      new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Function spaces need the Banquets and Events module, which this workspace does not have.',
      })
    );
    render(await SpacesPage({ searchParams: Promise.resolve({ branchId: 'two' }) }));
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Function spaces are not part of this workspace’s package',
      })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute(
      'href',
      '/dashboard'
    );
    expect(screen.queryByRole('link', { name: 'Choose another property' })).toBeNull();
    cleanup();
    h.select.mockRejectedValueOnce(new TRPCError({ code: 'FORBIDDEN' }));
    render(await SpacesPage({ searchParams: Promise.resolve({ branchId: 'two' }) }));
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'You cannot manage this property’s function spaces',
      })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose another property' })).toBeInTheDocument();
  });
  it('offers the guest-messages chooser under either capability, never the property-admin list', async () => {
    render(await JourneyPage({}));
    expect(h.byCapability).toHaveBeenCalledWith({
      capabilities: ['hotel:property-admin', 'hotel:marketing'],
    });
    expect(h.choices).not.toHaveBeenCalled();
    expect(h.accessChoices).not.toHaveBeenCalled();
    expect(selectFieldControl(screen.getByRole('combobox', { name: 'Property' }))).toHaveValue('');
    expect(screen.getByRole('option', { hidden: true, name: 'One Hotel' })).toBeInTheDocument();
    expect(screen.getByRole('option', { hidden: true, name: 'Two Hotel' })).toBeInTheDocument();
  });
  it('mounts the guest-messages editor with the selection it was opened for', async () => {
    render(await JourneyPage({ searchParams: Promise.resolve({ branchId: 'two' }) }));
    expect(screen.getByText('Guest messages for two')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Two Hotel' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change property' })).toHaveAttribute(
      'href',
      '/hotel/settings/journey'
    );
  });
  it('falls back to marketing when property administration is denied, before the read', async () => {
    h.select.mockImplementationOnce(async () => {
      h.order.push('select');
      throw new TRPCError({ code: 'FORBIDDEN' });
    });
    render(await JourneyPage({ searchParams: Promise.resolve({ branchId: 'two' }) }));
    expect(h.order).toEqual(['select', 'select', 'journey']);
    expect(h.select.mock.calls.map(([input]) => input)).toEqual([
      { branchId: 'two', capability: 'hotel:property-admin' },
      { branchId: 'two', capability: 'hotel:marketing' },
    ]);
    expect(screen.getByText('Guest messages for two')).toBeInTheDocument();
  });
  it('explains a member holding neither capability, and tells a workspace without the module apart', async () => {
    h.select.mockRejectedValueOnce(new TRPCError({ code: 'FORBIDDEN' }));
    h.select.mockRejectedValueOnce(new TRPCError({ code: 'FORBIDDEN' }));
    render(await JourneyPage({ searchParams: Promise.resolve({ branchId: 'two' }) }));
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'You cannot work on this property’s guest messages',
      })
    ).toBeInTheDocument();
    expect(screen.getByText(/property administration or marketing/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose another property' })).toBeInTheDocument();
    expect(h.journey).not.toHaveBeenCalled();
    cleanup();
    h.journey.mockRejectedValueOnce(
      new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Guest messages need the Guest Journey and Upsell module, which this workspace does not have.',
      })
    );
    render(await JourneyPage({ searchParams: Promise.resolve({ branchId: 'two' }) }));
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Guest messages are not part of this workspace’s package',
      })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute(
      'href',
      '/dashboard'
    );
    expect(screen.queryByRole('link', { name: 'Choose another property' })).toBeNull();
  });
  it('offers a retry when the guest-messages read itself fails', async () => {
    h.journey.mockRejectedValueOnce(new TRPCError({ code: 'INTERNAL_SERVER_ERROR' }));
    render(await JourneyPage({ searchParams: Promise.resolve({ branchId: 'two' }) }));
    expect(screen.getByRole('link', { name: 'Retry loading guest messages' })).toHaveAttribute(
      'href',
      '/hotel/settings/journey?branchId=two'
    );
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
