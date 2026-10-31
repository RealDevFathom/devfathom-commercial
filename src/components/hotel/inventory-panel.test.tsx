import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HotelInventoryPanel, type HotelInventoryView } from './inventory-panel';

type Callbacks = {
  onSuccess?: (result: unknown, input: unknown) => void;
  onError?: (error: { message: string; data: { code: string; validation?: unknown } }) => void;
};
const h = vi.hoisted(() => ({
  mutate: {} as Record<string, ReturnType<typeof vi.fn>>,
  hookCallbacks: {} as Record<string, Callbacks>,
  fetchRoomTypes: vi.fn(),
  fetchRooms: vi.fn(),
  fetchHistory: vi.fn(),
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
      useUtils: () => ({
        hotelProperty: {
          inventory: {
            roomTypes: { list: { fetch: h.fetchRoomTypes } },
            rooms: { list: { fetch: h.fetchRooms }, history: { fetch: h.fetchHistory } },
          },
        },
      }),
      hotelProperty: {
        inventory: {
          roomTypes: { create: mutation('createType') },
          rooms: { create: mutation('createRoom'), setStatus: mutation('roomStatus') },
          beds: { setStatus: mutation('bedStatus') },
          blocks: { create: mutation('createBlock'), release: mutation('releaseBlock') },
        },
      },
    },
  };
});

const selection = { userId: 'user', organizationId: 'org', branchId: 'branch' };
const when = new Date('2026-10-01T08:30:00.000Z');
const standard = {
  id: 'type_std',
  organizationId: 'org',
  branchId: 'branch',
  code: 'STD',
  name: 'Standard',
  nameUr: 'اسٹینڈرڈ',
  inventoryKind: 'ROOM',
  bedsPerRoom: null,
  description: null,
  baseAdults: 2,
  maxAdults: 2,
  maxChildren: 1,
  bedConfig: '1 king',
  amenities: [],
  images: [],
  upgradeRank: 0,
  sort: 0,
  active: true,
  createdAt: when,
  updatedAt: when,
  _count: { rooms: 1 },
};
const dorm = {
  ...standard,
  id: 'type_dorm',
  code: 'DORM',
  name: 'Dormitory',
  nameUr: null,
  inventoryKind: 'BED',
  bedsPerRoom: 2,
  bedConfig: null,
  _count: { rooms: 1 },
};
const bed = (id: string, label: string, status = 'VACANT_DIRTY') => ({
  id,
  organizationId: 'org',
  branchId: 'branch',
  roomId: 'room_201',
  roomInventoryKind: 'BED',
  label,
  status,
  statusChangedAt: when,
  statusChangedBy: 'user',
  active: true,
  createdAt: when,
  updatedAt: when,
});
const room101 = {
  id: 'room_101',
  organizationId: 'org',
  branchId: 'branch',
  roomTypeId: 'type_std',
  inventoryKind: 'ROOM',
  number: '101',
  floor: '1',
  features: [],
  connectingRoomId: null,
  genderPolicy: 'ANY',
  status: 'VACANT_DIRTY',
  statusChangedAt: when,
  statusChangedBy: 'user',
  active: true,
  createdAt: when,
  updatedAt: when,
  roomType: {
    id: 'type_std',
    code: 'STD',
    name: 'Standard',
    inventoryKind: 'ROOM',
    bedsPerRoom: null,
  },
  connectingRoom: null,
  beds: [],
  blocks: [],
};
const room201 = {
  ...room101,
  id: 'room_201',
  roomTypeId: 'type_dorm',
  inventoryKind: 'BED',
  number: '201',
  floor: null,
  status: 'VACANT_CLEAN',
  roomType: {
    id: 'type_dorm',
    code: 'DORM',
    name: 'Dormitory',
    inventoryKind: 'BED',
    bedsPerRoom: 2,
  },
  connectingRoom: { id: 'room_101', number: '101' },
  beds: [bed('bed_1', '1', 'VACANT_CLEAN'), bed('bed_2', '2')],
  blocks: [
    {
      id: 'block_1',
      organizationId: 'org',
      branchId: 'branch',
      roomId: 'room_201',
      kind: 'OUT_OF_ORDER',
      startDate: new Date('2026-10-10T00:00:00.000Z'),
      endDate: new Date('2026-10-12T00:00:00.000Z'),
      reason: 'Leak',
      workOrderRef: null,
      createdBy: 'user',
      createdAt: when,
      releasedAt: null,
      releasedBy: null,
      releaseReason: null,
    },
  ],
};
function view(
  overrides: { enabled?: string[]; roomTypes?: unknown[]; rooms?: unknown[] } = {}
): HotelInventoryView {
  const enabled = overrides.enabled ?? ['ROOM', 'BED'];
  return {
    roomTypes: {
      roomTypes: overrides.roomTypes ?? [standard, dorm],
      kindOptions: [
        {
          value: 'ROOM',
          label: 'Room',
          description: 'Sold whole, by the night.',
          enabled: enabled.includes('ROOM'),
        },
        {
          value: 'BED',
          label: 'Bed in a shared room',
          description: 'Sold one berth at a time.',
          enabled: enabled.includes('BED'),
        },
        {
          value: 'UNIT',
          label: 'Unit',
          description: 'A self-contained unit.',
          enabled: enabled.includes('UNIT'),
        },
      ],
      roomLimit: { max: 50, used: 3 },
    },
    rooms: {
      rooms: overrides.rooms ?? [room101, room201],
      statusOptions: [
        { value: 'VACANT_CLEAN', label: 'Vacant, clean', housekeeping: true },
        { value: 'VACANT_DIRTY', label: 'Vacant, dirty', housekeeping: true },
        { value: 'INSPECTED', label: 'Inspected', housekeeping: true },
        { value: 'OUT_OF_ORDER', label: 'Out of order', housekeeping: false },
        { value: 'OUT_OF_SERVICE', label: 'Out of service', housekeeping: false },
      ],
      blockKindOptions: [
        { value: 'OUT_OF_ORDER', label: 'Out of order', description: 'Broken.' },
        { value: 'OUT_OF_SERVICE', label: 'Out of service', description: 'Withheld on purpose.' },
      ],
      genderPolicyOptions: [
        { value: 'ANY', label: 'No restriction' },
        { value: 'MALE', label: 'Men only' },
        { value: 'FEMALE', label: 'Women only' },
      ],
    },
  } as unknown as HotelInventoryView;
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
  h.fetchRoomTypes.mockResolvedValue(view().roomTypes);
  h.fetchRooms.mockResolvedValue(view().rooms);
  h.fetchHistory.mockResolvedValue([]);
});
afterEach(cleanup);
const mount = (initial = view()) =>
  render(<HotelInventoryPanel initial={initial} selection={selection} />);
const typeForm = () => screen.getByRole('form', { name: 'Add a room type' });
const roomForm = () => screen.getByRole('form', { name: 'Add a room' });

describe('HotelInventoryPanel', () => {
  it('names kinds, statuses and blocks for an operator and never prints an enum value', () => {
    mount();
    const types = screen
      .getByRole('heading', { level: 2, name: 'Room types (2)' })
      .closest<HTMLElement>('[data-slot="section-card"]')!;
    expect(within(types).getByText('Bed in a shared room')).toBeInTheDocument();
    expect(within(types).getByText('اسٹینڈرڈ')).toBeInTheDocument();
    expect(within(types).getByText(/Using 3 of 50 sellable units/)).toBeInTheDocument();
    const rooms = screen
      .getByRole('heading', { level: 2, name: 'Rooms (2)' })
      .closest<HTMLElement>('[data-slot="section-card"]')!;
    expect(within(rooms).getByText('Vacant, dirty')).toBeInTheDocument();
    expect(within(rooms).getByText('1 of 2 ready')).toBeInTheDocument();
    expect(within(rooms).getByText('Out of order')).toBeInTheDocument();
    expect(within(rooms).getByText('2026-10-10 → 2026-10-12')).toBeInTheDocument();
    expect(within(rooms).getByText('Connects to 101')).toBeInTheDocument();
    expect(rooms.textContent).not.toMatch(/VACANT_|OUT_OF_|type_std|room_101/);
  });

  it('adds a room type with numbers parsed and the selection attached, and offers beds-per-room only for a bed type', () => {
    mount();
    expect(screen.queryByLabelText('Beds per room')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'dlx' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Deluxe' } });
    fireEvent.change(screen.getByLabelText('Maximum adults'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Maximum children'), { target: { value: '1' } });
    fireEvent.submit(typeForm());
    expect(h.mutate.createType).toHaveBeenCalledWith({
      branchId: 'branch',
      code: 'dlx',
      name: 'Deluxe',
      nameUr: undefined,
      inventoryKind: 'ROOM',
      bedsPerRoom: undefined,
      description: undefined,
      baseAdults: 2,
      maxAdults: 3,
      maxChildren: 1,
      bedConfig: undefined,
    });
    fireEvent.change(screen.getByLabelText('Sold as'), { target: { value: 'BED' } });
    fireEvent.change(screen.getByLabelText('Beds per room'), { target: { value: '6' } });
    fireEvent.submit(typeForm());
    expect(h.mutate.createType).toHaveBeenLastCalledWith(
      expect.objectContaining({ inventoryKind: 'BED', bedsPerRoom: 6 })
    );
  });

  it('disables kinds the property does not sell and replaces the form when it sells none', () => {
    mount(view({ enabled: ['ROOM'] }));
    const unit = within(screen.getByLabelText('Sold as')).getByRole('option', { name: /Unit/ });
    expect(unit).toBeDisabled();
    expect(unit).toHaveTextContent('not available for this property');
    cleanup();
    mount(view({ enabled: [] }));
    expect(screen.queryByRole('form', { name: 'Add a room type' })).not.toBeInTheDocument();
    expect(screen.getByText(/not configured to sell rooms, beds or units/)).toBeInTheDocument();
  });

  it('refuses a non-numeric occupancy locally and lands server field errors under their inputs', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'DLX' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Deluxe' } });
    fireEvent.change(screen.getByLabelText('Maximum adults'), { target: { value: '2.5' } });
    fireEvent.submit(typeForm());
    expect(h.mutate.createType).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Maximum adults')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByLabelText('Maximum adults'), { target: { value: '2' } });
    fireEvent.submit(typeForm());
    expect(h.mutate.createType).toHaveBeenCalledTimes(1);
    act(() =>
      h.hookCallbacks.createType.onError!(
        error('BAD_REQUEST', {
          code: ['This property already has a room type with that code. Choose another.'],
        })
      )
    );
    expect(screen.getByLabelText('Code')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('already has a room type with that code');
    expect(screen.getByLabelText('Name')).toHaveValue('Deluxe');
  });

  it('commissions a room under the chosen type, offering a dorm policy only for a bed type', async () => {
    mount();
    expect(screen.queryByLabelText('Dorm policy')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Room number'), { target: { value: '102' } });
    fireEvent.change(screen.getByLabelText('Connecting room'), { target: { value: 'room_101' } });
    fireEvent.submit(roomForm());
    expect(h.mutate.createRoom).toHaveBeenCalledWith({
      branchId: 'branch',
      roomTypeId: 'type_std',
      number: '102',
      floor: undefined,
      connectingRoomId: 'room_101',
      genderPolicy: 'ANY',
      reason: 'Commissioned',
    });
    fireEvent.change(screen.getByLabelText('Room type'), { target: { value: 'type_dorm' } });
    fireEvent.change(screen.getByLabelText('Dorm policy'), { target: { value: 'FEMALE' } });
    fireEvent.change(screen.getByLabelText('Room number'), { target: { value: '202' } });
    fireEvent.submit(roomForm());
    expect(h.mutate.createRoom).toHaveBeenLastCalledWith(
      expect.objectContaining({ roomTypeId: 'type_dorm', number: '202', genderPolicy: 'FEMALE' })
    );
    await act(async () =>
      h.hookCallbacks.createRoom.onSuccess!({ room: { number: '202', beds: [{}, {}] } }, {})
    );
    expect(screen.getByText('Room 202 is commissioned with 2 beds.')).toHaveAttribute(
      'role',
      'status'
    );
    expect(h.fetchRoomTypes).toHaveBeenCalledWith({ branchId: 'branch' }, { staleTime: 0 });
    expect(h.fetchRooms).toHaveBeenCalledWith({ branchId: 'branch' }, { staleTime: 0 });
  });

  it('offers only the moves the matrix allows from the current status and sends the status it was looking at', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Status of room 101' }));
    const editor = screen.getByRole('form', { name: 'Change status of room 101' });
    const options = within(editor)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['Vacant, clean', 'Out of order', 'Out of service']);
    fireEvent.change(within(editor).getByLabelText('Reason'), {
      target: { value: 'Cleaned after checkout' },
    });
    fireEvent.submit(editor);
    expect(h.mutate.roomStatus).toHaveBeenCalledWith(
      {
        branchId: 'branch',
        id: 'room_101',
        expectedStatus: 'VACANT_DIRTY',
        status: 'VACANT_CLEAN',
        reason: 'Cleaned after checkout',
      },
      expect.any(Object)
    );
    act(() =>
      lastCallbacks('roomStatus').onSuccess!({ id: 'room_101', status: 'VACANT_CLEAN' }, {})
    );
    expect(screen.getByText('Status is now vacant, clean.')).toHaveAttribute('role', 'status');
    expect(
      screen.queryByRole('form', { name: 'Change status of room 101' })
    ).not.toBeInTheDocument();
  });

  it('moves focus into an editor when it opens, closes it with Escape and hands focus back', () => {
    mount();
    const trigger = screen.getByRole('button', { name: 'Status of room 101' });
    trigger.focus();
    fireEvent.click(trigger);
    const editor = screen.getByRole('form', { name: 'Change status of room 101' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(editor).getByLabelText('New status')).toHaveFocus();
    fireEvent.keyDown(within(editor).getByLabelText('Reason'), { key: 'Escape' });
    expect(
      screen.queryByRole('form', { name: 'Change status of room 101' })
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // A dorm's editor starts on the bed chooser; a block editor on its kind.
    fireEvent.click(screen.getByRole('button', { name: 'Status of room 201' }));
    expect(
      within(screen.getByRole('form', { name: 'Change status of room 201' })).getByLabelText(
        'Change'
      )
    ).toHaveFocus();
    const block = screen.getByRole('button', { name: 'Block room 101' });
    fireEvent.click(block);
    const blockEditor = screen.getByRole('form', { name: 'Withhold room 101' });
    expect(within(blockEditor).getByLabelText('Why it is withheld')).toHaveFocus();
    // Opening one editor closes the other without stealing focus from the new one.
    expect(
      screen.queryByRole('form', { name: 'Change status of room 201' })
    ).not.toBeInTheDocument();
    fireEvent.keyDown(blockEditor, { key: 'Escape' });
    expect(block).toHaveFocus();
  });

  it('returns focus to the row action after a saved status change closes the editor', async () => {
    mount();
    const trigger = screen.getByRole('button', { name: 'Status of room 101' });
    fireEvent.click(trigger);
    const editor = screen.getByRole('form', { name: 'Change status of room 101' });
    fireEvent.change(within(editor).getByLabelText('Reason'), { target: { value: 'Cleaned' } });
    fireEvent.submit(editor);
    act(() =>
      lastCallbacks('roomStatus').onSuccess!({ id: 'room_101', status: 'VACANT_CLEAN' }, {})
    );
    expect(
      screen.queryByRole('form', { name: 'Change status of room 101' })
    ).not.toBeInTheDocument();
    // The refresh disables the row actions; focus returns once it settles.
    expect(trigger).toBeDisabled();
    await waitFor(() => expect(trigger).toBeEnabled());
    expect(trigger).toHaveFocus();
  });

  it('changes one bed of a dorm room through the bed procedure, with that bed’s own status', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Status of room 201' }));
    const editor = screen.getByRole('form', { name: 'Change status of room 201' });
    fireEvent.change(within(editor).getByLabelText('Change'), { target: { value: 'bed_2' } });
    fireEvent.change(within(editor).getByLabelText('New status'), {
      target: { value: 'VACANT_CLEAN' },
    });
    fireEvent.change(within(editor).getByLabelText('Reason'), {
      target: { value: 'Linen changed' },
    });
    fireEvent.submit(editor);
    expect(h.mutate.bedStatus).toHaveBeenCalledWith(
      {
        branchId: 'branch',
        id: 'bed_2',
        expectedStatus: 'VACANT_DIRTY',
        status: 'VACANT_CLEAN',
        reason: 'Linen changed',
      },
      expect.any(Object)
    );
    act(() => lastCallbacks('bedStatus').onError!(error('CONFLICT')));
    expect(screen.getByRole('alert')).toHaveTextContent('Your entries are kept');
    expect(within(editor).getByLabelText('Reason')).toHaveValue('Linen changed');
    expect(h.mutate.bedStatus).toHaveBeenCalledTimes(1);
  });

  it('withholds a room for a date range and releases a live block with a reason', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Block room 101' }));
    const block = screen.getByRole('form', { name: 'Withhold room 101' });
    fireEvent.change(within(block).getByLabelText('Why it is withheld'), {
      target: { value: 'OUT_OF_SERVICE' },
    });
    fireEvent.change(within(block).getByLabelText('From'), { target: { value: '2026-11-01' } });
    fireEvent.change(within(block).getByLabelText('Back on sale from'), {
      target: { value: '2026-11-03' },
    });
    fireEvent.change(within(block).getByLabelText('Reason'), { target: { value: 'Repaint' } });
    fireEvent.change(within(block).getByLabelText('Work order'), { target: { value: 'WO-12' } });
    fireEvent.submit(block);
    expect(h.mutate.createBlock).toHaveBeenCalledWith(
      {
        branchId: 'branch',
        roomId: 'room_101',
        kind: 'OUT_OF_SERVICE',
        startDate: '2026-11-01',
        endDate: '2026-11-03',
        reason: 'Repaint',
        workOrderRef: 'WO-12',
      },
      expect.any(Object)
    );
    act(() =>
      lastCallbacks('createBlock').onError!(
        error('CONFLICT', {
          startDate: [
            'This room already has a live block over those dates. Release or shorten it first.',
          ],
        })
      )
    );
    expect(
      within(screen.getByRole('form', { name: 'Withhold room 101' })).getByLabelText('From')
    ).toHaveAttribute('aria-invalid', 'true');

    expect(screen.queryByRole('button', { name: 'Block room 201' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Release the block on room 201' }));
    const release = screen.getByRole('form', { name: 'Release the block on room 201' });
    expect(release).toHaveTextContent('Withheld since 2026-10-10: Leak');
    fireEvent.change(within(release).getByLabelText('Why it is back on sale'), {
      target: { value: 'Repaired' },
    });
    fireEvent.submit(release);
    expect(h.mutate.releaseBlock).toHaveBeenCalledWith(
      { branchId: 'branch', id: 'block_1', reason: 'Repaired' },
      expect.any(Object)
    );
  });

  it('shows a room’s attributed history and names the actor rather than an id', async () => {
    h.fetchHistory.mockResolvedValue([
      {
        id: 'e2',
        roomId: 'room_201',
        bedId: 'bed_1',
        fromStatus: 'VACANT_DIRTY',
        toStatus: 'VACANT_CLEAN',
        actorId: 'user',
        actorName: 'Hotel General Manager',
        reason: 'Cleaned',
        createdAt: when,
      },
      {
        id: 'e1',
        roomId: 'room_201',
        bedId: null,
        fromStatus: null,
        toStatus: 'VACANT_DIRTY',
        actorId: 'gone',
        actorName: null,
        reason: 'Commissioned',
        createdAt: when,
      },
    ]);
    mount();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'History of room 201' }))
    );
    expect(h.fetchHistory).toHaveBeenCalledWith(
      { branchId: 'branch', roomId: 'room_201' },
      { staleTime: 0 }
    );
    const list = screen.getByRole('heading', {
      level: 4,
      name: 'History of room 201',
    }).parentElement!;
    expect(list).toHaveTextContent('Bed 1');
    expect(list).toHaveTextContent('Vacant, dirty → Vacant, clean');
    expect(list).toHaveTextContent('Hotel General Manager');
    expect(list).toHaveTextContent('Commissioned as vacant, dirty');
    expect(list).toHaveTextContent('Unknown member');
    expect(list.textContent).not.toContain('gone');
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'])(
    'hides the lists and offers reselection after %s',
    (code) => {
      mount();
      fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'DLX' } });
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Deluxe' } });
      fireEvent.submit(typeForm());
      act(() => h.hookCallbacks.createType.onError!(error(code)));
      expect(screen.queryByText('Standard')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Choose a property' })).toHaveAttribute(
        'href',
        '/hotel/settings/rooms'
      );
    }
  );

  it('refresh bypasses a cached list and rechecks revoked access', async () => {
    mount();
    h.fetchRoomTypes.mockRejectedValueOnce(error('NOT_FOUND'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh rooms' })));
    expect(h.fetchRoomTypes).toHaveBeenCalledWith({ branchId: 'branch' }, { staleTime: 0 });
    expect(screen.getByRole('link', { name: 'Choose a property' })).toBeInTheDocument();
  });

  it('reloads on an identity change instead of writing under the old selection', () => {
    h.session = { user: { id: 'other', organizationId: 'org' } };
    mount();
    expect(screen.getByText(/Your signed-in identity changed/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add a room type' })).not.toBeInTheDocument();
  });

  it('explains empty lists with the next action', () => {
    mount(view({ roomTypes: [], rooms: [] }));
    expect(screen.getByText(/No room types yet/)).toBeInTheDocument();
    expect(screen.getByText(/No rooms yet/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add a room' })).not.toBeInTheDocument();
    expect(screen.getByText(/Add a room type first/)).toBeInTheDocument();
  });
});
