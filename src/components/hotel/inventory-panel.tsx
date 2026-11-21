'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

/**
 * PROP-02 / PROP-03 / HK-01 / HK-03 — the rooms surface: the room types a
 * property sells, the rooms (dorm rooms, units) under them, each room's
 * housekeeping status with its attributed history, and the blocks that withhold
 * a room from sale.
 *
 * It follows the three rules of the other hotel settings surfaces:
 *
 * - **No raw identifiers.** Kinds, statuses, block kinds and dorm policies are
 *   named choices; a room is its number and a type its name (UX rule 1).
 * - **Errors land on fields.** The server publishes rejections as
 *   `data.validation[field]` — a taken code or number, a kind the property does
 *   not sell, an illegal status move — so each message appears under the input
 *   it belongs to (UX rule 11).
 * - **Nothing is a dead end.** An empty list says what to add first, a status
 *   change offers only the moves the matrix allows, and a room withheld from
 *   sale shows its block with a way to release it (UX rule 13).
 *
 * Every write names the property the page was opened for; the server re-checks
 * access inside the property lock on every call.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { useSession } from 'next-auth/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  HOTEL_INVENTORY_KIND_LABELS,
  HOTEL_ROOM_STATUS_LABELS,
  calendarDayIso,
  inventoryTransitionAllowed,
  type HotelRoomStatusValue,
} from '@/lib/hotel/inventory';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type RoomTypesView = RouterOutputs['hotelProperty']['inventory']['roomTypes']['list'];
type RoomsView = RouterOutputs['hotelProperty']['inventory']['rooms']['list'];
type HistoryView = RouterOutputs['hotelProperty']['inventory']['rooms']['history'];
type RoomType = RoomTypesView['roomTypes'][number];
type Room = RoomsView['rooms'][number];
type Bed = Room['beds'][number];

export type HotelInventoryView = { roomTypes: RoomTypesView; rooms: RoomsView };
/** A status a board may set: every status but the stay-owned OCCUPIED. */
type BoardStatus = RoomsView['statusOptions'][number]['value'];
type InventorySelection = { branchId: string; organizationId: string; userId: string };

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'mt-1 min-h-11 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm focus-visible:outline-ring disabled:opacity-50 aria-invalid:border-destructive';

const STATUS_TONE: Record<
  HotelRoomStatusValue,
  'success' | 'warning' | 'danger' | 'neutral' | 'info'
> = {
  VACANT_CLEAN: 'success',
  INSPECTED: 'success',
  VACANT_DIRTY: 'warning',
  OCCUPIED: 'info',
  OUT_OF_ORDER: 'danger',
  OUT_OF_SERVICE: 'neutral',
};

function Field({
  children,
  error,
  hint,
  htmlFor,
  label,
}: {
  children: React.ReactNode;
  error?: string;
  hint?: string;
  htmlFor: string;
  label: string;
}) {
  return (
    <div className="min-w-0">
      <label className={labelClass} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-sm text-destructive" id={`${htmlFor}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-text-muted" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function validationErrors(error: unknown): Record<string, string> {
  const validation = (error as { data?: { validation?: unknown } } | null)?.data?.validation;
  if (!validation || typeof validation !== 'object') return {};
  return Object.fromEntries(
    Object.entries(validation as Record<string, unknown>).map(([field, message]) => [
      field,
      Array.isArray(message) ? String(message[0]) : String(message),
    ])
  );
}

const errorCode = (error: unknown) => (error as { data?: { code?: string } } | null)?.data?.code;
const accessDenied = (error: unknown) =>
  ['FORBIDDEN', 'UNAUTHORIZED'].includes(errorCode(error) ?? '');

/** A timestamp rendered the same on the server and in the browser (no local zone). */
function formatInstant(value: Date | string): string {
  const date = new Date(value);
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

function formatDay(value: Date | string): string {
  return calendarDayIso(new Date(value));
}

/** A whole number from a form field, or undefined when the field was left empty. */
function integer(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function statusPill(status: HotelRoomStatusValue) {
  return <StatusPill status={HOTEL_ROOM_STATUS_LABELS[status]} tone={STATUS_TONE[status]} />;
}

export function HotelInventoryPanel({
  initial,
  selection,
}: {
  initial: HotelInventoryView;
  selection: InventorySelection;
}) {
  const { data: session } = useSession();
  if (
    session?.user.id !== selection.userId ||
    session.user.organizationId !== selection.organizationId
  ) {
    return (
      <SectionCard title="Reload the rooms" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Your signed-in identity changed. Choose a property again to continue.
        </p>
        <a
          href="/hotel/settings/rooms"
          className="mt-3 inline-flex min-h-11 items-center underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Choose a property
        </a>
      </SectionCard>
    );
  }
  return (
    <SelectedInventory
      key={`${selection.organizationId}:${selection.userId}:${selection.branchId}`}
      initial={initial}
      branchId={selection.branchId}
    />
  );
}

type RowEditor =
  | { kind: 'status'; roomId: string }
  | { kind: 'block'; roomId: string }
  | { kind: 'release'; roomId: string; blockId: string }
  | null;

function SelectedInventory({
  initial,
  branchId,
}: {
  initial: HotelInventoryView;
  branchId: string;
}) {
  const [view, setView] = useState<HotelInventoryView>(initial);
  const [errors, setErrors] = useState<Record<string, Record<string, string>>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [editor, setEditor] = useState<RowEditor>(null);
  const [history, setHistory] = useState<Record<string, HistoryView | 'loading' | 'failed'>>({});
  const mounted = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const utils = trpc.useUtils();
  const refresh = async () => {
    if (!mounted.current) return;
    const request = ++generation.current;
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      const roomTypes = await utils.hotelProperty.inventory.roomTypes.list.fetch(
        { branchId },
        { staleTime: 0 }
      );
      const rooms = await utils.hotelProperty.inventory.rooms.list.fetch(
        { branchId },
        { staleTime: 0 }
      );
      if (mounted.current && request === generation.current) setView({ roomTypes, rooms });
    } catch (error) {
      if (!mounted.current || request !== generation.current) return;
      if (accessDenied(error) || errorCode(error) === 'NOT_FOUND') setUnavailable(true);
      else setRefreshFailed(true);
    } finally {
      if (mounted.current && request === generation.current) setRefreshing(false);
    }
  };

  const failure = (scope: string) => (error: { message: string }) => {
    if (!mounted.current) return;
    if (accessDenied(error)) setUnavailable(true);
    const fields = validationErrors(error);
    setSaved(null);
    // A field error wins whatever the code: the server names the field even for
    // a conflict (an overlapping block names its dates). Otherwise the sentence
    // is shown at the form, and a conflict says the entries survived.
    setErrors((current) => ({
      ...current,
      [scope]: Object.keys(fields).length
        ? fields
        : errorCode(error) === 'CONFLICT'
          ? { form: `${error.message} Your entries are kept.` }
          : { form: error.message },
    }));
  };
  const success = (scope: string, message: string, resetForm = true) => {
    if (!mounted.current) return;
    setErrors((current) => ({ ...current, [scope]: {} }));
    if (resetForm) setFormVersion((version) => version + 1);
    setEditor(null);
    setSaved(message);
    void refresh();
  };

  const createType = trpc.hotelProperty.inventory.roomTypes.create.useMutation({
    onSuccess: (result) => success('type', `${result.roomType.name} is now a room type.`),
    onError: failure('type'),
  });
  const createRoom = trpc.hotelProperty.inventory.rooms.create.useMutation({
    onSuccess: (result) =>
      success(
        'room',
        result.room.beds.length
          ? `Room ${result.room.number} is commissioned with ${result.room.beds.length} beds.`
          : `Room ${result.room.number} is commissioned.`
      ),
    onError: failure('room'),
  });
  /**
   * Row writes report into the row that issued them. The room is known in the
   * handler, so the callbacks are given per call rather than per hook.
   */
  const rowCallbacks = <TResult,>(roomId: string, message: (result: TResult) => string) => ({
    onSuccess: (result: TResult) => success(`row:${roomId}`, message(result), false),
    onError: (error: { message: string }) => failure(`row:${roomId}`)(error),
  });
  const setRoomStatus = trpc.hotelProperty.inventory.rooms.setStatus.useMutation();
  const setBedStatus = trpc.hotelProperty.inventory.beds.setStatus.useMutation();
  const createBlock = trpc.hotelProperty.inventory.blocks.create.useMutation();
  const releaseBlock = trpc.hotelProperty.inventory.blocks.release.useMutation();

  const pending =
    createType.isPending ||
    createRoom.isPending ||
    setRoomStatus.isPending ||
    setBedStatus.isPending ||
    createBlock.isPending ||
    releaseBlock.isPending;
  const busy = pending || refreshing;

  const loadHistory = async (roomId: string) => {
    if (history[roomId] && history[roomId] !== 'failed') {
      setHistory((current) => {
        const next = { ...current };
        delete next[roomId];
        return next;
      });
      return;
    }
    setHistory((current) => ({ ...current, [roomId]: 'loading' }));
    try {
      const events = await utils.hotelProperty.inventory.rooms.history.fetch(
        { branchId, roomId },
        { staleTime: 0 }
      );
      if (mounted.current) setHistory((current) => ({ ...current, [roomId]: events }));
    } catch (error) {
      if (!mounted.current) return;
      if (accessDenied(error)) setUnavailable(true);
      setHistory((current) => ({ ...current, [roomId]: 'failed' }));
    }
  };

  if (unavailable)
    return (
      <SectionCard title="Choose a property again" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Your property access changed. Choose a property you can manage to continue.
        </p>
        <a
          href="/hotel/settings/rooms"
          className="mt-3 inline-flex min-h-11 items-center underline"
        >
          Choose a property
        </a>
      </SectionCard>
    );

  const { roomTypes, kindOptions, roomLimit } = view.roomTypes;
  const { rooms, statusOptions, blockKindOptions, genderPolicyOptions } = view.rooms;
  const enabledKinds = kindOptions.filter((kind) => kind.enabled);
  const activeTypes = roomTypes.filter((type) => type.active);

  return (
    <div className="space-y-6">
      {saved ? (
        <p className="text-sm text-text-muted" role="status">
          {saved}
        </p>
      ) : null}
      {refreshing ? (
        <p className="text-sm text-text-muted" role="status">
          Refreshing rooms…
        </p>
      ) : null}
      {refreshFailed ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive" role="alert">
            Could not refresh the rooms. Showing the last loaded lists. Any confirmed save is still
            saved.
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Retry refresh
          </Button>
        </div>
      ) : null}

      <RoomTypesCard
        roomTypes={roomTypes}
        roomLimit={roomLimit}
        busy={busy}
        onRefresh={() => void refresh()}
      />

      <SectionCard
        title="Add a room type"
        titleLevel={2}
        actions={
          <span className="font-mono text-xs tabular-nums text-text-muted">
            {activeTypes.length} active
          </span>
        }
      >
        {enabledKinds.length === 0 ? (
          <p className="text-sm text-text-muted">
            This property is not configured to sell rooms, beds or units — a venue sells function
            spaces instead. Change how the property operates in property settings if that is wrong,
            or ask your DevFathom account manager about the package.
          </p>
        ) : (
          <RoomTypeForm
            key={`type-${formVersion}`}
            kinds={kindOptions}
            errors={errors.type ?? {}}
            busy={busy}
            pending={createType.isPending}
            onSubmit={(fields) => createType.mutate({ branchId, ...fields })}
          />
        )}
      </SectionCard>

      <RoomsCard
        rooms={rooms}
        statusOptions={statusOptions}
        blockKindOptions={blockKindOptions}
        roomLimit={roomLimit}
        editor={editor}
        errors={errors}
        history={history}
        busy={busy}
        onEditor={(next) => {
          setEditor(next);
          setSaved(null);
        }}
        onHistory={(roomId) => void loadHistory(roomId)}
        onStatus={(room, bed, status, reason) => {
          // The editor offers moves from the current status only, and the matrix
          // has none from OCCUPIED, so a submitted row is never occupied.
          const expectedStatus = (bed ? bed.status : room.status) as BoardStatus;
          const said = (result: { status: HotelRoomStatusValue }) =>
            `${bed ? 'Bed status' : 'Status'} is now ${HOTEL_ROOM_STATUS_LABELS[result.status].toLowerCase()}.`;
          if (bed)
            setBedStatus.mutate(
              { branchId, id: bed.id, expectedStatus, status, reason },
              rowCallbacks(room.id, said)
            );
          else
            setRoomStatus.mutate(
              { branchId, id: room.id, expectedStatus, status, reason },
              rowCallbacks(room.id, said)
            );
        }}
        onBlock={(room, fields) =>
          createBlock.mutate(
            { branchId, roomId: room.id, ...fields },
            rowCallbacks(room.id, () => 'The room is withheld for those dates.')
          )
        }
        onRelease={(room, blockId, reason) =>
          releaseBlock.mutate(
            { branchId, id: blockId, reason },
            rowCallbacks(room.id, () => 'The block is released; the room is back on sale.')
          )
        }
      />

      <SectionCard title="Add a room" titleLevel={2}>
        {activeTypes.length === 0 ? (
          <p className="text-sm text-text-muted">
            Add a room type first. Every room is sold under a type, which carries its occupancy and,
            for a dorm, how many beds each room holds.
          </p>
        ) : (
          <RoomForm
            key={`room-${formVersion}`}
            roomTypes={activeTypes}
            rooms={rooms}
            genderPolicyOptions={genderPolicyOptions}
            errors={errors.room ?? {}}
            busy={busy}
            pending={createRoom.isPending}
            onSubmit={(fields) => createRoom.mutate({ branchId, ...fields })}
          />
        )}
      </SectionCard>
    </div>
  );
}

function RoomTypesCard({
  roomTypes,
  roomLimit,
  busy,
  onRefresh,
}: {
  roomTypes: RoomType[];
  roomLimit: RoomTypesView['roomLimit'];
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <SectionCard
      title={`Room types (${roomTypes.length})`}
      titleLevel={2}
      actions={
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={onRefresh}
        >
          Refresh rooms
        </Button>
      }
    >
      <p className="mb-4 font-mono text-xs tabular-nums text-text-muted">
        Using {roomLimit.used} of {roomLimit.max} sellable units (rooms, beds and apartments) across
        this workspace.
      </p>
      {roomTypes.length === 0 ? (
        <p className="text-sm text-text-muted">
          No room types yet. A type is what the property sells — a standard room, a dorm bed, a
          one-bedroom apartment — with its occupancy. Add the first one below; the property cannot
          be activated without it.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left font-mono text-[0.6875rem] uppercase tracking-wide text-text-muted">
                <th className="py-2 pr-3 font-semibold">Code</th>
                <th className="py-2 pr-3 font-semibold">Name</th>
                <th className="py-2 pr-3 font-semibold">Sold as</th>
                <th className="py-2 pr-3 text-right font-semibold">Adults</th>
                <th className="py-2 pr-3 text-right font-semibold">Children</th>
                <th className="py-2 pr-3 text-right font-semibold">Beds / room</th>
                <th className="py-2 pr-3 text-right font-semibold">Rooms</th>
                <th className="py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {roomTypes.map((type) => (
                <tr key={type.id} className="hover:bg-surface-sunken">
                  <td className="py-3 pr-3 font-mono text-xs text-text-muted">{type.code}</td>
                  <td className="py-3 pr-3">
                    <span className="font-semibold text-text-strong">{type.name}</span>
                    {type.nameUr ? (
                      <span className="ml-2 text-text-muted" lang="ur">
                        {type.nameUr}
                      </span>
                    ) : null}
                    {type.bedConfig ? (
                      <span className="block text-xs text-text-muted">{type.bedConfig}</span>
                    ) : null}
                  </td>
                  <td className="py-3 pr-3 text-text-body">
                    {HOTEL_INVENTORY_KIND_LABELS[type.inventoryKind]}
                  </td>
                  <td className="py-3 pr-3 text-right tabular-nums text-text-body">
                    {type.baseAdults === type.maxAdults
                      ? type.maxAdults
                      : `${type.baseAdults}–${type.maxAdults}`}
                  </td>
                  <td className="py-3 pr-3 text-right tabular-nums text-text-body">
                    {type.maxChildren}
                  </td>
                  <td className="py-3 pr-3 text-right tabular-nums text-text-body">
                    {type.bedsPerRoom ?? '—'}
                  </td>
                  <td className="py-3 pr-3 text-right tabular-nums text-text-body">
                    {type._count.rooms}
                  </td>
                  <td className="py-3">
                    <StatusPill
                      status={type.active ? 'Active' : 'Retired'}
                      tone={type.active ? 'success' : 'neutral'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

type RoomTypeFields = {
  code: string;
  name: string;
  nameUr?: string;
  inventoryKind: RoomType['inventoryKind'];
  bedsPerRoom?: number;
  description?: string;
  baseAdults: number;
  maxAdults: number;
  maxChildren: number;
  bedConfig?: string;
};

function RoomTypeForm({
  kinds,
  errors,
  busy,
  pending,
  onSubmit,
}: {
  kinds: RoomTypesView['kindOptions'];
  errors: Record<string, string>;
  busy: boolean;
  pending: boolean;
  onSubmit: (fields: RoomTypeFields) => void;
}) {
  const [kind, setKind] = useState<RoomType['inventoryKind']>(
    kinds.find((option) => option.enabled)?.value ?? 'ROOM'
  );
  const [local, setLocal] = useState<Record<string, string>>({});
  const fieldProps = (name: string, hasHint = true) => ({
    'aria-invalid': Boolean(errors[name] ?? local[name]),
    'aria-describedby':
      (errors[name] ?? local[name]) ? `${name}-error` : hasHint ? `${name}-hint` : undefined,
    disabled: busy,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setLocal({});
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const numbers = {
      baseAdults: integer(text('baseAdults')) ?? Number.NaN,
      maxAdults: integer(text('maxAdults')) ?? Number.NaN,
      maxChildren: integer(text('maxChildren')) ?? 0,
      bedsPerRoom: kind === 'BED' ? (integer(text('bedsPerRoom')) ?? Number.NaN) : undefined,
    };
    const invalid = Object.entries(numbers)
      .filter(([, value]) => Number.isNaN(value))
      .map(([field]) => [field, 'Enter a whole number.'] as const);
    if (invalid.length) {
      setLocal(Object.fromEntries(invalid));
      return;
    }
    onSubmit({
      code: text('code'),
      name: text('name'),
      nameUr: text('nameUr') || undefined,
      inventoryKind: kind,
      bedsPerRoom: numbers.bedsPerRoom,
      description: text('description') || undefined,
      baseAdults: numbers.baseAdults,
      maxAdults: numbers.maxAdults,
      maxChildren: numbers.maxChildren,
      bedConfig: text('bedConfig') || undefined,
    });
  };
  const message = (name: string) => errors[name] ?? local[name];
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={submit}
      aria-busy={pending}
      aria-label="Add a room type"
    >
      <Field
        htmlFor="code"
        label="Code"
        error={message('code')}
        hint="Short and stable: it travels to rate plans and channel mappings. Capitals, numbers, hyphens."
      >
        <Input id="code" name="code" className="min-h-11" {...fieldProps('code')} required />
      </Field>
      <Field htmlFor="name" label="Name" error={message('name')}>
        <Input id="name" name="name" className="min-h-11" {...fieldProps('name', false)} required />
      </Field>
      <Field
        htmlFor="nameUr"
        label="Name in Urdu"
        error={message('nameUr')}
        hint="Optional. Shown to guests who read the property in Urdu."
      >
        <Input id="nameUr" name="nameUr" className="min-h-11" lang="ur" {...fieldProps('nameUr')} />
      </Field>
      <Field
        htmlFor="inventoryKind"
        label="Sold as"
        error={message('inventoryKind')}
        hint={kinds.find((option) => option.value === kind)?.description}
      >
        <StudioSelect
          id="inventoryKind"
          name="inventoryKind"
          value={kind}
          onChange={(event) => setKind(event.target.value as RoomType['inventoryKind'])}
          className={selectClass}
          {...fieldProps('inventoryKind')}
        >
          {kinds.map((option) => (
            <option key={option.value} value={option.value} disabled={!option.enabled}>
              {option.label}
              {option.enabled ? '' : ' (not available for this property)'}
            </option>
          ))}
        </StudioSelect>
      </Field>
      {kind === 'BED' ? (
        <Field
          htmlFor="bedsPerRoom"
          label="Beds per room"
          error={message('bedsPerRoom')}
          hint="Each room of this type is commissioned with this many beds, numbered 1 upwards."
        >
          <Input
            id="bedsPerRoom"
            name="bedsPerRoom"
            className="min-h-11"
            type="number"
            min={1}
            max={100}
            step={1}
            {...fieldProps('bedsPerRoom')}
            required
          />
        </Field>
      ) : null}
      <Field
        htmlFor="baseAdults"
        label="Standard adults"
        error={message('baseAdults')}
        hint="How many adults the standard rate includes."
      >
        <Input
          id="baseAdults"
          name="baseAdults"
          className="min-h-11"
          type="number"
          min={1}
          max={100}
          step={1}
          defaultValue={kind === 'BED' ? 1 : 2}
          {...fieldProps('baseAdults')}
          required
        />
      </Field>
      <Field htmlFor="maxAdults" label="Maximum adults" error={message('maxAdults')}>
        <Input
          id="maxAdults"
          name="maxAdults"
          className="min-h-11"
          type="number"
          min={1}
          max={100}
          step={1}
          defaultValue={kind === 'BED' ? 1 : 2}
          {...fieldProps('maxAdults', false)}
          required
        />
      </Field>
      <Field htmlFor="maxChildren" label="Maximum children" error={message('maxChildren')}>
        <Input
          id="maxChildren"
          name="maxChildren"
          className="min-h-11"
          type="number"
          min={0}
          max={100}
          step={1}
          defaultValue={0}
          {...fieldProps('maxChildren', false)}
        />
      </Field>
      <Field
        htmlFor="bedConfig"
        label="Bed configuration"
        error={message('bedConfig')}
        hint="Optional, e.g. 1 king or 2 twin. Shown, never parsed."
      >
        <Input id="bedConfig" name="bedConfig" className="min-h-11" {...fieldProps('bedConfig')} />
      </Field>
      <Field
        htmlFor="description"
        label="Description"
        error={message('description')}
        hint="Optional. What a guest reads when choosing this type."
      >
        <Input
          id="description"
          name="description"
          className="min-h-11"
          {...fieldProps('description')}
        />
      </Field>
      <div className="sm:col-span-2">
        {errors.form ? (
          <p className="mb-2 text-sm text-destructive" role="alert">
            {errors.form}
          </p>
        ) : null}
        <Button type="submit" className="min-h-11" disabled={busy}>
          {pending ? 'Saving…' : 'Add room type'}
        </Button>
      </div>
    </form>
  );
}

type RoomFields = {
  roomTypeId: string;
  number: string;
  floor?: string;
  connectingRoomId?: string;
  genderPolicy: Room['genderPolicy'];
  reason: string;
};

function RoomForm({
  roomTypes,
  rooms,
  genderPolicyOptions,
  errors,
  busy,
  pending,
  onSubmit,
}: {
  roomTypes: RoomType[];
  rooms: Room[];
  genderPolicyOptions: RoomsView['genderPolicyOptions'];
  errors: Record<string, string>;
  busy: boolean;
  pending: boolean;
  onSubmit: (fields: RoomFields) => void;
}) {
  const [roomTypeId, setRoomTypeId] = useState(roomTypes[0]?.id ?? '');
  const selectedType = roomTypes.find((type) => type.id === roomTypeId);
  const fieldProps = (name: string, hasHint = true) => ({
    'aria-invalid': Boolean(errors[name]),
    'aria-describedby': errors[name] ? `${name}-error` : hasHint ? `${name}-hint` : undefined,
    disabled: busy,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    onSubmit({
      roomTypeId,
      number: text('number'),
      floor: text('floor') || undefined,
      connectingRoomId: text('connectingRoomId') || undefined,
      genderPolicy: (selectedType?.inventoryKind === 'BED'
        ? text('genderPolicy') || 'ANY'
        : 'ANY') as Room['genderPolicy'],
      reason: text('reason') || 'Commissioned',
    });
  };
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={submit}
      aria-busy={pending}
      aria-label="Add a room"
    >
      <Field
        htmlFor="roomTypeId"
        label="Room type"
        error={errors.roomTypeId}
        hint={
          selectedType
            ? `${HOTEL_INVENTORY_KIND_LABELS[selectedType.inventoryKind]}${selectedType.bedsPerRoom ? ` · ${selectedType.bedsPerRoom} beds per room` : ''}`
            : undefined
        }
      >
        <StudioSelect
          id="roomTypeId"
          name="roomTypeId"
          value={roomTypeId}
          onChange={(event) => setRoomTypeId(event.target.value)}
          className={selectClass}
          {...fieldProps('roomTypeId')}
        >
          {roomTypes.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name} ({type.code})
            </option>
          ))}
        </StudioSelect>
      </Field>
      <Field
        htmlFor="number"
        label="Room number"
        error={errors.number}
        hint="As it reads on the door: 101, 2B, Villa 3."
      >
        <Input id="number" name="number" className="min-h-11" {...fieldProps('number')} required />
      </Field>
      <Field htmlFor="floor" label="Floor" error={errors.floor} hint="Optional.">
        <Input id="floor" name="floor" className="min-h-11" {...fieldProps('floor')} />
      </Field>
      <Field
        htmlFor="connectingRoomId"
        label="Connecting room"
        error={errors.connectingRoomId}
        hint="Optional. A room this one opens into."
      >
        <StudioSelect
          id="connectingRoomId"
          name="connectingRoomId"
          defaultValue=""
          className={selectClass}
          {...fieldProps('connectingRoomId')}
        >
          <option value="">None</option>
          {rooms.map((room) => (
            <option key={room.id} value={room.id}>
              {room.number}
            </option>
          ))}
        </StudioSelect>
      </Field>
      {selectedType?.inventoryKind === 'BED' ? (
        <Field
          htmlFor="genderPolicy"
          label="Dorm policy"
          error={errors.genderPolicy}
          hint="Who may be booked into this shared room."
        >
          <StudioSelect
            id="genderPolicy"
            name="genderPolicy"
            defaultValue="ANY"
            className={selectClass}
            {...fieldProps('genderPolicy')}
          >
            {genderPolicyOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </StudioSelect>
        </Field>
      ) : null}
      <Field
        htmlFor="reason"
        label="Note for the record"
        error={errors.reason}
        hint="Recorded with the room’s first status, e.g. Commissioned after refurbishment."
      >
        <Input
          id="reason"
          name="reason"
          className="min-h-11"
          defaultValue="Commissioned"
          {...fieldProps('reason')}
        />
      </Field>
      <div className="sm:col-span-2">
        {errors.form ? (
          <p className="mb-2 text-sm text-destructive" role="alert">
            {errors.form}
          </p>
        ) : null}
        <Button type="submit" className="min-h-11" disabled={busy || !selectedType}>
          {pending ? 'Saving…' : 'Add room'}
        </Button>
      </div>
    </form>
  );
}

function RoomsCard({
  rooms,
  statusOptions,
  blockKindOptions,
  roomLimit,
  editor,
  errors,
  history,
  busy,
  onEditor,
  onHistory,
  onStatus,
  onBlock,
  onRelease,
}: {
  rooms: Room[];
  statusOptions: RoomsView['statusOptions'];
  blockKindOptions: RoomsView['blockKindOptions'];
  roomLimit: RoomTypesView['roomLimit'];
  editor: RowEditor;
  errors: Record<string, Record<string, string>>;
  history: Record<string, HistoryView | 'loading' | 'failed'>;
  busy: boolean;
  onEditor: (next: RowEditor) => void;
  onHistory: (roomId: string) => void;
  onStatus: (room: Room, bed: Bed | null, status: BoardStatus, reason: string) => void;
  onBlock: (
    room: Room,
    fields: {
      kind: Room['blocks'][number]['kind'];
      startDate: string;
      endDate: string;
      reason: string;
      workOrderRef?: string;
    }
  ) => void;
  onRelease: (room: Room, blockId: string, reason: string) => void;
}) {
  return (
    <SectionCard
      title={`Rooms (${rooms.length})`}
      titleLevel={2}
      actions={
        <span className="font-mono text-xs tabular-nums text-text-muted">
          {roomLimit.used}/{roomLimit.max} units
        </span>
      }
    >
      {rooms.length === 0 ? (
        <p className="text-sm text-text-muted">
          No rooms yet. Add the rooms sold under each type below; each is commissioned vacant and
          dirty, and housekeeping marks it clean before it can be sold.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left font-mono text-[0.6875rem] uppercase tracking-wide text-text-muted">
                <th className="py-2 pr-3 font-semibold">Room</th>
                <th className="py-2 pr-3 font-semibold">Type</th>
                <th className="py-2 pr-3 font-semibold">Status</th>
                <th className="py-2 pr-3 font-semibold">Beds</th>
                <th className="py-2 pr-3 font-semibold">Withheld</th>
                <th className="py-2 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {rooms.map((room) => {
                const rowErrors = errors[`row:${room.id}`] ?? {};
                const open = editor && editor.roomId === room.id ? editor : null;
                const rowHistory = history[room.id];
                return (
                  <RoomRow
                    key={room.id}
                    room={room}
                    statusOptions={statusOptions}
                    blockKindOptions={blockKindOptions}
                    open={open}
                    rowErrors={rowErrors}
                    rowHistory={rowHistory}
                    busy={busy}
                    onEditor={onEditor}
                    onHistory={onHistory}
                    onStatus={onStatus}
                    onBlock={onBlock}
                    onRelease={onRelease}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

/**
 * Keyboard contract for the inline row editors: focus moves to the editor's
 * first control when it opens, Escape closes it, and focus returns to the row
 * action that opened it when it closes for any reason (cancel, Escape, a saved
 * change). The triggers carry `aria-expanded`, so nothing is announced twice.
 */
function useOpeningFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

function closeOnEscape(onCancel: () => void) {
  return (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };
}

function RoomRow({
  room,
  statusOptions,
  blockKindOptions,
  open,
  rowErrors,
  rowHistory,
  busy,
  onEditor,
  onHistory,
  onStatus,
  onBlock,
  onRelease,
}: {
  room: Room;
  statusOptions: RoomsView['statusOptions'];
  blockKindOptions: RoomsView['blockKindOptions'];
  open: RowEditor;
  rowErrors: Record<string, string>;
  rowHistory: HistoryView | 'loading' | 'failed' | undefined;
  busy: boolean;
  onEditor: (next: RowEditor) => void;
  onHistory: (roomId: string) => void;
  onStatus: (room: Room, bed: Bed | null, status: BoardStatus, reason: string) => void;
  onBlock: (
    room: Room,
    fields: {
      kind: Room['blocks'][number]['kind'];
      startDate: string;
      endDate: string;
      reason: string;
      workOrderRef?: string;
    }
  ) => void;
  onRelease: (room: Room, blockId: string, reason: string) => void;
}) {
  const isDorm = room.inventoryKind === 'BED';
  const liveBlock = room.blocks[0] ?? null;
  const cleanBeds = room.beds.filter(
    (bed) => bed.status === 'VACANT_CLEAN' || bed.status === 'INSPECTED'
  ).length;
  const historyOpen = rowHistory !== undefined;
  const statusTrigger = useRef<HTMLButtonElement>(null);
  const blockTrigger = useRef<HTMLButtonElement>(null);
  const lastTrigger = useRef<HTMLButtonElement | null>(null);
  const openKind = open?.kind ?? null;
  const restoreFocus = useRef(false);
  useEffect(() => {
    // The editor closed and took the focused control with it: hand focus back
    // to the action that opened it rather than letting it fall to the body.
    // A saved change closes the editor while the refresh disables the row
    // actions, and a disabled button cannot take focus, so wait until the row
    // is idle again before handing focus back.
    if (openKind !== null) {
      restoreFocus.current = true;
      return;
    }
    if (!restoreFocus.current || busy || typeof document === 'undefined') return;
    restoreFocus.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    lastTrigger.current?.focus();
  }, [openKind, busy]);
  const toggle = (
    trigger: { current: HTMLButtonElement | null },
    next: Exclude<RowEditor, null>
  ) => {
    if (open?.kind === next.kind) {
      onEditor(null);
      return;
    }
    lastTrigger.current = trigger.current;
    onEditor(next);
  };
  return (
    <>
      <tr className="align-top hover:bg-surface-sunken">
        <td className="py-3 pr-3">
          <span className="font-semibold text-text-strong">{room.number}</span>
          <span className="block text-xs text-text-muted">
            {room.floor ? `Floor ${room.floor}` : null}
            {room.floor && room.connectingRoom ? ' · ' : null}
            {room.connectingRoom ? `Connects to ${room.connectingRoom.number}` : null}
            {!room.floor && !room.connectingRoom ? '—' : null}
          </span>
        </td>
        <td className="py-3 pr-3 text-text-body">
          {room.roomType.name}
          <span className="block font-mono text-xs text-text-muted">{room.roomType.code}</span>
        </td>
        <td className="py-3 pr-3">
          {statusPill(room.status)}
          <span className="block text-xs text-text-muted">
            since {formatInstant(room.statusChangedAt)}
          </span>
        </td>
        <td className="py-3 pr-3 text-text-body tabular-nums">
          {isDorm ? `${cleanBeds} of ${room.beds.length} ready` : '—'}
        </td>
        <td className="py-3 pr-3">
          {liveBlock ? (
            <>
              <StatusPill
                status={
                  blockKindOptions.find((option) => option.value === liveBlock.kind)?.label ??
                  liveBlock.kind
                }
                tone={liveBlock.kind === 'OUT_OF_ORDER' ? 'danger' : 'neutral'}
              />
              <span className="block text-xs text-text-muted tabular-nums">
                {formatDay(liveBlock.startDate)} → {formatDay(liveBlock.endDate)}
              </span>
            </>
          ) : (
            <span className="text-xs text-text-muted">On sale</span>
          )}
        </td>
        <td className="py-3">
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={busy}
              aria-expanded={open?.kind === 'status'}
              ref={statusTrigger}
              onClick={() => toggle(statusTrigger, { kind: 'status', roomId: room.id })}
              aria-label={`Status of room ${room.number}`}
            >
              Status
            </Button>
            {liveBlock ? (
              <Button
                type="button"
                variant="ghost"
                className="min-h-11"
                disabled={busy}
                aria-expanded={open?.kind === 'release'}
                ref={blockTrigger}
                onClick={() =>
                  toggle(blockTrigger, { kind: 'release', roomId: room.id, blockId: liveBlock.id })
                }
                aria-label={`Release the block on room ${room.number}`}
              >
                Release
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                className="min-h-11"
                disabled={busy}
                aria-expanded={open?.kind === 'block'}
                ref={blockTrigger}
                onClick={() => toggle(blockTrigger, { kind: 'block', roomId: room.id })}
                aria-label={`Block room ${room.number}`}
              >
                Block
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={busy}
              aria-expanded={historyOpen}
              onClick={() => onHistory(room.id)}
              aria-label={`History of room ${room.number}`}
            >
              History
            </Button>
          </div>
        </td>
      </tr>
      {open || rowErrors.form || historyOpen ? (
        <tr className="bg-surface-sunken/60">
          <td colSpan={6} className="px-3 py-4">
            {rowErrors.form && !open ? (
              <p className="mb-3 text-sm text-destructive" role="alert">
                {rowErrors.form}
              </p>
            ) : null}
            {open?.kind === 'status' ? (
              <StatusEditor
                room={room}
                statusOptions={statusOptions}
                errors={rowErrors}
                busy={busy}
                onCancel={() => onEditor(null)}
                onSubmit={(bed, status, reason) => onStatus(room, bed, status, reason)}
              />
            ) : null}
            {open?.kind === 'block' ? (
              <BlockEditor
                room={room}
                blockKindOptions={blockKindOptions}
                errors={rowErrors}
                busy={busy}
                onCancel={() => onEditor(null)}
                onSubmit={(fields) => onBlock(room, fields)}
              />
            ) : null}
            {open?.kind === 'release' && liveBlock ? (
              <ReleaseEditor
                room={room}
                block={liveBlock}
                errors={rowErrors}
                busy={busy}
                onCancel={() => onEditor(null)}
                onSubmit={(reason) => onRelease(room, liveBlock.id, reason)}
              />
            ) : null}
            {historyOpen ? <HistoryList room={room} history={rowHistory} /> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function StatusEditor({
  room,
  statusOptions,
  errors,
  busy,
  onCancel,
  onSubmit,
}: {
  room: Room;
  statusOptions: RoomsView['statusOptions'];
  errors: Record<string, string>;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (bed: Bed | null, status: BoardStatus, reason: string) => void;
}) {
  const isDorm = room.inventoryKind === 'BED';
  const [target, setTarget] = useState<string>('room');
  const bed = isDorm ? (room.beds.find((candidate) => candidate.id === target) ?? null) : null;
  const current = bed ? bed.status : room.status;
  const moves = statusOptions.filter((option) => inventoryTransitionAllowed(current, option.value));
  const prefix = `status-${room.id}`;
  const first = useOpeningFocus<HTMLSelectElement>();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const status = moves.find((option) => option.value === String(form.get('status') ?? ''));
    if (!status) return;
    onSubmit(bed, status.value, String(form.get('reason') ?? '').trim());
  };
  return (
    <form
      className="grid gap-3 sm:grid-cols-[auto_1fr_2fr_auto] sm:items-end"
      onSubmit={submit}
      onKeyDown={closeOnEscape(onCancel)}
      aria-label={`Change status of room ${room.number}`}
    >
      {isDorm ? (
        <Field htmlFor={`${prefix}-target`} label="Change">
          <StudioSelect
            id={`${prefix}-target`}
            ref={first}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            className={selectClass}
            disabled={busy}
          >
            <option value="room">Whole room</option>
            {room.beds.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                Bed {candidate.label} · {HOTEL_ROOM_STATUS_LABELS[candidate.status]}
              </option>
            ))}
          </StudioSelect>
        </Field>
      ) : (
        <p className="text-sm text-text-body">
          Now{' '}
          <span className="font-semibold">{HOTEL_ROOM_STATUS_LABELS[current].toLowerCase()}</span>
        </p>
      )}
      <Field htmlFor={`${prefix}-status`} label="New status" error={errors.status}>
        <StudioSelect
          id={`${prefix}-status`}
          ref={isDorm ? undefined : first}
          name="status"
          className={selectClass}
          disabled={busy || moves.length === 0}
          aria-invalid={Boolean(errors.status)}
          defaultValue={moves[0]?.value ?? ''}
        >
          {moves.length === 0 ? <option value="">No move allowed from here</option> : null}
          {moves.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </StudioSelect>
      </Field>
      <Field
        htmlFor={`${prefix}-reason`}
        label="Reason"
        error={errors.reason}
        hint="Recorded in the room’s history with your name."
      >
        <Input
          id={`${prefix}-reason`}
          name="reason"
          className="min-h-11"
          disabled={busy}
          aria-invalid={Boolean(errors.reason)}
          required
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" className="min-h-11" disabled={busy || moves.length === 0}>
          Save status
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
      {errors.form ? (
        <p className="text-sm text-destructive sm:col-span-4" role="alert">
          {errors.form}
        </p>
      ) : null}
    </form>
  );
}

function BlockEditor({
  room,
  blockKindOptions,
  errors,
  busy,
  onCancel,
  onSubmit,
}: {
  room: Room;
  blockKindOptions: RoomsView['blockKindOptions'];
  errors: Record<string, string>;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (fields: {
    kind: Room['blocks'][number]['kind'];
    startDate: string;
    endDate: string;
    reason: string;
    workOrderRef?: string;
  }) => void;
}) {
  const prefix = `block-${room.id}`;
  const first = useOpeningFocus<HTMLSelectElement>();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    onSubmit({
      kind: text('kind') as Room['blocks'][number]['kind'],
      startDate: text('startDate'),
      endDate: text('endDate'),
      reason: text('reason'),
      workOrderRef: text('workOrderRef') || undefined,
    });
  };
  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end"
      onSubmit={submit}
      onKeyDown={closeOnEscape(onCancel)}
      aria-label={`Withhold room ${room.number}`}
    >
      <Field
        htmlFor={`${prefix}-kind`}
        label="Why it is withheld"
        error={errors.kind}
        hint={blockKindOptions[0]?.description}
      >
        <StudioSelect
          id={`${prefix}-kind`}
          ref={first}
          name="kind"
          className={selectClass}
          disabled={busy}
          defaultValue={blockKindOptions[0]?.value}
        >
          {blockKindOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </StudioSelect>
      </Field>
      <Field htmlFor={`${prefix}-start`} label="From" error={errors.startDate}>
        <Input
          id={`${prefix}-start`}
          name="startDate"
          type="date"
          className="min-h-11"
          disabled={busy}
          aria-invalid={Boolean(errors.startDate)}
          required
        />
      </Field>
      <Field
        htmlFor={`${prefix}-end`}
        label="Back on sale from"
        error={errors.endDate}
        hint="The first day the room is sold again."
      >
        <Input
          id={`${prefix}-end`}
          name="endDate"
          type="date"
          className="min-h-11"
          disabled={busy}
          aria-invalid={Boolean(errors.endDate)}
          required
        />
      </Field>
      <Field htmlFor={`${prefix}-reason`} label="Reason" error={errors.reason}>
        <Input
          id={`${prefix}-reason`}
          name="reason"
          className="min-h-11"
          disabled={busy}
          aria-invalid={Boolean(errors.reason)}
          required
        />
      </Field>
      <Field
        htmlFor={`${prefix}-work-order`}
        label="Work order"
        error={errors.workOrderRef}
        hint="Optional reference."
      >
        <Input
          id={`${prefix}-work-order`}
          name="workOrderRef"
          className="min-h-11"
          disabled={busy}
        />
      </Field>
      <div className="flex gap-2 sm:col-span-2 lg:col-span-5">
        <Button type="submit" className="min-h-11" disabled={busy}>
          Withhold room
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
      {errors.form ? (
        <p className="text-sm text-destructive sm:col-span-2 lg:col-span-5" role="alert">
          {errors.form}
        </p>
      ) : null}
    </form>
  );
}

function ReleaseEditor({
  room,
  block,
  errors,
  busy,
  onCancel,
  onSubmit,
}: {
  room: Room;
  block: Room['blocks'][number];
  errors: Record<string, string>;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const prefix = `release-${room.id}`;
  const first = useOpeningFocus<HTMLInputElement>();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    onSubmit(String(form.get('reason') ?? '').trim());
  };
  return (
    <form
      className="grid gap-3 sm:grid-cols-[2fr_auto] sm:items-end"
      onSubmit={submit}
      onKeyDown={closeOnEscape(onCancel)}
      aria-label={`Release the block on room ${room.number}`}
    >
      <Field
        htmlFor={`${prefix}-reason`}
        label="Why it is back on sale"
        error={errors.reason}
        hint={`Withheld since ${formatDay(block.startDate)}: ${block.reason}`}
      >
        <Input
          id={`${prefix}-reason`}
          ref={first}
          name="reason"
          className="min-h-11"
          disabled={busy}
          aria-invalid={Boolean(errors.reason)}
          required
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" className="min-h-11" disabled={busy}>
          Release block
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
      {errors.form ? (
        <p className="text-sm text-destructive sm:col-span-2" role="alert">
          {errors.form}
        </p>
      ) : null}
    </form>
  );
}

function HistoryList({
  room,
  history,
}: {
  room: Room;
  history: HistoryView | 'loading' | 'failed' | undefined;
}) {
  if (history === 'loading')
    return (
      <p className="mt-3 text-sm text-text-muted" role="status">
        Loading the history of room {room.number}…
      </p>
    );
  if (history === 'failed')
    return (
      <p className="mt-3 text-sm text-destructive" role="alert">
        Could not load the history of room {room.number}. Try again.
      </p>
    );
  if (!history) return null;
  return (
    <div className="mt-3">
      <h4 className="font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted">
        History of room {room.number}
      </h4>
      {history.length === 0 ? (
        <p className="text-sm text-text-muted">No status changes recorded.</p>
      ) : (
        <ol className="mt-2 divide-y divide-border-subtle">
          {history.map((event) => (
            <li
              key={event.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm"
            >
              <span className="font-mono text-xs tabular-nums text-text-muted">
                {formatInstant(event.createdAt)}
              </span>
              {event.bedId ? (
                <span className="text-xs text-text-muted">
                  Bed {room.beds.find((bed) => bed.id === event.bedId)?.label ?? '?'}
                </span>
              ) : null}
              <span className="text-text-body">
                {event.fromStatus
                  ? `${HOTEL_ROOM_STATUS_LABELS[event.fromStatus]} → ${HOTEL_ROOM_STATUS_LABELS[event.toStatus]}`
                  : `Commissioned as ${HOTEL_ROOM_STATUS_LABELS[event.toStatus].toLowerCase()}`}
              </span>
              <span className="text-text-muted">{event.reason}</span>
              <span className="ml-auto text-xs text-text-muted">
                {event.actorName ?? 'Unknown member'}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
