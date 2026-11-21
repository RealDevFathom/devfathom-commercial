'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

/**
 * PROP-07 — the function spaces surface: the halls, lawns and boardrooms a
 * property sells, how each can be laid out, what it costs, how long it takes to
 * turn around, and the claims on its time.
 *
 * It follows the three rules of the other hotel settings surfaces:
 *
 * - **No raw identifiers.** A space is its name, its layouts are named with their
 *   capacities, buffers are described in minutes, money is shown in rupees though
 *   it is stored in paisa, and a claim is "Tentative hold" or "Confirmed
 *   function", never an enum value (UX rule 1).
 * - **Errors land on fields.** The server publishes rejections as
 *   `data.validation[field]` — a taken name, a widened buffer that would collide
 *   bookings, a busy hall — so each message appears under the input it belongs to
 *   (UX rule 11).
 * - **Nothing is a dead end.** A property that cannot sell function space is told
 *   where that is decided; a busy hall is refused with the time it is next free;
 *   a retired space is listed with a way to bring it back (UX rule 13).
 *
 * Times are entered and shown in the property's own zone, whatever the browser's
 * is: a function at 7 pm in Lahore is 7 pm in Lahore on every screen.
 *
 * Every write names the property the page was opened for and the version of
 * the space the editor saw; the server re-checks access, the module and the
 * property's configuration inside the property lock on every call.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { useSession } from 'next-auth/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type HotelFunctionSpacesView = RouterOutputs['hotelProperty']['spaces']['list'];
type Space = HotelFunctionSpacesView['spaces'][number];
type Booking = HotelFunctionSpacesView['bookings'][number];
type BookingKind = HotelFunctionSpacesView['kindOptions'][number]['value'];
type SpacesSelection = { branchId: string; organizationId: string; userId: string };

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'mt-1 min-h-11 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm focus-visible:outline-ring disabled:opacity-50 aria-invalid:border-destructive';

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

/* ------------------------------------------------------------------ *
 * Money, layouts and time, as an operator reads and writes them
 * ------------------------------------------------------------------ */

/** PKR minor units in, rupees out. Money is never a float on the way in. */
export function rupees(minor: number | undefined): string | null {
  if (minor === undefined) return null;
  return `PKR ${(minor / 100).toLocaleString('en-PK', { minimumFractionDigits: 2 })}`;
}

function minorOf(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Math.round(Number(trimmed) * 100);
}

/**
 * `Theatre 300, Banquet 220` — one line an operator can type and read back. The
 * stored `[{layout, capacity}]` is the storage shape, not something to make
 * anyone write as JSON. An entry without a number keeps a capacity of 0 so the
 * server refuses it on the layouts field rather than this code guessing one.
 */
export function parseLayouts(value: string): { layout: string; capacity: number }[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^(.*?)[\s:]+(\d+)$/.exec(entry);
      return match
        ? { layout: match[1]!.trim(), capacity: Number(match[2]) }
        : { layout: entry, capacity: 0 };
    });
}

export function formatLayouts(layouts: Space['layouts']): string {
  return layouts.map((entry) => `${entry.layout} ${entry.capacity}`).join(', ');
}

/**
 * The wall-clock offset of `timeZone` at `instant`, in minutes. `longOffset`
 * prints "GMT+05:00" / "GMT-03:30" / "GMT" for every zone Intl knows.
 */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant)
    .find((entry) => entry.type === 'timeZoneName')?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(part ?? '');
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * A `datetime-local` value (`YYYY-MM-DDTHH:MM`) read as a wall-clock time in
 * the property's zone, returned as the instant it names. Two passes settle the
 * offset across a transition; a zone with none needs one.
 */
export function zonedInputToDate(value: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as number[];
  const wall = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  let guess = wall - zoneOffsetMinutes(new Date(wall), timeZone) * 60_000;
  guess = wall - zoneOffsetMinutes(new Date(guess), timeZone) * 60_000;
  const date = new Date(guess);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** An instant as the property's clock shows it: `Sat 14 Mar 2026, 19:00`. */
export function formatInZone(value: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

/** The same instant's clock time alone, for the end of a span on the same day. */
function formatTimeInZone(value: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function sameZonedDay(start: Date | string, end: Date | string, timeZone: string): boolean {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' });
  return day.format(new Date(start)) === day.format(new Date(end));
}

export function formatSpan(start: Date | string, end: Date | string, timeZone: string): string {
  return sameZonedDay(start, end, timeZone)
    ? `${formatInZone(start, timeZone)} – ${formatTimeInZone(end, timeZone)}`
    : `${formatInZone(start, timeZone)} → ${formatInZone(end, timeZone)}`;
}

/**
 * Keyboard contract for the inline editors: focus moves to the editor's first
 * control when it opens, Escape closes it, and focus returns to the row action
 * that opened it when it closes for any reason (cancel, Escape, a saved change).
 */
function useOpeningFocus<T extends HTMLElement>(enabled: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (enabled) ref.current?.focus();
  }, [enabled]);
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

export function HotelFunctionSpacesPanel({
  initial,
  selection,
}: {
  initial: HotelFunctionSpacesView;
  selection: SpacesSelection;
}) {
  const { data: session } = useSession();
  if (
    session?.user.id !== selection.userId ||
    session.user.organizationId !== selection.organizationId
  ) {
    return (
      <SectionCard title="Reload the function spaces" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Your signed-in identity changed. Choose a property again to continue.
        </p>
        <a
          href="/hotel/settings/spaces"
          className="mt-3 inline-flex min-h-11 items-center underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Choose a property
        </a>
      </SectionCard>
    );
  }
  return (
    <SelectedSpaces
      key={`${selection.organizationId}:${selection.userId}:${selection.branchId}`}
      initial={initial}
      branchId={selection.branchId}
    />
  );
}

type RowEditor = { kind: 'edit' | 'hold'; spaceId: string } | null;

function SelectedSpaces({
  initial,
  branchId,
}: {
  initial: HotelFunctionSpacesView;
  branchId: string;
}) {
  const [view, setView] = useState<HotelFunctionSpacesView>(initial);
  const [errors, setErrors] = useState<Record<string, Record<string, string>>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [editor, setEditor] = useState<RowEditor>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
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
      // A saved change must be reflected at once, past the provider's query cache.
      const next = await utils.hotelProperty.spaces.list.fetch({ branchId }, { staleTime: 0 });
      if (mounted.current && request === generation.current) setView(next);
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
    // A field error wins whatever the code: a busy hall names its start time.
    // Otherwise the sentence is shown at the form, and a conflict says the
    // entries survived.
    setErrors((current) => ({
      ...current,
      [scope]: Object.keys(fields).length
        ? fields
        : errorCode(error) === 'CONFLICT'
          ? { form: `${error.message} Your entries are kept.` }
          : { form: error.message },
    }));
  };
  const success = (scope: string, message: string, resetForm: boolean) => {
    if (!mounted.current) return;
    setErrors((current) => ({ ...current, [scope]: {} }));
    if (resetForm) setFormVersion((version) => version + 1);
    setEditor(null);
    setSaved(message);
    void refresh();
  };

  const create = trpc.hotelProperty.spaces.create.useMutation({
    onSuccess: (result) => success('new', `${result.space.name} is now a function space.`, true),
    onError: failure('new'),
  });
  const update = trpc.hotelProperty.spaces.update.useMutation();
  const setActive = trpc.hotelProperty.spaces.setActive.useMutation();
  const hold = trpc.hotelProperty.spaces.bookings.hold.useMutation();
  const release = trpc.hotelProperty.spaces.bookings.release.useMutation();

  const pending =
    create.isPending ||
    update.isPending ||
    setActive.isPending ||
    hold.isPending ||
    release.isPending;
  const busy = pending || refreshing;
  const rowCallbacks = (spaceId: string, message: string) => ({
    onSuccess: () => success(`row:${spaceId}`, message, false),
    onError: failure(`row:${spaceId}`),
  });

  if (unavailable)
    return (
      <SectionCard title="Choose a property again" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Your property access changed. Choose a property you can manage to continue.
        </p>
        <a
          href="/hotel/settings/spaces"
          className="mt-3 inline-flex min-h-11 items-center underline"
        >
          Choose a property
        </a>
      </SectionCard>
    );

  const active = view.spaces.filter((space) => space.active).length;
  const upcoming = view.bookings.length;

  return (
    <div className="space-y-6">
      {saved ? (
        <p className="text-sm text-text-muted" role="status">
          {saved}
        </p>
      ) : null}
      {refreshing ? (
        <p className="text-sm text-text-muted" role="status">
          Refreshing function spaces…
        </p>
      ) : null}
      {refreshFailed ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive" role="alert">
            Could not refresh the function spaces. Showing the last loaded list. Any confirmed save
            is still saved.
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

      {view.enabled ? null : (
        <SectionCard title="This property does not sell function space yet" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Its spaces are listed below for reading, but none can be added, changed or booked until
            function spaces are turned on in how the property operates — a venue has them on by
            default — and the workspace holds the Banquets and Events module.
          </p>
          <a
            href={`/hotel/settings/property?branchId=${encodeURIComponent(branchId)}`}
            className="mt-3 inline-flex min-h-11 items-center underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open how the property operates
          </a>
        </SectionCard>
      )}

      <SectionCard
        title={`Function spaces (${view.spaces.length})`}
        titleLevel={2}
        actions={
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Refresh spaces
          </Button>
        }
      >
        <p className="mb-4 font-mono text-xs tabular-nums text-text-muted">
          {active} active · {upcoming} upcoming {upcoming === 1 ? 'claim' : 'claims'} on their time
          · times shown in {view.timezone}.
        </p>
        {view.spaces.length === 0 ? (
          <p className="text-sm text-text-muted">
            No function spaces yet. A space is a hall, a lawn or a boardroom with the layouts it can
            be set in and how long it takes to turn around; add the first one below and the diary
            fills from its holds and functions.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left font-mono text-[0.6875rem] uppercase tracking-wide text-text-muted">
                  <th className="py-2 pr-3 font-semibold">Space</th>
                  <th className="py-2 pr-3 font-semibold">Layouts</th>
                  <th className="py-2 pr-3 font-semibold">Turnaround</th>
                  <th className="py-2 pr-3 text-right font-semibold">Pricing</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 text-right font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {view.spaces.map((space) => (
                  <SpaceRow
                    key={space.id}
                    space={space}
                    bookings={view.bookings.filter((booking) => booking.spaceId === space.id)}
                    kindOptions={view.kindOptions}
                    timezone={view.timezone}
                    enabled={view.enabled}
                    open={editor?.spaceId === space.id ? editor.kind : null}
                    rowErrors={errors[`row:${space.id}`] ?? {}}
                    busy={busy}
                    onEditor={(next) => {
                      setEditor(next);
                      setErrors((current) => ({ ...current, [`row:${space.id}`]: {} }));
                      setSaved(null);
                    }}
                    onSave={(fields) =>
                      update.mutate(
                        {
                          branchId,
                          id: space.id,
                          expectedUpdatedAt: space.updatedAt,
                          active: space.active,
                          ...fields,
                        },
                        rowCallbacks(space.id, 'Saved.')
                      )
                    }
                    onToggle={() =>
                      setActive.mutate(
                        {
                          branchId,
                          spaceId: space.id,
                          active: !space.active,
                          expectedUpdatedAt: space.updatedAt,
                        },
                        rowCallbacks(
                          space.id,
                          space.active
                            ? `${space.name} is retired. Its bookings are kept.`
                            : `${space.name} is active again.`
                        )
                      )
                    }
                    onHold={(fields) =>
                      hold.mutate(
                        { branchId, spaceId: space.id, ...fields },
                        rowCallbacks(
                          space.id,
                          fields.kind === 'FUNCTION'
                            ? `${space.name} is booked: ${fields.label}.`
                            : `${space.name} is held: ${fields.label}.`
                        )
                      )
                    }
                    onRelease={(booking) =>
                      release.mutate(
                        { branchId, bookingId: booking.id },
                        rowCallbacks(space.id, 'The hold is released; the time is free again.')
                      )
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {view.enabled ? (
        <SectionCard title="Add a function space" titleLevel={2}>
          <SpaceForm
            key={`new-${formVersion}`}
            idPrefix="new"
            space={null}
            errors={errors.new ?? {}}
            busy={busy || editor !== null}
            pending={create.isPending}
            onSubmit={(fields) => create.mutate({ branchId, ...fields })}
          />
        </SectionCard>
      ) : null}
    </div>
  );
}

type SpaceFields = {
  name: string;
  nameUr: string | null;
  layouts: { layout: string; capacity: number }[];
  pricing: {
    hourlyMinor?: number;
    dailyMinor?: number;
    perFunctionMinor?: number;
    minimumSpendMinor?: number;
  };
  setupMinutes: number;
  teardownMinutes: number;
};
type HoldFields = { label: string; kind: BookingKind; startsAt: Date; endsAt: Date };

function pricingLines(space: Space): string[] {
  const lines = [
    ['hourly', rupees(space.pricing.hourlyMinor)],
    ['per day', rupees(space.pricing.dailyMinor)],
    ['per function', rupees(space.pricing.perFunctionMinor)],
    ['minimum spend', rupees(space.pricing.minimumSpendMinor)],
  ] as const;
  return lines.filter(([, value]) => value !== null).map(([label, value]) => `${value} ${label}`);
}

function SpaceRow({
  space,
  bookings,
  kindOptions,
  timezone,
  enabled,
  open,
  rowErrors,
  busy,
  onEditor,
  onSave,
  onToggle,
  onHold,
  onRelease,
}: {
  space: Space;
  bookings: Booking[];
  kindOptions: HotelFunctionSpacesView['kindOptions'];
  timezone: string;
  enabled: boolean;
  open: 'edit' | 'hold' | null;
  rowErrors: Record<string, string>;
  busy: boolean;
  onEditor: (next: RowEditor) => void;
  onSave: (fields: SpaceFields) => void;
  onToggle: () => void;
  onHold: (fields: HoldFields) => void;
  onRelease: (booking: Booking) => void;
}) {
  const editTrigger = useRef<HTMLButtonElement>(null);
  const holdTrigger = useRef<HTMLButtonElement>(null);
  const lastTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    // The editor closed and took the focused control with it: hand focus back
    // to the action that opened it rather than letting it fall to the body.
    if (open !== null || typeof document === 'undefined') return;
    if (document.activeElement && document.activeElement !== document.body) return;
    lastTrigger.current?.focus();
  }, [open]);
  const toggle = (trigger: { current: HTMLButtonElement | null }, kind: 'edit' | 'hold') => {
    if (open === kind) {
      onEditor(null);
      return;
    }
    lastTrigger.current = trigger.current;
    onEditor({ kind, spaceId: space.id });
  };
  const prices = pricingLines(space);
  const closeEditor = () => onEditor(null);
  return (
    <>
      <tr className="hover:bg-surface-sunken">
        <td className="py-3 pr-3 align-top">
          <span className="font-semibold text-text-strong">{space.name}</span>
          {space.nameUr ? (
            <span className="ml-2 text-text-muted" lang="ur">
              {space.nameUr}
            </span>
          ) : null}
          <span className="block font-mono text-xs tabular-nums text-text-muted">
            Up to {space.maxCapacity} guests
          </span>
        </td>
        <td className="py-3 pr-3 align-top text-text-body">
          {space.layouts.map((layout) => `${layout.layout} ${layout.capacity}`).join(' · ')}
        </td>
        <td className="py-3 pr-3 align-top text-text-body tabular-nums">
          {space.setupMinutes} min before · {space.teardownMinutes} min after
        </td>
        <td className="py-3 pr-3 text-right align-top text-text-body tabular-nums">
          {prices.length === 0 ? (
            <span className="text-text-muted">No price yet</span>
          ) : (
            prices.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))
          )}
        </td>
        <td className="py-3 pr-3 align-top">
          <StatusPill
            status={space.active ? 'Active' : 'Retired'}
            tone={space.active ? 'success' : 'neutral'}
          />
        </td>
        <td className="py-3 align-top">
          <span className="flex flex-wrap justify-end gap-2">
            {enabled ? (
              <>
                <Button
                  ref={holdTrigger}
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  disabled={(busy && open !== 'hold') || !space.active}
                  aria-expanded={open === 'hold'}
                  aria-label={`${open === 'hold' ? 'Close booking of' : 'Book'} ${space.name}`}
                  onClick={() => toggle(holdTrigger, 'hold')}
                >
                  {open === 'hold' ? 'Close' : 'Book time'}
                </Button>
                <Button
                  ref={editTrigger}
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  disabled={busy && open !== 'edit'}
                  aria-expanded={open === 'edit'}
                  aria-label={`${open === 'edit' ? 'Close' : 'Edit'} ${space.name}`}
                  onClick={() => toggle(editTrigger, 'edit')}
                >
                  {open === 'edit' ? 'Close' : 'Edit'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  disabled={busy || open !== null}
                  aria-label={`${space.active ? 'Retire' : 'Restore'} ${space.name}`}
                  onClick={onToggle}
                >
                  {space.active ? 'Retire' : 'Restore'}
                </Button>
              </>
            ) : null}
          </span>
          {open === null && rowErrors.form ? (
            <p className="mt-2 text-right text-sm text-destructive" role="alert">
              {rowErrors.form}
            </p>
          ) : null}
        </td>
      </tr>
      <tr>
        <td colSpan={6} className="px-0 pb-3">
          <Diary
            space={space}
            bookings={bookings}
            timezone={timezone}
            enabled={enabled}
            busy={busy}
            onRelease={onRelease}
          />
        </td>
      </tr>
      {open === 'edit' ? (
        <tr>
          <td colSpan={6} className="bg-surface-sunken px-3 py-4">
            <SpaceForm
              idPrefix={`space-${space.id}`}
              space={space}
              errors={rowErrors}
              busy={busy}
              pending={busy}
              onSubmit={onSave}
              onCancel={closeEditor}
            />
          </td>
        </tr>
      ) : null}
      {open === 'hold' ? (
        <tr>
          <td colSpan={6} className="bg-surface-sunken px-3 py-4">
            <HoldForm
              space={space}
              kindOptions={kindOptions}
              timezone={timezone}
              errors={rowErrors}
              busy={busy}
              onSubmit={onHold}
              onCancel={closeEditor}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** The claims ahead on one space's time, each with its kind in words and a release for holds. */
function Diary({
  space,
  bookings,
  timezone,
  enabled,
  busy,
  onRelease,
}: {
  space: Space;
  bookings: Booking[];
  timezone: string;
  enabled: boolean;
  busy: boolean;
  onRelease: (booking: Booking) => void;
}) {
  if (bookings.length === 0) {
    return (
      <p className="text-xs text-text-muted" aria-label={`Diary of ${space.name}`}>
        Nothing booked ahead in {space.name}.
      </p>
    );
  }
  return (
    <ul className="space-y-1" aria-label={`Diary of ${space.name}`}>
      {bookings.map((booking) => (
        <li key={booking.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <StatusPill
            status={booking.kind === 'HOLD' ? 'Tentative hold' : 'Confirmed function'}
            tone={booking.kind === 'HOLD' ? 'warning' : 'info'}
          />
          <span className="tabular-nums text-text-body">
            {formatSpan(booking.startsAt, booking.endsAt, timezone)}
          </span>
          <span className="text-text-strong">{booking.label ?? 'Unlabelled claim'}</span>
          {enabled && booking.kind === 'HOLD' ? (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={busy}
              aria-label={`Release the hold ${booking.label ?? ''} on ${space.name}`.replace(
                /\s+/g,
                ' '
              )}
              onClick={() => onRelease(booking)}
            >
              Release hold
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SpaceForm({
  idPrefix,
  space,
  errors,
  busy,
  pending,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  space: Space | null;
  errors: Record<string, string>;
  busy: boolean;
  pending: boolean;
  onSubmit: (fields: SpaceFields) => void;
  onCancel?: () => void;
}) {
  // Only the inline editor takes focus when it appears; the always-present
  // add form must not steal it from the page.
  const firstControl = useOpeningFocus<HTMLInputElement>(space !== null);
  const [local, setLocal] = useState<Record<string, string>>({});
  const id = (name: string) => `${idPrefix}-${name}`;
  const message = (name: string) => errors[name] ?? local[name];
  const fieldProps = (name: string, hasHint = true) => ({
    'aria-invalid': Boolean(message(name)),
    'aria-describedby': message(name)
      ? `${id(name)}-error`
      : hasHint
        ? `${id(name)}-hint`
        : undefined,
    disabled: busy,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setLocal({});
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const minutes = {
      setupMinutes: Number(text('setupMinutes') || 0),
      teardownMinutes: Number(text('teardownMinutes') || 0),
    };
    const invalid = Object.entries(minutes)
      .filter(([, value]) => !Number.isInteger(value) || value < 0)
      .map(([field]) => [field, 'Enter a whole number of minutes.'] as const);
    if (invalid.length) {
      setLocal(Object.fromEntries(invalid));
      return;
    }
    onSubmit({
      name: text('name'),
      nameUr: text('nameUr') || null,
      layouts: parseLayouts(text('layouts')),
      pricing: {
        hourlyMinor: minorOf(text('hourly')),
        dailyMinor: minorOf(text('daily')),
        perFunctionMinor: minorOf(text('perFunction')),
        minimumSpendMinor: minorOf(text('minimumSpend')),
      },
      ...minutes,
    });
  };
  const price = (minor: number | undefined) => (minor === undefined ? '' : String(minor / 100));
  return (
    <form
      className="space-y-4"
      onSubmit={submit}
      onKeyDown={onCancel ? closeOnEscape(onCancel) : undefined}
      aria-busy={pending}
      aria-label={space ? `Edit ${space.name}` : 'Add a function space'}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field htmlFor={id('name')} label="Space name" error={message('name')}>
          <Input
            ref={firstControl}
            id={id('name')}
            name="name"
            className="min-h-11"
            defaultValue={space?.name ?? ''}
            {...fieldProps('name', false)}
            required
          />
        </Field>
        <Field
          htmlFor={id('nameUr')}
          label="Name in Urdu"
          error={message('nameUr')}
          hint="Optional. Shown wherever the property publishes in Urdu."
        >
          <Input
            id={id('nameUr')}
            name="nameUr"
            className="min-h-11"
            lang="ur"
            dir="rtl"
            defaultValue={space?.nameUr ?? ''}
            {...fieldProps('nameUr')}
          />
        </Field>
        <Field
          htmlFor={id('layouts')}
          label="Layouts and capacities"
          error={message('layouts')}
          hint="One per comma, each with its guest count, e.g. Theatre 300, Banquet 220, U-shape 60."
        >
          <Input
            id={id('layouts')}
            name="layouts"
            className="min-h-11"
            defaultValue={space ? formatLayouts(space.layouts) : ''}
            {...fieldProps('layouts')}
            required
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field
            htmlFor={id('setupMinutes')}
            label="Setup (min)"
            error={message('setupMinutes')}
            hint="Held before every booking."
          >
            <Input
              id={id('setupMinutes')}
              name="setupMinutes"
              className="min-h-11"
              type="number"
              min={0}
              max={1440}
              defaultValue={space?.setupMinutes ?? 0}
              {...fieldProps('setupMinutes')}
            />
          </Field>
          <Field
            htmlFor={id('teardownMinutes')}
            label="Teardown (min)"
            error={message('teardownMinutes')}
            hint="Held after every booking."
          >
            <Input
              id={id('teardownMinutes')}
              name="teardownMinutes"
              className="min-h-11"
              type="number"
              min={0}
              max={1440}
              defaultValue={space?.teardownMinutes ?? 0}
              {...fieldProps('teardownMinutes')}
            />
          </Field>
        </div>
      </div>
      <fieldset
        className="min-w-0 space-y-3"
        aria-describedby={message('pricing') ? `${id('pricing')}-error` : `${id('pricing')}-hint`}
        disabled={busy}
      >
        <legend className={labelClass}>Pricing (PKR)</legend>
        <p className="text-xs text-text-muted" id={`${id('pricing')}-hint`}>
          Leave a basis empty when the space is not sold that way. Whole rupees or rupees and paisa.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {(
            [
              ['hourly', 'Hourly rate', space?.pricing.hourlyMinor],
              ['daily', 'Daily rate', space?.pricing.dailyMinor],
              ['perFunction', 'Per function', space?.pricing.perFunctionMinor],
              ['minimumSpend', 'Minimum spend', space?.pricing.minimumSpendMinor],
            ] as const
          ).map(([name, label, minor]) => (
            <Field key={name} htmlFor={id(name)} label={label}>
              <Input
                id={id(name)}
                name={name}
                className="mt-1 min-h-11"
                type="number"
                min={0}
                step="0.01"
                defaultValue={price(minor)}
                disabled={busy}
              />
            </Field>
          ))}
        </div>
        {message('pricing') ? (
          <p className="text-sm text-destructive" id={`${id('pricing')}-error`} role="alert">
            {message('pricing')}
          </p>
        ) : null}
      </fieldset>
      {errors.form ? (
        <p className="text-sm text-destructive" role="alert">
          {errors.form}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-11" disabled={busy}>
          {pending ? 'Saving…' : space ? 'Save space' : 'Add space'}
        </Button>
        {onCancel ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** Claim a space's time: a label, the kind, and a span in the property's own zone. */
function HoldForm({
  space,
  kindOptions,
  timezone,
  errors,
  busy,
  onSubmit,
  onCancel,
}: {
  space: Space;
  kindOptions: HotelFunctionSpacesView['kindOptions'];
  timezone: string;
  errors: Record<string, string>;
  busy: boolean;
  onSubmit: (fields: HoldFields) => void;
  onCancel: () => void;
}) {
  const firstControl = useOpeningFocus<HTMLInputElement>(true);
  const [local, setLocal] = useState<Record<string, string>>({});
  const prefix = `hold-${space.id}`;
  const message = (name: string) => errors[name] ?? local[name];
  const fieldProps = (name: string, hasHint = true) => ({
    'aria-invalid': Boolean(message(name)),
    'aria-describedby': message(name)
      ? `${prefix}-${name}-error`
      : hasHint
        ? `${prefix}-${name}-hint`
        : undefined,
    disabled: busy,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setLocal({});
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const startsAt = zonedInputToDate(text('startsAt'), timezone);
    const endsAt = zonedInputToDate(text('endsAt'), timezone);
    const invalid: Record<string, string> = {};
    if (!startsAt) invalid.startsAt = 'Enter the date and time the booking starts.';
    if (!endsAt) invalid.endsAt = 'Enter the date and time the booking ends.';
    else if (startsAt && endsAt.getTime() <= startsAt.getTime())
      invalid.endsAt = 'A booking ends after it starts.';
    if (Object.keys(invalid).length) {
      setLocal(invalid);
      return;
    }
    onSubmit({
      label: text('label'),
      kind: text('kind') as BookingKind,
      startsAt: startsAt!,
      endsAt: endsAt!,
    });
  };
  return (
    <form
      className="space-y-4"
      onSubmit={submit}
      onKeyDown={closeOnEscape(onCancel)}
      aria-busy={busy}
      aria-label={`Book ${space.name}`}
    >
      <p className="text-sm text-text-body">
        {space.name} needs {space.setupMinutes} minutes before and {space.teardownMinutes} after
        each booking; the space is refused when those would overlap another claim.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          htmlFor={`${prefix}-label`}
          label="What for"
          error={message('label')}
          hint="Shown in the diary, e.g. Khan walima — tentative."
        >
          <Input
            ref={firstControl}
            id={`${prefix}-label`}
            name="label"
            className="min-h-11"
            {...fieldProps('label')}
            required
          />
        </Field>
        <Field htmlFor={`${prefix}-kind`} label="Claim" error={message('kind')}>
          <StudioSelect
            id={`${prefix}-kind`}
            name="kind"
            className={selectClass}
            defaultValue={kindOptions[0]?.value}
            {...fieldProps('kind', false)}
          >
            {kindOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </StudioSelect>
        </Field>
        <Field
          htmlFor={`${prefix}-startsAt`}
          label="From"
          error={message('startsAt')}
          hint={`Local time at the property (${timezone}).`}
        >
          <Input
            id={`${prefix}-startsAt`}
            name="startsAt"
            className="min-h-11"
            type="datetime-local"
            {...fieldProps('startsAt')}
            required
          />
        </Field>
        <Field
          htmlFor={`${prefix}-endsAt`}
          label="Until"
          error={message('endsAt')}
          hint="The booking itself; setup and teardown are added around it."
        >
          <Input
            id={`${prefix}-endsAt`}
            name="endsAt"
            className="min-h-11"
            type="datetime-local"
            {...fieldProps('endsAt')}
            required
          />
        </Field>
      </div>
      {errors.form ? (
        <p className="text-sm text-destructive" role="alert">
          {errors.form}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-11" disabled={busy}>
          {busy ? 'Saving…' : 'Book the space'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
