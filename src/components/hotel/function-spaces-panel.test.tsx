import { selectFieldControl } from '@/lib/testing/select-field';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HotelFunctionSpacesPanel,
  formatSpan,
  parseLayouts,
  rupees,
  zonedInputToDate,
  type HotelFunctionSpacesView,
} from './function-spaces-panel';

type Callbacks = {
  onSuccess?: (result: unknown, input: unknown) => void;
  onError?: (error: { message: string; data: { code: string; validation?: unknown } }) => void;
};
const h = vi.hoisted(() => ({
  mutate: {} as Record<string, ReturnType<typeof vi.fn>>,
  hookCallbacks: {} as Record<string, Callbacks>,
  fetchList: vi.fn(),
  session: { user: { id: 'user', organizationId: 'org' } },
}));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: h.session }) }));
vi.mock('@/lib/trpc', () => {
  const mutation = (name: string) => ({
    useMutation: (options?: Callbacks) => {
      h.hookCallbacks[name] = options ?? {};
      h.mutate[name] ??= vi.fn();
      return { mutate: h.mutate[name], isPending: false };
    },
  });
  return {
    trpc: {
      useUtils: () => ({ hotelProperty: { spaces: { list: { fetch: h.fetchList } } } }),
      hotelProperty: {
        spaces: {
          create: mutation('create'),
          update: mutation('update'),
          setActive: mutation('setActive'),
          bookings: { hold: mutation('hold'), release: mutation('release') },
        },
      },
    },
  };
});

const selection = { userId: 'user', organizationId: 'org', branchId: 'branch' };
const version = new Date('2026-10-01T08:30:00.000Z');
const crystal = {
  id: 'space_crystal',
  branchId: 'branch',
  name: 'Crystal Hall',
  nameUr: 'کرسٹل ہال',
  layouts: [
    { layout: 'Theatre', capacity: 300 },
    { layout: 'Banquet', capacity: 220 },
  ],
  pricing: { hourlyMinor: 4_500_000, perFunctionMinor: 25_000_000 },
  setupMinutes: 90,
  teardownMinutes: 60,
  active: true,
  updatedAt: version,
  maxCapacity: 300,
};
const lawn = {
  ...crystal,
  id: 'space_lawn',
  name: 'Rose Lawn',
  nameUr: null,
  layouts: [{ layout: 'Banquet', capacity: 500 }],
  pricing: {},
  setupMinutes: 0,
  teardownMinutes: 0,
  active: false,
  maxCapacity: 500,
};
const walima = {
  id: 'booking_walima',
  spaceId: 'space_crystal',
  kind: 'FUNCTION',
  startsAt: new Date('2026-10-01T14:00:00.000Z'),
  endsAt: new Date('2026-10-01T18:00:00.000Z'),
  label: 'Khan walima',
  createdBy: 'user',
  createdAt: version,
};
const mehndi = {
  ...walima,
  id: 'booking_mehndi',
  kind: 'HOLD',
  startsAt: new Date('2026-10-02T13:00:00.000Z'),
  endsAt: new Date('2026-10-02T17:00:00.000Z'),
  label: 'Khan mehndi — tentative',
};
function view(overrides: Partial<HotelFunctionSpacesView> = {}): HotelFunctionSpacesView {
  return {
    branchId: 'branch',
    timezone: 'Asia/Karachi',
    enabled: true,
    spaces: [crystal, lawn],
    bookings: [walima, mehndi],
    kindOptions: [
      { value: 'HOLD', label: 'Tentative hold' },
      { value: 'FUNCTION', label: 'Confirmed function' },
    ],
    ...overrides,
  } as unknown as HotelFunctionSpacesView;
}
const error = (code: string, validation?: Record<string, string[]>) => ({
  message: 'Refused',
  data: { code, validation },
});
const lastCallbacks = (name: string) => h.mutate[name].mock.lastCall?.[1] as Callbacks;

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(h.mutate)) fn.mockReset();
  h.session = { user: { id: 'user', organizationId: 'org' } };
  h.fetchList.mockResolvedValue(view());
});
afterEach(cleanup);
const mount = (initial = view()) =>
  render(<HotelFunctionSpacesPanel initial={initial} selection={selection} />);
const addForm = () => screen.getByRole('form', { name: 'Add a function space' });
const spacesCard = () =>
  screen
    .getByRole('heading', { level: 2, name: /^Function spaces \(/ })
    .closest<HTMLElement>('[data-slot="section-card"]')!;

describe('helpers', () => {
  it('reads layouts from one line, shows paisa as rupees, and keeps the property’s clock', () => {
    expect(parseLayouts('Theatre 300, Banquet: 220, Lawn')).toEqual([
      { layout: 'Theatre', capacity: 300 },
      { layout: 'Banquet', capacity: 220 },
      { layout: 'Lawn', capacity: 0 },
    ]);
    expect(rupees(4_500_000)).toBe('PKR 45,000.00');
    expect(rupees(undefined)).toBeNull();
    // 19:00 in Karachi (UTC+5) is 14:00Z, whatever the machine's zone.
    expect(zonedInputToDate('2026-10-01T19:00', 'Asia/Karachi')?.toISOString()).toBe(
      '2026-10-01T14:00:00.000Z'
    );
    expect(zonedInputToDate('2026-10-01T09:30', 'America/Halifax')?.toISOString()).toBe(
      '2026-10-01T12:30:00.000Z'
    );
    expect(zonedInputToDate('not a time', 'Asia/Karachi')).toBeNull();
    expect(formatSpan(walima.startsAt, walima.endsAt, 'Asia/Karachi')).toBe(
      'Thu, 1 Oct 2026, 19:00 – 23:00'
    );
    expect(formatSpan(walima.startsAt, new Date('2026-10-02T02:00:00.000Z'), 'Asia/Karachi')).toBe(
      'Thu, 1 Oct 2026, 19:00 → Fri, 2 Oct 2026, 07:00'
    );
  });
});

describe('HotelFunctionSpacesPanel', () => {
  it('names layouts, buffers, prices, kinds and times for an operator in the property’s zone', () => {
    mount();
    const card = spacesCard();
    expect(within(card).getByText(/1 active · 2 upcoming claims/)).toBeInTheDocument();
    expect(within(card).getByText('Theatre 300 · Banquet 220')).toBeInTheDocument();
    expect(within(card).getByText('90 min before · 60 min after')).toBeInTheDocument();
    expect(within(card).getByText('PKR 45,000.00 hourly')).toBeInTheDocument();
    expect(within(card).getByText('PKR 250,000.00 per function')).toBeInTheDocument();
    expect(within(card).getByText('No price yet')).toBeInTheDocument();
    expect(within(card).getByText('Up to 300 guests')).toBeInTheDocument();
    expect(within(card).getByText('کرسٹل ہال')).toBeInTheDocument();
    const diary = within(card).getByRole('list', { name: 'Diary of Crystal Hall' });
    expect(within(diary).getByText('Confirmed function')).toBeInTheDocument();
    expect(within(diary).getByText('Tentative hold')).toBeInTheDocument();
    expect(within(diary).getByText('Thu, 1 Oct 2026, 19:00 – 23:00')).toBeInTheDocument();
    expect(
      within(diary).getByRole('button', { name: /Release the hold Khan mehndi/ })
    ).toBeEnabled();
    expect(
      within(diary).queryByRole('button', { name: /Release the hold Khan walima/ })
    ).toBeNull();
    expect(within(card).getByText('Nothing booked ahead in Rose Lawn.')).toBeInTheDocument();
    expect(within(card).getByText('Retired')).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/HOLD|FUNCTION|space_crystal|booking_walima|Minor/);
  });

  it('adds a space from one layouts line and rupee prices, in minor units, with the selection attached', () => {
    mount();
    const form = addForm();
    fireEvent.change(selectFieldControl(within(form).getByLabelText('Space name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Pearl Room' },
    });
    fireEvent.change(selectFieldControl(within(form).getByLabelText('Layouts and capacities', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Boardroom 24, Classroom 40' },
    });
    fireEvent.change(selectFieldControl(within(form).getByLabelText('Setup (min)', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '30' } });
    fireEvent.change(selectFieldControl(within(form).getByLabelText('Teardown (min)', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '15' } });
    fireEvent.change(selectFieldControl(within(form).getByLabelText('Hourly rate', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '12000.50' } });
    fireEvent.change(selectFieldControl(within(form).getByLabelText('Minimum spend', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '100000' } });
    fireEvent.submit(form);
    expect(h.mutate.create).toHaveBeenCalledWith({
      branchId: 'branch',
      name: 'Pearl Room',
      nameUr: null,
      layouts: [
        { layout: 'Boardroom', capacity: 24 },
        { layout: 'Classroom', capacity: 40 },
      ],
      pricing: {
        hourlyMinor: 1_200_050,
        dailyMinor: undefined,
        perFunctionMinor: undefined,
        minimumSpendMinor: 10_000_000,
      },
      setupMinutes: 30,
      teardownMinutes: 15,
    });
  });

  it('lands server field errors under their inputs and announces a save', async () => {
    mount();
    const form = addForm();
    fireEvent.change(selectFieldControl(within(form).getByLabelText('Space name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Crystal Hall' },
    });
    fireEvent.change(selectFieldControl(within(form).getByLabelText('Layouts and capacities', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Theatre 300' },
    });
    fireEvent.submit(form);
    act(() => {
      h.hookCallbacks.create!.onError!(
        error('BAD_REQUEST', {
          name: ['This property already has a function space called “Crystal Hall”.'],
        })
      );
    });
    const name = within(form).getByLabelText('Space name', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(selectFieldControl(name)).toHaveValue('Crystal Hall');
    expect(within(form).getByRole('alert')).toHaveTextContent('already has a function space');
    act(() => {
      h.hookCallbacks.create!.onError!(
        error('BAD_REQUEST', {
          layouts: ['A function space needs at least one layout and its capacity.'],
        })
      );
    });
    expect(within(form).getByLabelText('Layouts and capacities', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    await act(async () => {
      h.hookCallbacks.create!.onSuccess!({ space: { ...crystal, name: 'Pearl Room' } }, undefined);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Pearl Room is now a function space.');
    expect(selectFieldControl(within(addForm()).getByLabelText('Space name', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('');
    expect(h.fetchList).toHaveBeenCalledWith({ branchId: 'branch' }, { staleTime: 0 });
  });

  it('books a space in the property’s zone with the kind named, and refuses a busy hall on the start field', async () => {
    mount();
    const book = screen.getByRole('button', { name: 'Book Crystal Hall' });
    fireEvent.click(book);
    expect(book).toHaveAttribute('aria-expanded', 'true');
    const form = screen.getByRole('form', { name: 'Book Crystal Hall' });
    expect(within(form).getByLabelText('What for', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveFocus();
    expect(within(form).getByText(/90 minutes before and 60 after/)).toBeInTheDocument();
    fireEvent.change(selectFieldControl(within(form).getByLabelText('What for', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Board meeting' },
    });
    fireEvent.change(selectFieldControl(within(form).getByLabelText('Claim', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'FUNCTION' } });
    fireEvent.change(selectFieldControl(within(form).getByLabelText('From', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: '2026-10-03T19:00' },
    });
    fireEvent.change(selectFieldControl(within(form).getByLabelText('Until', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: '2026-10-03T23:00' },
    });
    fireEvent.submit(form);
    expect(h.mutate.hold).toHaveBeenCalledWith(
      {
        branchId: 'branch',
        spaceId: 'space_crystal',
        label: 'Board meeting',
        kind: 'FUNCTION',
        startsAt: new Date('2026-10-03T14:00:00.000Z'),
        endsAt: new Date('2026-10-03T18:00:00.000Z'),
      },
      expect.anything()
    );
    act(() => {
      lastCallbacks('hold').onError!(
        error('BAD_REQUEST', {
          startsAt: [
            'Crystal Hall is already booked for this time. Including setup and teardown it is next free at 1 Oct 2026, 00:00.',
          ],
        })
      );
    });
    expect(within(form).getByLabelText('From', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByRole('alert')).toHaveTextContent('next free at');
    expect(selectFieldControl(within(form).getByLabelText('What for', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('Board meeting');
    await act(async () => {
      lastCallbacks('hold').onSuccess!({ booking: walima }, undefined);
    });
    expect(screen.queryByRole('form', { name: 'Book Crystal Hall' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Crystal Hall is booked: Board meeting.');
    expect(screen.getByRole('button', { name: 'Book Crystal Hall' })).toHaveFocus();
  });

  it('refuses an unreadable or inverted span locally before any call', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Book Crystal Hall' }));
    const form = screen.getByRole('form', { name: 'Book Crystal Hall' });
    fireEvent.change(selectFieldControl(within(form).getByLabelText('What for', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'Late night' } });
    fireEvent.change(selectFieldControl(within(form).getByLabelText('From', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: '2026-10-03T23:00' },
    });
    fireEvent.change(selectFieldControl(within(form).getByLabelText('Until', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: '2026-10-03T19:00' },
    });
    fireEvent.submit(form);
    expect(h.mutate.hold).not.toHaveBeenCalled();
    expect(within(form).getByLabelText('Until', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByRole('alert')).toHaveTextContent('ends after it starts');
  });

  it('edits a space inline with its version, closes with Escape and hands focus back', () => {
    mount();
    const edit = screen.getByRole('button', { name: 'Edit Crystal Hall' });
    fireEvent.click(edit);
    const form = screen.getByRole('form', { name: 'Edit Crystal Hall' });
    expect(within(form).getByLabelText('Space name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveFocus();
    expect(selectFieldControl(within(form).getByLabelText('Layouts and capacities', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue(
      'Theatre 300, Banquet 220'
    );
    expect(selectFieldControl(within(form).getByLabelText('Hourly rate', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue(45000);
    expect(within(addForm()).getByRole('button', { name: 'Add space' })).toBeDisabled();
    fireEvent.change(selectFieldControl(within(form).getByLabelText('Setup (min)', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '120' } });
    fireEvent.submit(form);
    expect(h.mutate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 'branch',
        id: 'space_crystal',
        expectedUpdatedAt: version,
        active: true,
        name: 'Crystal Hall',
        setupMinutes: 120,
        teardownMinutes: 60,
        layouts: crystal.layouts,
      }),
      expect.anything()
    );
    act(() => {
      lastCallbacks('update').onError!(
        error('BAD_REQUEST', {
          setupMinutes: [
            'Those setup and teardown times would overlap bookings this space already has.',
          ],
        })
      );
    });
    expect(within(form).getByLabelText('Setup (min)', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveAttribute('aria-invalid', 'true');
    expect(selectFieldControl(within(form).getByLabelText('Setup (min)', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue(120);
    fireEvent.keyDown(form, { key: 'Escape' });
    expect(screen.queryByRole('form', { name: 'Edit Crystal Hall' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Crystal Hall' })).toHaveFocus();
  });

  it('retires and restores a space with its version, and releases a hold', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Retire Crystal Hall' }));
    expect(h.mutate.setActive).toHaveBeenCalledWith(
      { branchId: 'branch', spaceId: 'space_crystal', active: false, expectedUpdatedAt: version },
      expect.anything()
    );
    await act(async () => {
      lastCallbacks('setActive').onSuccess!({ id: 'space_crystal', active: false }, undefined);
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Crystal Hall is retired. Its bookings are kept.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restore Rose Lawn' }));
    expect(h.mutate.setActive).toHaveBeenLastCalledWith(
      { branchId: 'branch', spaceId: 'space_lawn', active: true, expectedUpdatedAt: version },
      expect.anything()
    );
    // A retired space cannot be booked until it is back.
    expect(screen.getByRole('button', { name: 'Book Rose Lawn' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Release the hold Khan mehndi/ }));
    expect(h.mutate.release).toHaveBeenCalledWith(
      { branchId: 'branch', bookingId: 'booking_mehndi' },
      expect.anything()
    );
    act(() => {
      lastCallbacks('release').onError!(error('NOT_FOUND'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Refused');
  });

  it('takes no focus when it mounts', () => {
    mount();
    expect(document.activeElement).toBe(document.body);
  });

  it('explains a property that cannot sell function space and offers reading only', () => {
    mount(view({ enabled: false }));
    expect(
      screen.getByRole('heading', { name: 'This property does not sell function space yet' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open how the property operates' })).toHaveAttribute(
      'href',
      '/hotel/settings/property?branchId=branch'
    );
    expect(screen.queryByRole('form', { name: 'Add a function space' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Book Crystal Hall' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Release the hold/ })).not.toBeInTheDocument();
    expect(within(spacesCard()).getByText('Crystal Hall')).toBeInTheDocument();
  });

  it('refresh bypasses a cached list and rechecks revoked access', async () => {
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh spaces' }));
    });
    expect(h.fetchList).toHaveBeenCalledWith({ branchId: 'branch' }, { staleTime: 0 });
    h.fetchList.mockRejectedValueOnce(error('FORBIDDEN'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh spaces' }));
    });
    expect(screen.getByRole('heading', { name: 'Choose a property again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a property' })).toHaveAttribute(
      'href',
      '/hotel/settings/spaces'
    );
  });

  it('reloads on an identity change and explains an empty list with the next action', () => {
    h.session = { user: { id: 'someone-else', organizationId: 'org' } };
    mount();
    expect(screen.getByRole('heading', { name: 'Reload the function spaces' })).toBeInTheDocument();
    cleanup();
    h.session = { user: { id: 'user', organizationId: 'org' } };
    mount(view({ spaces: [], bookings: [] }));
    expect(screen.getByText(/No function spaces yet/)).toBeInTheDocument();
    expect(addForm()).toBeInTheDocument();
  });
});
