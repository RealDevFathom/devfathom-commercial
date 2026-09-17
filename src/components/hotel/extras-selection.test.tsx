import { act, fireEvent, render, screen } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  context: vi.fn(),
  select: vi.fn(),
  properties: vi.fn(),
  query: vi.fn(),
  list: vi.fn(),
  fetch: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  active: vi.fn(),
  createHook: vi.fn(),
  updateHook: vi.fn(),
  activeHook: vi.fn(),
}));
vi.mock('next-auth/react', () => ({ useSession: mocks.session }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/server/routers/hotel-property', () => ({
  hotelPropertyRouter: {
    createCaller: () => ({
      access: { select: mocks.select },
      extras: { properties: mocks.properties, list: mocks.list },
    }),
  },
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ hotelProperty: { extras: { list: { fetch: mocks.fetch } } } }),
    hotelProperty: {
      extras: {
        properties: { useQuery: mocks.query },
        create: { useMutation: mocks.createHook },
        update: { useMutation: mocks.updateHook },
        setActive: { useMutation: mocks.activeHook },
      },
    },
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.ComponentProps<'a'>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/hotel/settings/extras' }));
vi.mock('motion/react', () => ({
  m: {
    span: ({ children, ...props }: React.ComponentProps<'span'>) => (
      <span {...props}>{children}</span>
    ),
  },
}));
vi.mock('@/components/preferences-provider', () => ({
  usePreferences: () => ({ icons: 'numbered' }),
}));

import Page from '@/app/(app)/hotel/settings/extras/page';
import { EntitlementsProvider } from '@/components/entitlements-provider';
import { TopNavigation } from '@/components/layout/sidebar';
import type { EntitlementView } from '@/lib/module-catalog';
import { hotelDepartmentOptions, hotelExtraRecurrenceOptions } from '@/lib/hotel/extras';
import { HotelExtrasCatalog } from './extras-catalog';

const selection = { branchId: 'property_a', organizationId: 'org_a', userId: 'staff_a' };
const user = {
  id: selection.userId,
  organizationId: selection.organizationId,
  role: 'EMPLOYEE',
  status: 'ACTIVE',
};
const choices = {
  userId: user.id,
  organizationId: user.organizationId,
  properties: [
    { branchId: 'property_a', name: 'Selected A' },
    { branchId: 'property_c', name: 'Selected C' },
  ],
};
type View = Parameters<typeof HotelExtrasCatalog>[0]['initial'];
const empty = {
  extras: [],
  departmentOptions: hotelDepartmentOptions,
  recurrenceOptions: hotelExtraRecurrenceOptions,
} satisfies View;
const item = {
  id: 'extra_a',
  organizationId: 'org_a',
  branchId: 'property_a',
  code: 'TEA',
  name: 'Tea service',
  nameUr: null,
  priceMinor: 500,
  taxClass: 'SERVICES',
  department: 'MISCELLANEOUS',
  postingRule: {},
  upsellable: false,
  upsellPriceMinor: null,
  recurring: 'NONE',
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies View['extras'][number];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockReturnValue({ data: { user } });
  mocks.context.mockResolvedValue({ session: { user } });
  mocks.select.mockResolvedValue({ branchId: 'property_a', name: 'Selected A' });
  mocks.properties.mockResolvedValue(choices);
  mocks.query.mockReturnValue({ data: choices, isError: false, isFetching: false });
  mocks.list.mockResolvedValue(empty);
  mocks.fetch.mockResolvedValue(empty);
  mocks.createHook.mockReturnValue({ mutate: mocks.create, isPending: false });
  mocks.updateHook.mockReturnValue({ mutate: mocks.update, isPending: false });
  mocks.activeHook.mockReturnValue({ mutate: mocks.active, isPending: false });
});

describe('Extras explicit property selection', () => {
  it('asks for a named choice without loading or auto-selecting the first catalog', async () => {
    render(await Page());
    expect(screen.getByLabelText('Property')).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Selected A' })).toHaveValue('property_a');
    expect(screen.getByRole('option', { name: 'Selected C' })).toHaveValue('property_c');
    expect(screen.getByRole('button', { name: 'Open catalog' }).closest('form')).toHaveAttribute(
      'method',
      'get'
    );
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('explains missing assignments without inventing a default property', async () => {
    mocks.properties.mockResolvedValue({ ...choices, properties: [] });
    render(await Page());
    expect(screen.getByText(/No properties are available/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('revalidates the requested choice and passes it to the catalog read', async () => {
    render(await Page({ searchParams: Promise.resolve({ branchId: ' property_a ' }) }));
    expect(mocks.select).toHaveBeenCalledWith({
      branchId: 'property_a',
      capability: 'hotel:property-admin',
    });
    expect(mocks.list).toHaveBeenCalledWith({
      branchId: 'property_a',
      includeInactive: false,
      upsellableOnly: false,
    });
    expect(screen.getByRole('heading', { name: 'Selected A' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change property' })).toHaveAttribute(
      'href',
      '/hotel/settings/extras'
    );
  });

  it('denied or stale selection cannot load another catalog', async () => {
    mocks.select.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    render(await Page({ searchParams: Promise.resolve({ branchId: 'property_b' }) }));
    expect(
      screen.getByRole('heading', { name: 'You cannot manage this catalog' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose another property' })).toBeInTheDocument();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.properties).not.toHaveBeenCalled();
  });

  it('retries the same encoded selection after a read failure', async () => {
    mocks.list.mockRejectedValue(new Error('private detail'));
    render(await Page({ searchParams: Promise.resolve({ branchId: 'a/b&c' }) }));
    expect(screen.getByRole('link', { name: 'Retry loading catalog' })).toHaveAttribute(
      'href',
      '/hotel/settings/extras?branchId=a%2Fb%26c'
    );
    expect(screen.queryByText('private detail')).not.toBeInTheDocument();
  });

  it.each([null, { ...user, id: 'other_user' }, { ...user, organizationId: 'other_org' }])(
    'hides the previous catalog when session identity is %j',
    (changedUser) => {
      mocks.session.mockReturnValue({ data: changedUser ? { user: changedUser } : null });
      render(<HotelExtrasCatalog initial={{ ...empty, extras: [item] }} selection={selection} />);
      expect(screen.getByRole('heading', { name: 'Reload this catalog' })).toBeInTheDocument();
      expect(screen.queryByText('Tea service')).not.toBeInTheDocument();
      expect(screen.queryByRole('form')).not.toBeInTheDocument();
    }
  );

  it('discards the previous property draft and rows on a new selection', () => {
    const view = render(
      <HotelExtrasCatalog initial={{ ...empty, extras: [item] }} selection={selection} />
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unsaved A' } });
    view.rerender(
      <HotelExtrasCatalog initial={empty} selection={{ ...selection, branchId: 'property_c' }} />
    );
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.queryByText('Tea service')).not.toBeInTheDocument();
  });

  it('binds create, update, retire and refresh to the chosen branch', async () => {
    render(<HotelExtrasCatalog initial={{ ...empty, extras: [item] }} selection={selection} />);
    for (const [label, value] of [
      ['Code', 'COFFEE'],
      ['Name', 'Coffee'],
      ['Price (PKR)', '50'],
      ['Tax class', 'SERVICES'],
    ])
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.submit(screen.getByRole('form'));
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'property_a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.submit(screen.getByRole('form'));
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'property_a', id: 'extra_a' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    expect(mocks.active).toHaveBeenCalledWith({
      branchId: 'property_a',
      id: 'extra_a',
      active: false,
    });
    await act(async () => {
      mocks.activeHook.mock.lastCall![0].onSuccess({ id: 'extra_a', active: false });
    });
    expect(mocks.fetch).toHaveBeenCalledWith({
      branchId: 'property_a',
      includeInactive: false,
      upsellableOnly: false,
    });
  });
});

function navigation(
  vertical: EntitlementView['vertical'] = 'HOSPITALITY',
  enabledModules = ['hotel-core']
) {
  render(
    <EntitlementsProvider
      value={{
        organizationId: 'org_a',
        vertical,
        enabledModules,
        seatLimit: 10,
        activeSeats: 1,
        modules: [],
        limits: {},
      }}
    >
      <TopNavigation />
    </EntitlementsProvider>
  );
}

describe('Extras effective navigation capability', () => {
  it('shows an authorized non-ADMIN the Extras entry', () => {
    navigation();
    expect(screen.getByRole('link', { name: /Extras/ })).toHaveAttribute(
      'href',
      '/hotel/settings/extras'
    );
    expect(mocks.query).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ enabled: true, staleTime: 0, refetchOnMount: 'always' })
    );
  });
  it.each([
    { data: { ...choices, properties: [] } },
    { isError: true, data: choices },
    { isFetching: true, data: choices },
    { data: { ...choices, userId: 'old_user' } },
    { data: { ...choices, organizationId: 'old_org' } },
  ])('does not grant ADMIN navigation from absent, stale or denied access %j', (result) => {
    mocks.session.mockReturnValue({ data: { user: { ...user, role: 'ADMIN' } } });
    mocks.query.mockReturnValue(result);
    navigation();
    expect(screen.queryByRole('link', { name: /Extras/ })).not.toBeInTheDocument();
  });
  it.each([
    ['HOSPITALITY', []],
    ['RESTAURANT', ['hotel-core']],
  ] as const)('preserves vertical/module gate for %s %j', (vertical, modules) => {
    navigation(vertical, [...modules]);
    expect(screen.queryByRole('link', { name: /Extras/ })).not.toBeInTheDocument();
    expect(mocks.query).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ enabled: false })
    );
  });
});
