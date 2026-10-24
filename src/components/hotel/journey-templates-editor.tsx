'use client';

/**
 * UPS-04 — the guest messages surface: every version of what the property
 * sends a guest at each step of a stay, an editor for one message at a time,
 * and a preview of a version against sample values.
 *
 * Three rules, the same ones the other hotel settings surfaces follow:
 *
 * - **No raw identifiers.** Moments, channels, languages and statuses are all
 *   named for an operator; the enum values never reach the page (UX rule 1).
 * - **Errors land on fields.** A refused placeholder comes back as
 *   `data.validation.body`, so it appears under the message box and the box is
 *   marked `aria-invalid`; a conflict keeps the operator's text (UX rule 11).
 * - **Nothing is a dead end.** The placeholder vocabulary for the selected
 *   moment is listed beside the editor, so "that placeholder is not available"
 *   is immediately followed by the ones that are; a version that vanished under
 *   the editor offers its kept text as a new draft (UX rule 13).
 *
 * Every call names the property the page was opened for; the server re-checks
 * access on every one. Every write also names the version it was made from: a
 * save, the draft version its text was started from (a refresh never moves
 * that); an approval, the version and wording on screen and the approval it
 * retires; a retirement, the version shown and, for a draft, its wording. A
 * conflict reloads the list, and a draft saved again under typed text is shown
 * beside it until the operator keeps their text or takes the saved wording.
 * Nothing on this page sends.
 * Approving is the last step here; the send belongs to H4.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { useSession } from 'next-auth/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type HotelJourneyView = RouterOutputs['hotelProperty']['journeyTemplates']['list'];
type JourneyTemplate = HotelJourneyView['templates'][number];
type JourneyPreview = RouterOutputs['hotelProperty']['journeyTemplates']['preview'];
type DraftCopy = Pick<JourneyTemplate, 'subject' | 'body'>;
type DraftKey = Pick<JourneyTemplate, 'moment' | 'channel' | 'language'>;
/** A stored version as an editor read it: what a write says it read. */
type DraftBase = Pick<JourneyTemplate, 'updatedAt' | 'subject' | 'body'>;
/** Editor text, and the stored draft it was started from (none for a new draft). */
type DraftBuffer = DraftKey & DraftCopy & { base: DraftBase | null };
type JourneySelection = { branchId: string; organizationId: string; userId: string };

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const controlClass =
  'mt-1 min-h-11 w-full rounded-md border border-border-strong bg-surface-card px-3 py-2 text-sm text-text-body outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive';

function validationErrors(error: unknown): Record<string, string> {
  const validation = (error as { data?: { validation?: unknown } } | null)?.data?.validation;
  if (!validation || typeof validation !== 'object') return {};
  return Object.fromEntries(
    Object.entries(validation as Record<string, unknown>)
      .map(([field, message]) => [
        field,
        (Array.isArray(message) ? message : [message])
          .filter((value) => typeof value === 'string' && value.trim())
          .join(' '),
      ])
      .filter(([, message]) => message)
  );
}

const errorCode = (error: unknown) => (error as { data?: { code?: string } } | null)?.data?.code;
const accessDenied = (error: unknown) =>
  ['FORBIDDEN', 'UNAUTHORIZED'].includes(errorCode(error) ?? '');

const baseOf = (row: DraftBase): DraftBase => ({
  updatedAt: row.updatedAt,
  subject: row.subject,
  body: row.body,
});
/** Whether `row` is still the stored version `base` was read as. */
function isVersion(base: DraftBase | null, row: DraftBase): boolean {
  return (
    !!base &&
    new Date(base.updatedAt).getTime() === new Date(row.updatedAt).getTime() &&
    base.subject === row.subject &&
    base.body === row.body
  );
}
/** Text that is exactly the version it was started from: nothing typed to keep. */
const untouched = (buffer: DraftBuffer) =>
  !!buffer.base && buffer.subject === buffer.base.subject && buffer.body === buffer.base.body;

/** What each refused write adds once the list is being reloaded after a conflict. */
const AFTER_CONFLICT: Record<'save' | 'approve' | 'retire', string> = {
  save: 'Your editor text has been kept.',
  approve: 'Nothing was approved. Read the current wording before approving it.',
  retire: 'Nothing was retired. Check the current version before retiring it.',
};

/** `21:00` from a minute of the day. */
export function minutesToClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** The placeholders a piece of copy names, in order; a broken tag names nothing. */
export function placeholdersIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
    const name = match[1]!;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** Readable sample values for a preview; a name outside the table gets a generic one. */
const SAMPLE_VALUES: Record<string, string> = {
  guest_name: 'Sara Khan',
  property_name: 'Fathom Grand',
  property_phone: '+92 42 111 000 000',
  reservation_code: 'FG-20481',
  check_in_date: '24 Oct 2026',
  check_in_time: '14:00',
  check_out_date: '27 Oct 2026',
  check_out_time: '12:00',
  nights: '3',
  room_type: 'Deluxe King',
  total_amount: 'PKR 54,000',
  balance_due: 'PKR 18,000',
  offer_name: 'Late check-out',
  offer_description: 'keep your room until 16:00',
  offer_price: 'PKR 3,500',
  offer_link: 'https://example.com/offer',
  offer_expires_at: '23 Oct 2026, 18:00',
  checkin_link: 'https://example.com/check-in',
  checkin_expires_at: '24 Oct 2026, 14:00',
  room_number: '412',
  wifi_network: 'FathomGuest',
  wifi_password: 'welcome412',
  stay_page_link: 'https://example.com/stay',
  checkout_link: 'https://example.com/checkout',
  invoice_number: 'INV-2026-0931',
  invoice_total: 'PKR 61,250',
  invoice_link: 'https://example.com/invoice',
  review_link: 'https://example.com/review',
};
export function sampleValueFor(name: string): string {
  return SAMPLE_VALUES[name] ?? `Sample ${name.replaceAll('_', ' ')}`;
}

export function HotelJourneyTemplatesEditor({
  initial,
  selection,
}: {
  initial: HotelJourneyView;
  selection: JourneySelection;
}) {
  const { data: session } = useSession();
  if (
    session?.user.id !== selection.userId ||
    session.user.organizationId !== selection.organizationId
  ) {
    return (
      <SectionCard title="Reload the guest messages" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Your signed-in identity changed. Choose a property again to continue.
        </p>
        <a
          href="/hotel/settings/journey"
          className="mt-3 inline-flex min-h-11 items-center underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Choose a property
        </a>
      </SectionCard>
    );
  }
  return (
    <SelectedJourneyTemplates
      key={`${selection.organizationId}:${selection.userId}:${selection.branchId}`}
      initial={initial}
      branchId={selection.branchId}
    />
  );
}

function SelectedJourneyTemplates({
  initial,
  branchId,
}: {
  initial: HotelJourneyView;
  branchId: string;
}) {
  const [view, setView] = useState<HotelJourneyView>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial.templates[0]?.id ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [copies, setCopies] = useState<Record<string, DraftBuffer>>({});
  const [replacements, setReplacements] = useState<Record<string, boolean>>({});
  const [newKey, setNewKey] = useState<DraftKey>({
    moment: initial.moments[0]!.value,
    channel: initial.channels[0]!.value,
    language: initial.languages[0]!.value,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [sampleValues, setSampleValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ id: string; result: JourneyPreview } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
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
    setRefreshError(null);
    try {
      // A saved change must be reflected at once, past the provider's query cache.
      const refreshed = await utils.hotelProperty.journeyTemplates.list.fetch(
        { branchId },
        { staleTime: 0 }
      );
      if (!mounted.current || request !== generation.current) return;
      setCopies((current) => {
        const next: Record<string, DraftBuffer> = {};
        // A version the refreshed list no longer carries keeps its editor text.
        for (const template of view.templates)
          if (!refreshed.templates.some((row) => row.id === template.id))
            next[template.id] = {
              moment: template.moment,
              channel: template.channel,
              language: template.language,
              subject: template.subject,
              body: template.body,
              base: null,
            };
        // Typed text is kept; text nobody typed into follows the stored
        // version, so a colleague's change shows instead of the words it replaced.
        for (const [id, buffer] of Object.entries(current))
          if (!untouched(buffer)) next[id] = buffer;
        return next;
      });
      setView(refreshed);
    } catch (error) {
      if (!mounted.current || request !== generation.current) return;
      if (accessDenied(error) || errorCode(error) === 'NOT_FOUND') setUnavailable(true);
      else
        setRefreshError('The message list could not be refreshed. Your editor text has been kept.');
    } finally {
      if (mounted.current && request === generation.current) setRefreshing(false);
    }
  };

  const selected = view.templates.find((template) => template.id === selectedId) ?? null;
  const key: DraftKey = selected ?? newKey;
  const copyKey = selectedId ?? 'new';

  const onError = (action: keyof typeof AFTER_CONFLICT, error: { message: string }) => {
    if (!mounted.current) return;
    if (accessDenied(error)) {
      setUnavailable(true);
      return;
    }
    const fields = validationErrors(error);
    const conflict = errorCode(error) === 'CONFLICT';
    // A refusal on a field the form is not showing still has to be said.
    const unrendered = Object.entries(fields)
      .filter(([field]) => field !== 'body' && !(field === 'subject' && key.channel === 'EMAIL'))
      .map(([, message]) => message);
    setNotice(null);
    setErrors(
      Object.keys(fields).length
        ? { ...fields, ...(unrendered.length ? { form: unrendered.join(' ') } : {}) }
        : {
            form: conflict
              ? `${error.message} ${AFTER_CONFLICT[action]}`
              : error.message || 'The action could not be completed. Please try again.',
          }
    );
    // The list this page holds is out of date: reload it, so the version shown
    // next is the one that stands now, before anything is tried again.
    if (conflict) void refresh();
  };

  const save = trpc.hotelProperty.journeyTemplates.save.useMutation({
    onSuccess: async (template) => {
      if (!mounted.current) return;
      setErrors({});
      setNotice('Draft saved. A property administrator can review it for approval.');
      setView((current) => ({
        ...current,
        templates: [template, ...current.templates.filter((row) => row.id !== template.id)],
      }));
      // The saved words are the stored version now; the editor shows that.
      setCopies((current) => {
        const next = { ...current };
        delete next[template.id];
        return next;
      });
      setSelectedId(template.id);
      setPreview(null);
      await refresh();
    },
    onError: (error) => onError('save', error),
  });

  const approve = trpc.hotelProperty.journeyTemplates.approve.useMutation({
    onSuccess: async (template) => {
      if (!mounted.current) return;
      setErrors({});
      setNotice('Approved. This wording may now be sent; nothing is sent from this page.');
      setView((current) => ({
        ...current,
        templates: current.templates.map((row) => (row.id === template.id ? template : row)),
      }));
      if (selectedId) setReplacements((current) => ({ ...current, [selectedId]: false }));
      setPreview(null);
      await refresh();
    },
    onError: (error) => onError('approve', error),
  });

  const retire = trpc.hotelProperty.journeyTemplates.retire.useMutation({
    onSuccess: async (template) => {
      if (!mounted.current) return;
      setErrors({});
      setNotice('Retired. You can create a replacement draft from this version.');
      setView((current) => ({
        ...current,
        templates: current.templates.map((row) => (row.id === template.id ? template : row)),
      }));
      if (selectedId) setReplacements((current) => ({ ...current, [selectedId]: false }));
      setPreview(null);
      await refresh();
    },
    onError: (error) => onError('retire', error),
  });

  const moment = view.moments.find((entry) => entry.value === key.moment);
  const channelLabel = (value: JourneyTemplate['channel']) =>
    view.channels.find((entry) => entry.value === value)?.label ?? value;
  const languageLabel = (value: JourneyTemplate['language']) =>
    view.languages.find((entry) => entry.value === value)?.label ?? value;
  const editable = !selectedId || selected?.status === 'DRAFT' || !!replacements[copyKey];
  const copy: DraftCopy =
    !editable && selected ? selected : (copies[copyKey] ?? selected ?? { subject: '', body: '' });
  const pending = save.isPending || approve.isPending || retire.isPending || refreshing;
  const unsaved =
    selected &&
    (copy.body !== selected.body || (key.channel === 'EMAIL' && copy.subject !== selected.subject));
  const versions = view.templates
    .filter(
      (template) =>
        template.moment === key.moment &&
        template.channel === key.channel &&
        template.language === key.language
    )
    .sort((a, b) => b.version - a.version);
  const latestMatching = versions[0];
  // A draft is changed in its own editor, where its words are on screen: a
  // replacement of approved wording, or a new draft, of a message that already
  // has one opens that draft instead of writing over words nobody here read.
  const matchingDraft =
    (!selected || selected.status !== 'DRAFT') && latestMatching?.status === 'DRAFT'
      ? latestMatching
      : null;
  /** The approval an approval here would retire, as this page shows it. */
  const standingApproval = versions.find((template) => template.status === 'APPROVED') ?? null;
  const openMatchingDraft = () => {
    if (!matchingDraft) return;
    setSelectedId(matchingDraft.id);
    setErrors({});
    setNotice(`Opened draft version ${matchingDraft.version}. Your editor text has been kept.`);
  };
  const buffer = selected ? copies[selected.id] : undefined;
  // The stored draft moved on since the editor's text was started from it. A
  // save would be refused, so the page shows the saved wording and asks.
  const stale = selected?.status === 'DRAFT' && !!buffer && !isVersion(buffer.base, selected);

  const updateCopy = (change: Partial<DraftCopy>) => {
    setCopies((current) => {
      const existing = current[copyKey];
      return {
        ...current,
        [copyKey]: {
          moment: key.moment,
          channel: key.channel,
          language: key.language,
          subject: copy.subject,
          body: copy.body,
          // The stored draft this text starts from, kept once set: a refresh
          // that brings a colleague's edit never quietly rebases typed text.
          base: existing ? existing.base : selected?.status === 'DRAFT' ? baseOf(selected) : null,
          ...change,
        },
      };
    });
    setNotice(null);
  };
  const keepMyText = () => {
    if (!selected) return;
    setCopies((current) => {
      const kept = current[selected.id];
      return kept ? { ...current, [selected.id]: { ...kept, base: baseOf(selected) } } : current;
    });
    setErrors({});
    setNotice(
      `Your text is kept. Saving it replaces the wording saved in version ${selected.version}.`
    );
  };
  const useSavedWording = () => {
    if (!selected) return;
    setCopies((current) => {
      const next = { ...current };
      delete next[selected.id];
      return next;
    });
    setErrors({});
    setNotice(`Showing the wording saved in version ${selected.version}.`);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editable || pending || refreshError || stale || (selectedId && !selected)) return;
    if (matchingDraft) {
      openMatchingDraft();
      return;
    }
    setErrors({});
    setNotice(null);
    // The draft version this text was started from: the save rewrites that
    // version or nothing. A new draft, or a replacement, rewrites no draft.
    const base = selected?.status === 'DRAFT' ? (buffer ? buffer.base : baseOf(selected)) : null;
    save.mutate({
      branchId,
      moment: key.moment,
      channel: key.channel,
      language: key.language,
      subject: key.channel === 'EMAIL' ? (copy.subject ?? '').trim() : null,
      body: copy.body.trim(),
      ...(base
        ? {
            expectedUpdatedAt: base.updatedAt,
            expectedSubject: base.subject,
            expectedBody: base.body,
          }
        : {}),
    });
  };

  const select = (id: string | null) => {
    setSelectedId(id);
    setErrors({});
    setNotice(null);
    setPreview(null);
    setPreviewError(null);
  };

  // The preview renders the STORED version, so its placeholders are the stored
  // copy's, not the editor's unsaved text.
  const previewPlaceholders = selected
    ? [...placeholdersIn(selected.subject ?? ''), ...placeholdersIn(selected.body)].filter(
        (name, index, all) => all.indexOf(name) === index
      )
    : [];
  const runPreview = async () => {
    if (!selected || pending || previewing) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const result = await utils.hotelProperty.journeyTemplates.preview.fetch(
        {
          branchId,
          id: selected.id,
          context: Object.fromEntries(
            previewPlaceholders.map((name) => [name, sampleValues[name] ?? sampleValueFor(name)])
          ),
        },
        { staleTime: 0 }
      );
      if (mounted.current) setPreview({ id: selected.id, result });
    } catch (error) {
      if (!mounted.current) return;
      if (accessDenied(error)) {
        setUnavailable(true);
        return;
      }
      const fields = validationErrors(error);
      setPreview(null);
      setPreviewError(
        fields.context ||
          Object.values(fields).join(' ') ||
          (error as { message?: string }).message ||
          'The preview could not be rendered.'
      );
    } finally {
      if (mounted.current) setPreviewing(false);
    }
  };

  if (unavailable)
    return (
      <SectionCard title="Choose a property again" titleLevel={2}>
        <p className="text-sm text-text-muted">
          Your property access changed. Choose a property whose guest messages you may work on to
          continue.
        </p>
        <a
          href="/hotel/settings/journey"
          className="mt-3 inline-flex min-h-11 items-center underline"
        >
          Choose a property
        </a>
      </SectionCard>
    );

  const approvedCount = view.templates.filter((template) => template.status === 'APPROVED').length;
  const draftCount = view.templates.filter((template) => template.status === 'DRAFT').length;

  return (
    <div className="space-y-6">
      {refreshing ? (
        <p className="text-sm text-text-muted" role="status">
          Refreshing message list…
        </p>
      ) : null}
      {refreshError ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive" role="alert">
            {refreshError}
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={pending}
            onClick={() => void refresh()}
          >
            Retry refresh
          </Button>
        </div>
      ) : null}

      <SectionCard title="Quiet hours" titleLevel={2}>
        <p className="text-sm text-text-body">
          {view.quietHours
            ? `Offers and review requests are held between ${minutesToClock(view.quietHours.startMinute)} and ${minutesToClock(view.quietHours.endMinute)}, ${view.propertyTimezone} time. Booking confirmations, check-in details, departure notes and invoices go out at once.`
            : 'This property observes no quiet hours: every approved message may go out at any time of day.'}
        </p>
        <p className="mt-2 text-xs text-text-muted">
          Quiet hours come from the property’s journey settings. This page manages drafts and
          approvals; it does not send messages or change quiet hours.
        </p>
      </SectionCard>

      <SectionCard
        title={`Guest messages (${view.templates.length})`}
        titleLevel={2}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={pending}
              onClick={() => void refresh()}
            >
              Refresh messages
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              disabled={pending}
              onClick={() => select(null)}
            >
              New draft
            </Button>
          </>
        }
      >
        <p className="mb-4 font-mono text-xs tabular-nums text-text-muted">
          {approvedCount} approved · {draftCount} in draft. A message is one moment in one language
          on one channel; approving a new version retires the one before it.
        </p>
        {!view.templates.length ? (
          <p className="text-sm text-text-muted">
            No guest messages yet. Choose a moment, channel and language below to create the first
            draft.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left font-mono text-[0.6875rem] uppercase tracking-wide text-text-muted">
                  <th className="py-2 pr-3 font-semibold">Moment</th>
                  <th className="py-2 pr-3 font-semibold">Channel</th>
                  <th className="py-2 pr-3 font-semibold">Language</th>
                  <th className="py-2 pr-3 text-right font-semibold">Version</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 text-right font-semibold">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {view.templates.map((template) => {
                  const current = template.id === selectedId;
                  return (
                    <tr
                      key={template.id}
                      className={current ? 'bg-surface-sunken' : 'hover:bg-surface-sunken'}
                      aria-current={current ? 'true' : undefined}
                    >
                      <td className="py-3 pr-3 align-top font-semibold text-text-strong">
                        {view.moments.find((entry) => entry.value === template.moment)?.label}
                      </td>
                      <td className="py-3 pr-3 align-top text-text-body">
                        {channelLabel(template.channel)}
                      </td>
                      <td className="py-3 pr-3 align-top text-text-body">
                        {languageLabel(template.language)}
                      </td>
                      <td className="py-3 pr-3 text-right align-top font-mono text-xs tabular-nums text-text-muted">
                        {template.version}
                      </td>
                      <td className="py-3 pr-3 align-top">
                        <StatusPill status={view.statusLabels[template.status]} />
                      </td>
                      <td className="py-3 text-right align-top">
                        <Button
                          type="button"
                          variant="ghost"
                          className="min-h-11"
                          disabled={pending}
                          aria-current={current ? 'true' : undefined}
                          onClick={() => select(template.id)}
                        >
                          {current ? 'Opened' : 'Open'}
                          <span className="sr-only">
                            {' '}
                            {
                              view.moments.find((entry) => entry.value === template.moment)?.label
                            }, {channelLabel(template.channel)}, {languageLabel(template.language)}{' '}
                            version {template.version}
                          </span>
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {selectedId && !selected ? (
        <SectionCard title="This version is no longer available" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Your editor text is kept for this session. Choose another version or create a new draft.
          </p>
          {copies[copyKey] ? (
            <Button
              type="button"
              className="mt-3 min-h-11"
              onClick={() => {
                const kept = copies[copyKey]!;
                setCopies((current) => ({ ...current, new: { ...kept, base: null } }));
                setNewKey({ moment: kept.moment, channel: kept.channel, language: kept.language });
                select(null);
              }}
            >
              Use kept text in a new draft
            </Button>
          ) : null}
        </SectionCard>
      ) : moment ? (
        <SectionCard
          title={
            selected
              ? `${moment.label} — ${channelLabel(key.channel)}, ${languageLabel(key.language)}`
              : 'Create a guest message'
          }
          titleLevel={2}
          actions={
            selected ? (
              <StatusPill
                status={view.statusLabels[selected.status]}
                label={`${view.statusLabels[selected.status]} · version ${selected.version}`}
              />
            ) : null
          }
        >
          <form className="space-y-4" onSubmit={onSubmit} aria-label="Guest message">
            {!selected ? (
              <div className="grid gap-4 sm:grid-cols-3">
                {(['moment', 'channel', 'language'] as const).map((field) => (
                  <div key={field} className="min-w-0">
                    <label className={labelClass} htmlFor={`journey-${field}`}>
                      {field === 'moment'
                        ? 'Journey moment'
                        : field === 'channel'
                          ? 'Channel'
                          : 'Language'}
                    </label>
                    <select
                      id={`journey-${field}`}
                      className={controlClass}
                      value={newKey[field]}
                      disabled={pending}
                      onChange={(event) => {
                        setNewKey((current) => ({ ...current, [field]: event.target.value }));
                        setErrors({});
                      }}
                    >
                      {view[
                        field === 'moment'
                          ? 'moments'
                          : field === 'channel'
                            ? 'channels'
                            : 'languages'
                      ].map((entry) => (
                        <option key={entry.value} value={entry.value}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            ) : null}
            {matchingDraft ? (
              <p className="text-sm text-text-muted">
                Draft version {matchingDraft.version} already exists for this moment, channel and
                language.{' '}
                {selected
                  ? 'Open it to continue with its kept text.'
                  : 'Open it to read and change its wording.'}
              </p>
            ) : selected && selected.status !== 'DRAFT' && editable ? (
              <p className="text-sm text-text-muted">
                Replacement draft based on version {selected.version}. The original wording is
                unchanged.
              </p>
            ) : null}
            {!selected && !matchingDraft ? (
              <p className="text-xs text-text-muted">
                A moment, channel and language that already have a draft are changed in that draft.
              </p>
            ) : null}
            {key.channel === 'EMAIL' ? (
              <div className="min-w-0">
                <label className={labelClass} htmlFor="subject">
                  Subject line
                </label>
                <Input
                  id="subject"
                  name="subject"
                  value={copy.subject ?? ''}
                  onChange={(event) => updateCopy({ subject: event.target.value })}
                  className="mt-1 min-h-11"
                  dir={key.language === 'UR' ? 'rtl' : 'ltr'}
                  lang={key.language === 'UR' ? 'ur' : 'en'}
                  aria-invalid={Boolean(errors.subject)}
                  aria-describedby={errors.subject ? 'subject-error' : undefined}
                  readOnly={!editable}
                  disabled={pending}
                  required
                />
                {errors.subject ? (
                  <p className="mt-1 text-sm text-destructive" id="subject-error" role="alert">
                    {errors.subject}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="min-w-0">
              <label className={labelClass} htmlFor="body">
                Message
              </label>
              <textarea
                id="body"
                name="body"
                value={copy.body}
                onChange={(event) => updateCopy({ body: event.target.value })}
                rows={8}
                dir={key.language === 'UR' ? 'rtl' : 'ltr'}
                lang={key.language === 'UR' ? 'ur' : 'en'}
                aria-invalid={Boolean(errors.body)}
                aria-describedby={errors.body ? 'body-error' : 'body-hint'}
                readOnly={!editable}
                disabled={pending}
                required
                className={controlClass}
              />
              {errors.body ? (
                <p className="mt-1 text-sm text-destructive" id="body-error" role="alert">
                  {errors.body}
                </p>
              ) : (
                <p className="mt-1 text-xs text-text-muted" id="body-hint">
                  Available at this moment:{' '}
                  {moment.placeholders.map((name) => `{{${name}}}`).join(', ')}.
                </p>
              )}
            </div>

            {stale && selected ? (
              <div
                role="region"
                aria-labelledby="saved-wording-title"
                className="space-y-3 rounded-md border border-border-subtle bg-surface-sunken p-4"
              >
                <p className={labelClass} id="saved-wording-title">
                  Saved wording · version {selected.version}
                </p>
                <p className="text-sm text-text-body">
                  This draft was saved again after you started editing it. Your text is kept in the
                  editor above; this is the wording saved now. Choose which to continue with before
                  saving.
                </p>
                {key.channel === 'EMAIL' ? (
                  <p className="text-sm">
                    <span className={labelClass}>Subject</span>
                    <span
                      className="mt-1 block font-semibold text-text-strong"
                      dir={key.language === 'UR' ? 'rtl' : 'ltr'}
                      lang={key.language === 'UR' ? 'ur' : 'en'}
                    >
                      {selected.subject}
                    </span>
                  </p>
                ) : null}
                <div>
                  <span className={labelClass}>Message</span>
                  <p
                    className="mt-1 whitespace-pre-wrap text-sm text-text-body"
                    dir={key.language === 'UR' ? 'rtl' : 'ltr'}
                    lang={key.language === 'UR' ? 'ur' : 'en'}
                  >
                    {selected.body}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={pending}
                    onClick={keepMyText}
                  >
                    Keep my text
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={pending}
                    onClick={useSavedWording}
                  >
                    Use the saved wording
                  </Button>
                </div>
              </div>
            ) : null}

            {errors.form ? (
              <p className="text-sm text-destructive" role="alert">
                {errors.form}
              </p>
            ) : notice ? (
              <p className="text-sm text-text-muted" role="status">
                {notice}
              </p>
            ) : selected?.status === 'APPROVED' && !editable && !matchingDraft ? (
              <p className="text-sm text-text-muted">
                Approved wording cannot be edited. Save a new draft to replace it — approving the
                new version retires this one.
              </p>
            ) : selected?.status === 'RETIRED' && !editable ? (
              <p className="text-sm text-text-muted">
                This version is retired and kept as a record of what the property once sent.
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {matchingDraft ? (
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={pending || !!refreshError}
                  onClick={openMatchingDraft}
                >
                  Open draft version {matchingDraft.version}
                </Button>
              ) : editable ? (
                <Button
                  type="submit"
                  className="min-h-11"
                  disabled={pending || !!refreshError || stale}
                >
                  {save.isPending
                    ? 'Saving…'
                    : selected && selected.status !== 'DRAFT'
                      ? 'Save as a new draft'
                      : 'Save draft'}
                </Button>
              ) : selected ? (
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={pending || !!refreshError}
                  onClick={() => {
                    setReplacements((current) => ({ ...current, [selected.id]: true }));
                    setErrors({});
                    setNotice(null);
                  }}
                >
                  Create replacement draft
                </Button>
              ) : null}
              {selected && selected.status !== 'DRAFT' && editable ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={pending}
                  onClick={() =>
                    setReplacements((current) => ({ ...current, [selected.id]: false }))
                  }
                >
                  View original version
                </Button>
              ) : null}
              {view.canApprove && selected?.status === 'DRAFT' ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={pending || !!refreshError || !!unsaved || stale}
                  onClick={() =>
                    // Approval stands behind the words on screen: the server
                    // refuses it if they are not, or no longer, the stored ones.
                    approve.mutate({
                      branchId,
                      id: selected.id,
                      expectedUpdatedAt: selected.updatedAt,
                      expectedSubject: selected.subject,
                      expectedBody: selected.body,
                      expectedApprovedId: standingApproval?.id ?? null,
                    })
                  }
                >
                  {approve.isPending ? 'Approving…' : 'Approve'}
                </Button>
              ) : null}
              {view.canApprove &&
              selected &&
              selected.status !== 'RETIRED' &&
              !replacements[selected.id] ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={pending || !!refreshError || !!unsaved || stale}
                  onClick={() =>
                    retire.mutate({
                      branchId,
                      id: selected.id,
                      expectedUpdatedAt: selected.updatedAt,
                      // A colleague's save can share a draft's time: retiring a
                      // draft names the words on screen too.
                      ...(selected.status === 'DRAFT'
                        ? { expectedSubject: selected.subject, expectedBody: selected.body }
                        : {}),
                    })
                  }
                >
                  {retire.isPending ? 'Retiring…' : 'Retire'}
                </Button>
              ) : null}
            </div>
            {unsaved && !stale && selected?.status === 'DRAFT' ? (
              <p className="text-xs text-text-muted">
                Save your changes before approving or retiring this draft.
              </p>
            ) : null}
            {!view.canApprove ? (
              <p className="text-xs text-text-muted">
                You can draft and edit these messages. Approving one is the property
                administrator&rsquo;s decision.
              </p>
            ) : null}
          </form>
        </SectionCard>
      ) : null}

      {selected ? (
        <SectionCard title="Preview" titleLevel={2}>
          <p className="text-sm text-text-body">
            How version {selected.version} reads with sample values. Edit a value to see it in
            place; the stored wording is what renders, so save first to preview an edit.
          </p>
          <form
            className="mt-4 space-y-4"
            aria-label="Preview values"
            onSubmit={(event) => {
              event.preventDefault();
              void runPreview();
            }}
          >
            {previewPlaceholders.length ? (
              <fieldset
                className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                aria-describedby={previewError ? 'context-error' : undefined}
                disabled={pending || previewing}
              >
                <legend className={`${labelClass} mb-2`}>Sample values</legend>
                {previewPlaceholders.map((name) => (
                  <div key={name} className="min-w-0">
                    <label className={labelClass} htmlFor={`sample-${name}`}>
                      {`{{${name}}}`}
                    </label>
                    <Input
                      id={`sample-${name}`}
                      className="mt-1 min-h-11"
                      value={sampleValues[name] ?? sampleValueFor(name)}
                      onChange={(event) =>
                        setSampleValues((current) => ({ ...current, [name]: event.target.value }))
                      }
                    />
                  </div>
                ))}
              </fieldset>
            ) : (
              <p className="text-xs text-text-muted">This version names no placeholders.</p>
            )}
            {previewError ? (
              <p className="text-sm text-destructive" id="context-error" role="alert">
                {previewError}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="outline"
              className="min-h-11"
              disabled={pending || previewing}
            >
              {previewing ? 'Rendering…' : 'Preview this version'}
            </Button>
          </form>
          {preview && preview.id === selected.id ? (
            <div
              className="mt-4 space-y-3 rounded-md border border-border-subtle bg-surface-sunken p-4"
              data-testid="journey-preview"
            >
              {preview.result.rendered.subject !== null ? (
                <p className="text-sm">
                  <span className={labelClass}>Subject</span>
                  <span
                    className="mt-1 block font-semibold text-text-strong"
                    dir={selected.language === 'UR' ? 'rtl' : 'ltr'}
                    lang={selected.language === 'UR' ? 'ur' : 'en'}
                  >
                    {preview.result.rendered.subject}
                  </span>
                </p>
              ) : null}
              <div>
                <span className={labelClass}>Message</span>
                <p
                  className="mt-1 whitespace-pre-wrap text-sm text-text-body"
                  dir={selected.language === 'UR' ? 'rtl' : 'ltr'}
                  lang={selected.language === 'UR' ? 'ur' : 'en'}
                >
                  {preview.result.rendered.body}
                </p>
              </div>
              <p className="text-xs text-text-muted" role="status">
                {preview.result.propertySideCheck.ok
                  ? 'Approved and outside quiet hours: this wording could be sent right now. Whether a particular guest receives it still depends on their consent at send time.'
                  : preview.result.propertySideCheck.message}
              </p>
            </div>
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}
