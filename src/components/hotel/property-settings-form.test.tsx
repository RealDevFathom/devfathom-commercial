import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HotelPropertySettingsForm } from './property-settings-form';
type Callbacks = {
  onSuccess: (result: { activationSummary: string }) => void;
  onError: (error: unknown) => void;
};
const h = vi.hoisted(() => ({
  update: vi.fn(),
  mode: vi.fn(),
  fetch: vi.fn(),
  callbacks: {} as Record<string, Callbacks>,
  session: { user: { id: 'user', organizationId: 'org' } },
}));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: h.session }) }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ hotelProperty: { get: { fetch: h.fetch } } }),
    hotelProperty: {
      update: {
        useMutation: (options: Callbacks) => {
          h.callbacks.update = options;
          return { mutate: h.update, isPending: false };
        },
      },
      modes: {
        set: {
          useMutation: (options: Callbacks) => {
            h.callbacks.mode = options;
            return { mutate: h.mode, isPending: false };
          },
        },
      },
    },
  },
}));
const selection = { userId: 'user', organizationId: 'org', branchId: 'branch' };
function view(version = '2026-09-01T00:00:00.000Z', name = 'Original hotel') {
  return {
    property: {
      organizationId: 'org',
      branchId: 'branch',
      updatedAt: new Date(version),
      name,
      addressLine: 'Main road',
      city: 'Karachi',
      timezone: 'Asia/Karachi',
      starCategory: null,
      currency: 'PKR',
      checkInTime: '14:00',
      checkOutTime: '12:00',
      auditTime: '03:00',
      taxProfileId: null,
      languages: ['en'],
      bookingEngineSlug: 'hotel',
      mode: 'HOTEL',
    },
    activationSummary: 'Room types still needed',
    checklist: { items: [] },
    modeOptions: [
      { value: 'HOTEL', label: 'Hotel', description: 'Overnight stays' },
      { value: 'HOSTEL', label: 'Hostel', description: 'Shared stays' },
    ],
  } as unknown as Parameters<typeof HotelPropertySettingsForm>[0]['initial'];
}
const error = (code: string) => ({ data: { code } });
beforeEach(() => {
  vi.clearAllMocks();
  h.session = { user: { id: 'user', organizationId: 'org' } };
  h.fetch.mockResolvedValue(view('2026-09-02T00:00:00.000Z', 'New server name'));
});
afterEach(cleanup);
function mount() {
  return render(<HotelPropertySettingsForm initial={view()} selection={selection} />);
}
function save() {
  fireEvent.submit(screen.getByRole('form', { name: 'Property facts' }));
}
describe('Hotel facts and mode snapshot safety', () => {
  it('sends the displayed facts version and omits unedited policies', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'Draft' } });
    save();
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 'branch',
        name: 'Draft',
        expectedUpdatedAt: view().property.updatedAt,
      })
    );
    expect(h.update.mock.calls[0][0]).not.toHaveProperty('policies');
  });
  it('keeps draft values and original revision on conflict, without automatic retry', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'Draft' } });
    save();
    act(() => h.callbacks.update.onError(error('CONFLICT')));
    expect(screen.getByLabelText('Property name')).toHaveValue('Draft');
    expect(h.fetch).not.toHaveBeenCalled();
    save();
    expect(h.update.mock.lastCall?.[0].expectedUpdatedAt).toEqual(view().property.updatedAt);
    expect(screen.getByRole('alert')).toHaveTextContent('Your edits are kept');
  });
  it('mode save preserves a dirty facts draft and never supplies empty overrides', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'Draft' } });
    fireEvent.click(screen.getByRole('radio', { name: /Hostel/ }));
    expect(h.mode).toHaveBeenCalledWith({
      branchId: 'branch',
      mode: 'HOSTEL',
      expectedUpdatedAt: view().property.updatedAt,
    });
    await act(async () => h.callbacks.mode.onSuccess({ activationSummary: 'Saved' }));
    expect(screen.getByLabelText('Property name')).toHaveValue('Draft');
    save();
    expect(h.update.mock.lastCall?.[0].expectedUpdatedAt).toEqual(view().property.updatedAt);
  });
  it('only explicit reload advances facts values and version together', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'Draft' } });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Reload and discard edits' }))
    );
    expect(screen.getByLabelText('Property name')).toHaveValue('New server name');
    save();
    expect(h.update.mock.lastCall?.[0].expectedUpdatedAt).toEqual(
      new Date('2026-09-02T00:00:00.000Z')
    );
  });
  it('own successful save reloads values and version together', async () => {
    mount();
    await act(async () => h.callbacks.update.onSuccess({ activationSummary: 'Saved' }));
    expect(screen.getByLabelText('Property name')).toHaveValue('New server name');
    save();
    expect(h.update.mock.lastCall?.[0].expectedUpdatedAt).toEqual(
      new Date('2026-09-02T00:00:00.000Z')
    );
  });
  it('connects server validation to input accessibility', () => {
    mount();
    act(() => h.callbacks.update.onError({ data: { validation: { name: ['Name needed'] } } }));
    expect(screen.getByLabelText('Property name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Property name')).toHaveAttribute(
      'aria-describedby',
      'name-error'
    );
  });
  it('hides forms after fresh access denial', async () => {
    mount();
    h.fetch.mockRejectedValueOnce(error('FORBIDDEN'));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Reload and discard edits' }))
    );
    expect(screen.queryByLabelText('Property name')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a property' })).toHaveAttribute(
      'href',
      '/hotel/settings/property'
    );
  });
  it('hides forms on identity change and ignores a late old-selection response', async () => {
    let finish!: (result: ReturnType<typeof view>) => void;
    h.fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const mounted = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Reload and discard edits' }));
    h.session = { user: { id: 'other', organizationId: 'org' } };
    mounted.rerender(<HotelPropertySettingsForm initial={view()} selection={selection} />);
    await act(async () => finish(view('2026-09-02T00:00:00.000Z', 'Stale response')));
    expect(screen.queryByLabelText('Property name')).not.toBeInTheDocument();
    expect(screen.queryByText('Stale response')).not.toBeInTheDocument();
  });
});
