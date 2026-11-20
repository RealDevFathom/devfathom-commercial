import { selectFieldControl } from '@/lib/testing/select-field';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HotelExtrasCatalog } from './extras-catalog';
type Callbacks = {
  onSuccess: (result: { extra: { name: string }; active: boolean }) => void;
  onError: (error: { message: string; data: { code: string } }) => void;
};
const h = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  active: vi.fn(),
  fetch: vi.fn(),
  callbacks: {} as Record<string, Callbacks>,
  session: { user: { id: 'user', organizationId: 'org' } },
}));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: h.session }) }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ hotelProperty: { extras: { list: { fetch: h.fetch } } } }),
    hotelProperty: {
      extras: Object.fromEntries(
        ['create', 'update', 'setActive'].map((name) => [
          name,
          {
            useMutation: (options: Callbacks) => {
              h.callbacks[name] = options;
              return {
                mutate: name === 'create' ? h.create : name === 'update' ? h.update : h.active,
                isPending: false,
              };
            },
          },
        ])
      ),
    },
  },
}));
const selection = { userId: 'user', organizationId: 'org', branchId: 'branch' };
function view(name = 'Laundry', version = '2026-09-01T00:00:00.000Z') {
  return {
    extras: [
      {
        id: 'extra',
        organizationId: 'org',
        branchId: 'branch',
        updatedAt: new Date(version),
        name,
        code: 'LAUNDRY',
        nameUr: null,
        priceMinor: 10000,
        taxClass: 'SERVICE',
        department: 'MISCELLANEOUS',
        upsellable: false,
        upsellPriceMinor: null,
        recurring: 'NONE',
        active: true,
      },
    ],
    departmentOptions: [{ value: 'MISCELLANEOUS', label: 'Miscellaneous' }],
    recurrenceOptions: [{ value: 'NONE', label: 'Once', description: 'One charge' }],
  } as unknown as Parameters<typeof HotelExtrasCatalog>[0]['initial'];
}
const error = (code: string) => ({ message: 'Save failed', data: { code } });
beforeEach(() => {
  vi.clearAllMocks();
  h.session = { user: { id: 'user', organizationId: 'org' } };
  h.fetch.mockResolvedValue(view('Latest laundry', '2026-09-02T00:00:00.000Z'));
});
afterEach(cleanup);
const mount = () => render(<HotelExtrasCatalog initial={view()} selection={selection} />);
const edit = () => fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
const save = () => fireEvent.submit(screen.getByRole('form', { name: 'Edit charge' }));
describe('Hotel extras draft and access safety', () => {
  it('keeps the edited snapshot across list refreshes', async () => {
    mount();
    edit();
    fireEvent.change(selectFieldControl(screen.getByLabelText('Name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'My draft' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog' })));
    save();
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'My draft', expectedUpdatedAt: view().extras[0].updatedAt })
    );
    expect(h.update.mock.lastCall?.[0]).not.toHaveProperty('postingRule');
  });
  it('preserves conflicts without an automatic retry or clearing the draft', () => {
    mount();
    edit();
    fireEvent.change(selectFieldControl(screen.getByLabelText('Name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'Draft' } });
    save();
    act(() => h.callbacks.update.onError(error('CONFLICT')));
    expect(selectFieldControl(screen.getByLabelText('Name', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('Draft');
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Your edits are kept');
  });
  it('retirement sends the clicked row revision', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    expect(h.active).toHaveBeenCalledWith({
      branchId: 'branch',
      id: 'extra',
      active: false,
      expectedUpdatedAt: view().extras[0].updatedAt,
    });
  });
  it.each(['FORBIDDEN', 'UNAUTHORIZED'])('hides stale rows/editor after %s', (code) => {
    mount();
    edit();
    act(() => h.callbacks.update.onError(error(code)));
    expect(screen.queryByLabelText('Name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toBeInTheDocument();
    expect(screen.queryByText('Laundry')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a property' })).toHaveAttribute(
      'href',
      '/hotel/settings/extras'
    );
  });
  it('distinguishes missing charge from missing property', async () => {
    mount();
    edit();
    act(() => h.callbacks.update.onError(error('NOT_FOUND')));
    expect(screen.getByLabelText('Name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('charge is no longer available');
    h.fetch.mockRejectedValueOnce(error('NOT_FOUND'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog' })));
    expect(screen.queryByLabelText('Name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a property' })).toBeInTheDocument();
  });
  it('cancel resets the draft while success starts a fresh add form', async () => {
    mount();
    edit();
    fireEvent.change(selectFieldControl(screen.getByLabelText('Name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'Discard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(selectFieldControl(screen.getByLabelText('Name', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('');
    edit();
    await act(async () =>
      h.callbacks.update.onSuccess({ extra: { name: 'Laundry' }, active: true })
    );
    expect(screen.getByRole('form', { name: 'Add a charge' })).toBeInTheDocument();
    expect(selectFieldControl(screen.getByLabelText('Name', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('');
  });
  it('refresh bypasses a still-fresh cached catalog and rechecks revoked access', async () => {
    mount();
    h.fetch.mockImplementationOnce(async (_input, options) => {
      if (options?.staleTime === 0) throw error('FORBIDDEN');
      return view('Cached laundry');
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog' })));
    expect(h.fetch).toHaveBeenCalledWith(
      { branchId: 'branch', includeInactive: false, upsellableOnly: false },
      { staleTime: 0 }
    );
    expect(screen.queryByLabelText('Name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a property' })).toBeInTheDocument();
  });
  it('ignores a late response after the selection identity changes', async () => {
    let finish!: (result: ReturnType<typeof view>) => void;
    h.fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const mounted = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog' }));
    h.session = { user: { id: 'other', organizationId: 'org' } };
    mounted.rerender(<HotelExtrasCatalog initial={view()} selection={selection} />);
    await act(async () => finish(view('Old-selection response')));
    expect(screen.queryByText('Old-selection response')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toBeInTheDocument();
  });
});
