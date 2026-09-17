import { act, fireEvent, render, screen } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  context: vi.fn(),
  select: vi.fn(),
  properties: vi.fn(),
  get: vi.fn(),
  fetch: vi.fn(),
  update: vi.fn(),
  mode: vi.fn(),
  updateHook: vi.fn(),
  modeHook: vi.fn(),
}));
vi.mock('next-auth/react', () => ({ useSession: mocks.session }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/server/routers/hotel-property', () => ({
  hotelPropertyRouter: {
    createCaller: () => ({
      access: { select: mocks.select },
      extras: { properties: mocks.properties },
      get: mocks.get,
    }),
  },
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ hotelProperty: { get: { fetch: mocks.fetch } } }),
    hotelProperty: {
      update: { useMutation: mocks.updateHook },
      modes: { set: { useMutation: mocks.modeHook } },
    },
  },
}));

import Page from '@/app/(app)/hotel/settings/property/page';
import { HotelPropertySettingsForm } from './property-settings-form';

type View = Parameters<typeof HotelPropertySettingsForm>[0]['initial'];
const selection = { branchId: 'property_a', organizationId: 'org_a', userId: 'staff_a' };
const user = { id: selection.userId, organizationId: selection.organizationId };
const initial = {
  property: {
    branchId: selection.branchId,
    organizationId: selection.organizationId,
    name: 'Selected A',
    addressLine: '12 Main Boulevard',
    city: 'Lahore',
    timezone: 'Asia/Karachi',
    mode: 'HOTEL',
    modeOverrides: null,
    starCategory: 5,
    checkInTime: '14:00',
    checkOutTime: '12:00',
    auditTime: '03:00',
    currency: 'PKR',
    taxProfileId: 'tax_a',
    languages: ['en', 'ur'],
    overbookPolicy: {},
    bookingEngineSlug: 'selected-a',
    journeySettings: {},
    mealAllocationPolicy: {},
    businessDatePolicy: {},
    active: true,
    createdAt: new Date('2026-09-14T00:00:00Z'),
    updatedAt: new Date('2026-09-14T00:00:00Z'),
  },
  modeOptions: [
    { value: 'HOTEL', label: 'Hotel', description: 'Rooms by the night.' },
    { value: 'HOSTEL', label: 'Hostel', description: 'Beds sold individually.' },
  ],
  checklist: {
    organizationId: selection.organizationId,
    items: [],
    doneCount: 0,
    totalCount: 0,
    blocking: [],
    ready: false,
  },
  activationSummary: 'Setup for A',
} satisfies View;
const other = {
  ...initial,
  property: { ...initial.property, branchId: 'property_c', name: 'Selected C', mode: 'HOSTEL' },
  activationSummary: 'Setup for C',
} satisfies View;
const choices = {
  ...user,
  properties: [
    { branchId: 'property_a', name: 'Selected A' },
    { branchId: 'property_c', name: 'Selected C' },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function save() {
  fireEvent.submit(screen.getByRole('button', { name: 'Save property' }).closest('form')!);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockReturnValue({ data: { user } });
  mocks.context.mockResolvedValue({ session: { user } });
  mocks.properties.mockResolvedValue(choices);
  mocks.select.mockResolvedValue({ branchId: 'property_a', name: 'Selected A' });
  mocks.get.mockResolvedValue(initial);
  mocks.fetch.mockResolvedValue(initial);
  mocks.updateHook.mockReturnValue({ mutate: mocks.update, isPending: false });
  mocks.modeHook.mockReturnValue({ mutate: mocks.mode, isPending: false });
});

describe('Property settings explicit selection', () => {
  it.each([1, 2])('requires a choice even with %i available properties', async (count) => {
    mocks.properties.mockResolvedValue({
      ...choices,
      properties: choices.properties.slice(0, count),
    });
    render(await Page());
    expect(screen.getByLabelText('Property')).toHaveValue('');
    expect(
      screen.getByRole('button', { name: 'Open property settings' }).closest('form')
    ).toHaveAttribute('method', 'get');
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.mode).not.toHaveBeenCalled();
  });

  it.each([{ branchId: '   ' }, { branchId: ['property_a', 'property_c'] }])(
    'does not infer a branch from %j',
    async ({ branchId }) => {
      render(await Page({ searchParams: Promise.resolve({ branchId }) }));
      expect(screen.getByLabelText('Property')).toHaveValue('');
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.get).not.toHaveBeenCalled();
    }
  );

  it('explains unavailable assignments without loading a property', async () => {
    mocks.properties.mockResolvedValue({ ...choices, properties: [] });
    render(await Page());
    expect(screen.getByText(/No properties are available/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('authorizes the explicit choice before reading, then binds save, mode and both refreshes', async () => {
    render(await Page({ searchParams: Promise.resolve({ branchId: ' property_a ' }) }));
    expect(mocks.select).toHaveBeenCalledWith({
      branchId: 'property_a',
      capability: 'hotel:property-admin',
    });
    expect(mocks.get).toHaveBeenCalledWith({ branchId: 'property_a' });
    expect(mocks.select.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.get.mock.invocationCallOrder[0]
    );
    expect(mocks.properties).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.mode).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Change property' })).toHaveAttribute(
      'href',
      '/hotel/settings/property'
    );

    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'Edited A' } });
    fireEvent.change(screen.getByLabelText('Star category'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Tax profile'), { target: { value: '' } });
    save();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 'property_a',
        name: 'Edited A',
        starCategory: null,
        taxProfileId: null,
        languages: ['en', 'ur'],
      })
    );
    mocks.fetch.mockResolvedValue({
      ...initial,
      property: { ...initial.property, name: 'Edited A' },
      activationSummary: 'Refreshed A',
    });
    await act(async () =>
      mocks.updateHook.mock.lastCall![0].onSuccess({ activationSummary: 'Saved A' })
    );
    expect(mocks.fetch).toHaveBeenLastCalledWith({ branchId: 'property_a' }, { staleTime: 0 });
    expect(screen.getByText('Refreshed A')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /Hostel/ }));
    expect(mocks.mode).toHaveBeenCalledWith({ branchId: 'property_a', mode: 'HOSTEL' });
    mocks.fetch.mockResolvedValue({
      ...initial,
      property: { ...initial.property, mode: 'HOSTEL' },
    });
    await act(async () => mocks.modeHook.mock.lastCall![0].onSuccess({ mode: 'HOSTEL' }));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch).toHaveBeenLastCalledWith({ branchId: 'property_a' }, { staleTime: 0 });
    expect(screen.getByRole('radio', { name: /Hostel/ })).toBeChecked();
    expect(screen.getByLabelText('Property name')).toHaveValue('Edited A');
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND'] as const)(
    'refuses %s selections without falling back',
    async (code) => {
      mocks.select.mockRejectedValue(new TRPCError({ code, message: 'private access detail' }));
      render(await Page({ searchParams: Promise.resolve({ branchId: 'wrong_or_stale' }) }));
      expect(
        screen.getByRole('heading', { name: 'This page is not available to you' })
      ).toBeInTheDocument();
      expect(screen.queryByText('private access detail')).not.toBeInTheDocument();
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.properties).not.toHaveBeenCalled();
    }
  );

  it('hides a choice revoked between selection and property read', async () => {
    mocks.get.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    render(await Page({ searchParams: Promise.resolve({ branchId: 'property_a' }) }));
    expect(screen.getByRole('link', { name: 'Choose another property' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Property name')).not.toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('uses a safe retry link for the same choice after a load failure', async () => {
    mocks.get.mockRejectedValue(new Error('private detail'));
    render(await Page({ searchParams: Promise.resolve({ branchId: 'a/b&c' }) }));
    expect(screen.getByRole('link', { name: 'Retry loading settings' })).toHaveAttribute(
      'href',
      '/hotel/settings/property?branchId=a%2Fb%26c'
    );
    expect(screen.queryByText('private detail')).not.toBeInTheDocument();
  });

  it.each([{ branchId: 'property_c' }, { organizationId: 'org_b' }])(
    'hides mismatched initial data %j',
    (changed) => {
      render(
        <HotelPropertySettingsForm
          initial={{ ...initial, property: { ...initial.property, ...changed } }}
          selection={selection}
        />
      );
      expect(screen.getByRole('heading', { name: 'Choose a property again' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Property name')).not.toBeInTheDocument();
      expect(mocks.updateHook).not.toHaveBeenCalled();
    }
  );

  it('resets drafts and errors when selecting another property', () => {
    const view = render(<HotelPropertySettingsForm initial={initial} selection={selection} />);
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'Unsaved A' } });
    act(() =>
      mocks.updateHook.mock.lastCall![0].onError({ data: { validation: { name: ['Correct A'] } } })
    );
    view.rerender(
      <HotelPropertySettingsForm
        initial={other}
        selection={{ ...selection, branchId: 'property_c' }}
      />
    );
    expect(screen.getByLabelText('Property name')).toHaveValue('Selected C');
    expect(screen.queryByText('Correct A')).not.toBeInTheDocument();
    expect(screen.queryByText('Setup for A')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Hostel/ })).toBeChecked();
    save();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'property_c', name: 'Selected C' })
    );
  });

  it.each([null, { ...user, id: 'staff_b' }, { ...user, organizationId: 'org_b' }])(
    'hides old data and drafts when identity becomes %j',
    (nextUser) => {
      const view = render(<HotelPropertySettingsForm initial={initial} selection={selection} />);
      fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'Unsaved A' } });
      mocks.session.mockReturnValue({ data: nextUser ? { user: nextUser } : null });
      view.rerender(<HotelPropertySettingsForm initial={initial} selection={selection} />);
      expect(screen.queryByLabelText('Property name')).not.toBeInTheDocument();
      expect(screen.queryByText('Setup for A')).not.toBeInTheDocument();
      mocks.session.mockReturnValue({ data: { user } });
      view.rerender(<HotelPropertySettingsForm initial={initial} selection={selection} />);
      expect(screen.getByLabelText('Property name')).toHaveValue('Selected A');
      expect(mocks.update).not.toHaveBeenCalled();
    }
  );

  it('ignores old refresh results and mutation callbacks after changing properties', async () => {
    const pending = deferred<View>();
    mocks.fetch.mockReturnValue(pending.promise);
    const view = render(<HotelPropertySettingsForm initial={initial} selection={selection} />);
    const oldUpdate = mocks.updateHook.mock.lastCall![0];
    const oldMode = mocks.modeHook.mock.lastCall![0];
    await act(async () => oldUpdate.onSuccess({ activationSummary: 'Saved A' }));
    expect(screen.getByRole('button', { name: 'Save property' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Hostel/ })).toBeDisabled();
    view.rerender(
      <HotelPropertySettingsForm
        initial={other}
        selection={{ ...selection, branchId: 'property_c' }}
      />
    );
    await act(async () => {
      pending.resolve({ ...initial, activationSummary: 'Late A' });
      oldUpdate.onSuccess({ activationSummary: 'Late save A' });
      oldMode.onSuccess({ mode: 'HOTEL' });
      oldUpdate.onError({ data: { validation: { name: ['Late error A'] } } });
    });
    expect(screen.getByLabelText('Property name')).toHaveValue('Selected C');
    expect(screen.getByRole('radio', { name: /Hostel/ })).toBeChecked();
    expect(screen.queryByText(/Late/)).not.toBeInTheDocument();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('isolates an in-flight refresh from a new user selecting the same property', async () => {
    const pending = deferred<View>();
    mocks.fetch.mockReturnValue(pending.promise);
    const view = render(<HotelPropertySettingsForm initial={initial} selection={selection} />);
    await act(async () => mocks.modeHook.mock.lastCall![0].onSuccess({ mode: 'HOSTEL' }));
    mocks.session.mockReturnValue({ data: { user: { ...user, id: 'staff_b' } } });
    view.rerender(
      <HotelPropertySettingsForm
        initial={initial}
        selection={{ ...selection, userId: 'staff_b' }}
      />
    );
    await act(async () =>
      pending.resolve({
        ...initial,
        activationSummary: 'Old user result',
        property: { ...initial.property, mode: 'HOSTEL' },
      })
    );
    expect(screen.queryByText('Old user result')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('HOTEL')).toBeChecked();
  });

  it.each(['update', 'mode', 'refresh'] as const)(
    'hides property data after access is denied on %s',
    async (source) => {
      render(<HotelPropertySettingsForm initial={initial} selection={selection} />);
      const error = { message: 'private detail', data: { code: 'FORBIDDEN' } };
      if (source === 'refresh') {
        mocks.fetch.mockRejectedValue(error);
        await act(async () =>
          mocks.updateHook.mock.lastCall![0].onSuccess({ activationSummary: 'Saved' })
        );
      } else {
        act(() =>
          (source === 'update' ? mocks.updateHook : mocks.modeHook).mock.lastCall![0].onError(error)
        );
      }
      expect(screen.getByRole('heading', { name: 'Choose a property again' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Property name')).not.toBeInTheDocument();
      expect(screen.queryByText('private detail')).not.toBeInTheDocument();
    }
  );

  it('refuses a refresh for the wrong property', async () => {
    mocks.fetch.mockResolvedValue(other);
    render(<HotelPropertySettingsForm initial={initial} selection={selection} />);
    await act(async () => mocks.modeHook.mock.lastCall![0].onSuccess({ mode: 'HOSTEL' }));
    expect(screen.getByRole('heading', { name: 'Choose a property again' })).toBeInTheDocument();
    expect(screen.queryByText('Selected C')).not.toBeInTheDocument();
  });

  it('preserves drafts on validation and refresh errors, then retries the same branch', async () => {
    render(<HotelPropertySettingsForm initial={initial} selection={selection} />);
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'Draft A' } });
    act(() =>
      mocks.updateHook.mock.lastCall![0].onError({
        data: { validation: { name: ['Use a longer name'] } },
      })
    );
    expect(screen.getByText('Use a longer name')).toBeInTheDocument();
    expect(screen.getByLabelText('Property name')).toHaveValue('Draft A');
    mocks.fetch.mockRejectedValueOnce(new Error('private refresh detail'));
    await act(async () =>
      mocks.updateHook.mock.lastCall![0].onSuccess({ activationSummary: 'Saved A' })
    );
    expect(screen.getByText(/Could not refresh property settings/)).toBeInTheDocument();
    expect(screen.queryByText('private refresh detail')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Property name')).toHaveValue('Draft A');
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Refresh property settings' }))
    );
    expect(mocks.fetch).toHaveBeenLastCalledWith({ branchId: 'property_a' }, { staleTime: 0 });
    expect(screen.queryByText(/Could not refresh property settings/)).not.toBeInTheDocument();
  });
});
