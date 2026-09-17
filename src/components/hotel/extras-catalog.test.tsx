import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setActive: vi.fn(),
  createHook: vi.fn(),
  updateHook: vi.fn(),
  activeHook: vi.fn(),
  list: vi.fn(),
  context: vi.fn(),
  select: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'user_1', organizationId: 'org_1' } } }),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ hotelProperty: { extras: { list: { fetch: mocks.fetch } } } }),
    hotelProperty: {
      extras: {
        create: { useMutation: mocks.createHook },
        update: { useMutation: mocks.updateHook },
        setActive: { useMutation: mocks.activeHook },
      },
    },
  },
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/server/routers/hotel-property', () => ({
  hotelPropertyRouter: {
    createCaller: () => ({ access: { select: mocks.select }, extras: { list: mocks.list } }),
  },
}));

import HotelExtrasSettingsPage from '@/app/(app)/hotel/settings/extras/page';
import { hotelDepartmentOptions, hotelExtraRecurrenceOptions } from '@/lib/hotel/extras';
import { HotelExtrasCatalog } from './extras-catalog';

const selection = { branchId: 'branch_1', organizationId: 'org_1', userId: 'user_1' };
const selectedPage = () =>
  HotelExtrasSettingsPage({ searchParams: Promise.resolve({ branchId: 'branch_1' }) });

type CatalogView = Parameters<typeof HotelExtrasCatalog>[0]['initial'];
const extra = {
  id: 'extra_1',
  organizationId: 'org_1',
  branchId: 'branch_1',
  code: 'LAUNDRY',
  name: 'Laundry service',
  nameUr: 'کپڑے دھلائی',
  priceMinor: 45_000,
  taxClass: 'SERVICES',
  department: 'LAUNDRY',
  postingRule: {},
  upsellable: true,
  upsellPriceMinor: 39_000,
  recurring: 'PER_STAY',
  active: true,
  createdAt: new Date('2026-09-08T00:00:00Z'),
  updatedAt: new Date('2026-09-08T00:00:00Z'),
} satisfies CatalogView['extras'][number];

const empty = {
  extras: [],
  departmentOptions: hotelDepartmentOptions,
  recurrenceOptions: hotelExtraRecurrenceOptions,
} satisfies CatalogView;

function fillCreate() {
  for (const [label, value] of [
    ['Code', 'LAUNDRY'],
    ['Name', 'Laundry service'],
    ['Name in Urdu', 'کپڑے دھلائی'],
    ['Price (PKR)', '450.00'],
    ['Tax class', 'SERVICES'],
    ['Posting department', 'LAUNDRY'],
    ['How often it is charged', 'PER_STAY'],
  ]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByLabelText('Offer this before arrival'));
  fireEvent.change(screen.getByLabelText('Offer price (PKR)'), { target: { value: '390.00' } });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createHook.mockReturnValue({ mutate: mocks.create, isPending: false });
  mocks.updateHook.mockReturnValue({ mutate: mocks.update, isPending: false });
  mocks.activeHook.mockReturnValue({ mutate: mocks.setActive, isPending: false });
  mocks.fetch.mockResolvedValue(empty);
  mocks.list.mockResolvedValue(empty);
  mocks.context.mockResolvedValue({ session: { user: { id: 'user_1', organizationId: 'org_1' } } });
  mocks.select.mockResolvedValue({ branchId: 'branch_1', name: 'Selected property' });
});

describe('extras catalog feedback and recovery', () => {
  it('keeps create confirmation while resetting every new-form value', async () => {
    render(<HotelExtrasCatalog selection={selection} initial={empty} />);
    fillCreate();
    fireEvent.submit(screen.getByRole('form', { name: 'Add a charge' }));
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'LAUNDRY',
        priceMinor: 45_000,
        upsellPriceMinor: 39_000,
        recurring: 'PER_STAY',
      })
    );
    await act(async () => {
      mocks.createHook.mock.lastCall![0].onSuccess({ extra });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Laundry service is now in the catalog.');
    for (const label of ['Code', 'Name', 'Name in Urdu', 'Tax class']) {
      expect(screen.getByLabelText(label)).toHaveValue('');
    }
    expect(screen.getByLabelText('Price (PKR)')).toHaveValue(null);
    expect(screen.getByLabelText('Offer price (PKR)')).toHaveValue(null);
    expect(screen.getByLabelText('Offer price (PKR)')).toBeDisabled();
    expect(screen.getByLabelText('Offer this before arrival')).not.toBeChecked();
    expect(screen.getByLabelText('Posting department')).toHaveValue('MISCELLANEOUS');
    expect(screen.getByLabelText('How often it is charged')).toHaveValue('NONE');
  });

  it('keeps edit confirmation when returning to the new-item form', async () => {
    render(<HotelExtrasCatalog selection={selection} initial={{ ...empty, extras: [extra] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Laundry and pressing' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Edit charge' }));
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'extra_1', name: 'Laundry and pressing' })
    );
    await act(async () => {
      mocks.updateHook.mock.lastCall![0].onSuccess({ extra });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    expect(screen.getByRole('form', { name: 'Add a charge' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('');
  });

  it.each(['create', 'update'] as const)(
    'preserves %s values and associates server field errors',
    async (operation) => {
      render(<HotelExtrasCatalog selection={selection} initial={{ ...empty, extras: [extra] }} />);
      if (operation === 'update') fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      else fillCreate();
      fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'TAKEN' } });
      fireEvent.submit(screen.getByRole('form'));
      await act(async () => {
        const hook = operation === 'create' ? mocks.createHook : mocks.updateHook;
        hook.mock.lastCall![0].onError({
          message: 'Check the code.',
          data: { validation: { code: ['Choose another code.'] } },
        });
      });
      expect(screen.getByLabelText('Code')).toHaveValue('TAKEN');
      expect(screen.getByLabelText('Name')).toHaveValue('Laundry service');
      expect(screen.getByLabelText('Offer price (PKR)')).toHaveValue(390);
      expect(screen.getByLabelText('Code')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText('Code')).toHaveAccessibleDescription('Choose another code.');
      expect(mocks.fetch).not.toHaveBeenCalled();
    }
  );

  it('reports refresh failure after a confirmed save and retries without saving twice', async () => {
    mocks.fetch
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ...empty, extras: [extra] });
    render(<HotelExtrasCatalog selection={selection} initial={empty} />);
    fillCreate();
    fireEvent.submit(screen.getByRole('form'));
    await act(async () => {
      mocks.createHook.mock.lastCall![0].onSuccess({ extra });
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh the catalog');
    expect(screen.getByRole('status')).toHaveTextContent('Laundry service is now in the catalog.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry refresh' }));
    await waitFor(() => expect(screen.getByText('Laundry service')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('Laundry service is now in the catalog.');
  });

  it('retains drafts and the requested filter across a failed refresh and retry', async () => {
    let finish: (view: CatalogView) => void = () => undefined;
    mocks.fetch.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(
      () =>
        new Promise<CatalogView>((resolve) => {
          finish = resolve;
        })
    );
    render(<HotelExtrasCatalog selection={selection} initial={{ ...empty, extras: [extra] }} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Airport transfer' } });
    fireEvent.click(screen.getByLabelText('Show retired items'));
    await screen.findByRole('alert');
    expect(screen.getByText('Laundry service')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry refresh' }));
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing catalog…');
    expect(screen.getByLabelText('Show retired items')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add to catalog' })).toBeDisabled();
    await act(async () => {
      finish({ ...empty, extras: [{ ...extra, active: false }] });
    });
    expect(mocks.fetch).toHaveBeenLastCalledWith({
      branchId: 'branch_1',
      includeInactive: true,
      upsellableOnly: false,
    });
    expect(screen.getByLabelText('Name')).toHaveValue('Airport transfer');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('disables conflicting actions while a mutation is pending', () => {
    mocks.createHook.mockReturnValue({ mutate: mocks.create, isPending: true });
    render(<HotelExtrasCatalog selection={selection} initial={{ ...empty, extras: [extra] }} />);
    for (const label of ['Saving…', 'Edit', 'Retire']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }
    expect(screen.getByLabelText('Code')).toBeDisabled();
    fireEvent.submit(screen.getByRole('form'));
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('extras page failure states', () => {
  it.each(['FORBIDDEN', 'UNAUTHORIZED'] as const)('explains %s access failure', async (code) => {
    mocks.list.mockRejectedValue(new TRPCError({ code }));
    render(await selectedPage());
    expect(
      screen.getByRole('heading', { name: 'You cannot manage this catalog' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Retry loading catalog' })).not.toBeInTheDocument();
  });

  it('explains missing provisioning separately from permission failure', async () => {
    mocks.list.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND' }));
    render(await selectedPage());
    expect(
      screen.getByRole('heading', { name: 'This workspace has no property yet' })
    ).toBeInTheDocument();
    expect(screen.getByText(/account manager to finish provisioning/)).toBeInTheDocument();
  });

  it('offers recovery for context NOT_FOUND without claiming missing property provisioning', async () => {
    mocks.context.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' })
    );
    render(await HotelExtrasSettingsPage());
    expect(
      screen.getByRole('heading', { name: 'Could not load the extras catalog' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Retry loading catalog' })).toHaveAttribute(
      'href',
      '/hotel/settings/extras'
    );
    expect(
      screen.queryByRole('heading', { name: 'This workspace has no property yet' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/account manager to finish provisioning/)).not.toBeInTheDocument();
    expect(screen.queryByText('Workspace not found.')).not.toBeInTheDocument();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each(['list', 'context'] as const)(
    'offers reload when %s fails without leaking internal errors',
    async (source) => {
      mocks[source].mockRejectedValue(new Error('private database connection details'));
      render(await (source === 'context' ? HotelExtrasSettingsPage() : selectedPage()));
      expect(
        screen.getByRole('heading', { name: 'Could not load the extras catalog' })
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Retry loading catalog' })).toHaveAttribute(
        'href',
        source === 'context' ? '/hotel/settings/extras' : '/hotel/settings/extras?branchId=branch_1'
      );
      expect(screen.queryByText(/private database/)).not.toBeInTheDocument();
    }
  );
});
