'use client';

/**
 * UPS-04 — the guest journey templates surface: a list of what the property
 * sends, and an editor for one message at a time.
 *
 * Three rules, the same ones the property settings form follows:
 *
 * - **No raw identifiers.** Moments, channels, languages and statuses are all
 *   named for an operator; the enum values never reach the page (UX rule 1).
 * - **Errors land on fields.** A refused placeholder comes back as
 *   `data.validation.body`, so it appears under the message box and the box is
 *   marked `aria-invalid` (UX rule 11).
 * - **Nothing is a dead end.** The placeholder vocabulary for the selected
 *   moment is listed beside the editor, so "that placeholder is not available"
 *   is immediately followed by the ones that are (UX rule 13).
 *
 * Nothing on this page sends. Approving is the last step here; the send belongs
 * to H4.
 */
import { useState, type FormEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type JourneyView = inferRouterOutputs<AppRouter>['hotelProperty']['journeyTemplates']['list'];
type JourneyTemplate = JourneyView['templates'][number];
type DraftCopy = Pick<JourneyTemplate, 'subject' | 'body'>;
type DraftKey = Pick<JourneyTemplate, 'moment' | 'channel' | 'language'>;
type DraftBuffer = DraftKey & DraftCopy;

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

function minutesToClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export function HotelJourneyTemplatesEditor({ initial }: { initial: JourneyView }) {
  const [view, setView] = useState<JourneyView>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial.templates[0]?.id ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [copies, setCopies] = useState<Record<string, DraftBuffer>>({});
  const [replacements, setReplacements] = useState<Record<string, boolean>>({});
  const [newKey, setNewKey] = useState<DraftKey>({
    moment: initial.moments[0].value,
    channel: initial.channels[0].value,
    language: initial.languages[0].value,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const refreshed = await utils.hotelProperty.journeyTemplates.list.fetch();
      setCopies((current) => ({
        ...Object.fromEntries(
          view.templates
            .filter((template) => !refreshed.templates.some((row) => row.id === template.id))
            .map((template) => [template.id, template])
        ),
        ...current,
      }));
      setView(refreshed);
    } catch {
      setRefreshError('The message list could not be refreshed. Your editor text has been kept.');
    } finally {
      setRefreshing(false);
    }
  };

  const onError = (error: { message: string }) => {
    const fields = validationErrors(error);
    const unrendered = Object.entries(fields)
      .filter(([field]) => field !== 'body' && !(field === 'subject' && key.channel === 'EMAIL'))
      .map(([, message]) => message);
    setNotice(null);
    setErrors(
      Object.keys(fields).length
        ? { ...fields, ...(unrendered.length ? { form: unrendered.join(' ') } : {}) }
        : { form: error.message || 'The action could not be completed. Please try again.' }
    );
  };

  const save = trpc.hotelProperty.journeyTemplates.save.useMutation({
    onSuccess: async (template) => {
      setErrors({});
      setNotice('Draft saved. A property administrator can review it for approval.');
      setView((current) => ({
        ...current,
        templates: [template, ...current.templates.filter((row) => row.id !== template.id)],
      }));
      setCopies((current) => ({ ...current, [template.id]: template }));
      setSelectedId(template.id);
      await refresh();
    },
    onError,
  });

  const approve = trpc.hotelProperty.journeyTemplates.approve.useMutation({
    onSuccess: async (template) => {
      setErrors({});
      setNotice('Approved. Nothing is sent from this page.');
      if (template)
        setView((current) => ({
          ...current,
          templates: current.templates.map((row) => (row.id === template.id ? template : row)),
        }));
      if (selectedId) setReplacements((current) => ({ ...current, [selectedId]: false }));
      await refresh();
    },
    onError,
  });

  const retire = trpc.hotelProperty.journeyTemplates.retire.useMutation({
    onSuccess: async (template) => {
      setErrors({});
      setNotice('Retired. You can create a replacement draft from this version.');
      setView((current) => ({
        ...current,
        templates: current.templates.map((row) => (row.id === template.id ? template : row)),
      }));
      if (selectedId) setReplacements((current) => ({ ...current, [selectedId]: false }));
      await refresh();
    },
    onError,
  });

  const selected = view.templates.find((template) => template.id === selectedId) ?? null;
  const key = selected ?? newKey;
  const copyKey = selectedId ?? 'new';
  const moment = view.moments.find((entry) => entry.value === key.moment);
  const editable = !selectedId || selected?.status === 'DRAFT' || !!replacements[copyKey];
  const copy =
    !editable && selected ? selected : (copies[copyKey] ?? selected ?? { subject: '', body: '' });
  const pending = save.isPending || approve.isPending || retire.isPending || refreshing;
  const unsaved =
    selected &&
    (copy.body !== selected.body || (key.channel === 'EMAIL' && copy.subject !== selected.subject));
  const latestMatching = view.templates
    .filter(
      (template) =>
        template.moment === key.moment &&
        template.channel === key.channel &&
        template.language === key.language
    )
    .sort((a, b) => b.version - a.version)[0];
  const matchingDraft =
    selected && selected.status !== 'DRAFT' && latestMatching?.status === 'DRAFT'
      ? latestMatching
      : null;
  const openMatchingDraft = () => {
    if (!matchingDraft) return;
    setSelectedId(matchingDraft.id);
    setErrors({});
    setNotice(`Opened draft version ${matchingDraft.version}. Your editor text has been kept.`);
  };

  const updateCopy = (change: Partial<DraftCopy>) => {
    setCopies((current) => ({
      ...current,
      [copyKey]: {
        moment: key.moment,
        channel: key.channel,
        language: key.language,
        subject: copy.subject,
        body: copy.body,
        ...change,
      },
    }));
    setNotice(null);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editable || pending || refreshError || (selectedId && !selected)) return;
    if (matchingDraft) {
      openMatchingDraft();
      return;
    }
    setErrors({});
    setNotice(null);
    save.mutate({
      moment: key.moment,
      channel: key.channel,
      language: key.language,
      subject: key.channel === 'EMAIL' ? (copy.subject ?? '').trim() : null,
      body: copy.body.trim(),
    });
  };

  return (
    <div className="space-y-6">
      <SectionCard title="Quiet hours" titleLevel={2}>
        <p className="text-sm text-text-body">
          {view.quietHours
            ? `Current quiet-hours window: ${minutesToClock(view.quietHours.startMinute)} to ${minutesToClock(view.quietHours.endMinute)}, ${view.propertyTimezone} time.`
            : 'No quiet-hours window is currently configured.'}
        </p>
        <p className="mt-2 text-xs text-text-muted">
          This page manages message drafts and approvals. It does not send messages or change quiet
          hours.
        </p>
      </SectionCard>

      <SectionCard title="Guest messages" titleLevel={2}>
        <Button
          type="button"
          variant="secondary"
          className="mb-4 min-h-11"
          disabled={pending}
          onClick={() => {
            setSelectedId(null);
            setErrors({});
            setNotice(null);
          }}
        >
          New draft
        </Button>
        {!view.templates.length ? (
          <p className="mb-4 text-sm text-text-muted">
            No guest messages yet. Choose a moment, channel and language below to create the first
            draft.
          </p>
        ) : null}
        <ul className="space-y-1">
          {view.templates.map((template) => {
            const label = view.moments.find((entry) => entry.value === template.moment)?.label;
            const channel = view.channels.find((entry) => entry.value === template.channel)?.label;
            const language = view.languages.find(
              (entry) => entry.value === template.language
            )?.label;
            return (
              <li key={template.id}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setSelectedId(template.id);
                    setErrors({});
                    setNotice(null);
                  }}
                  aria-current={template.id === selectedId}
                  className="flex min-h-11 w-full flex-wrap items-baseline gap-x-3 gap-y-1 border-l-2 border-border-strong px-3 py-2 text-left outline-none hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-ring active:bg-surface-sunken disabled:opacity-50 aria-[current=true]:bg-surface-sunken"
                >
                  <StatusPill status={view.statusLabels[template.status]} />
                  <span className="text-sm font-semibold text-text-strong">{label}</span>
                  <span className="text-xs text-text-muted">
                    {channel} · {language} · version {template.version}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      {refreshError ? (
        <SectionCard title="Message list needs a refresh" titleLevel={2}>
          <p className="text-sm text-destructive" role="alert">
            {refreshError}
          </p>
          <Button
            type="button"
            variant="secondary"
            className="mt-3 min-h-11"
            disabled={pending}
            onClick={() => void refresh()}
          >
            Retry refresh
          </Button>
        </SectionCard>
      ) : null}
      {refreshing ? (
        <p className="text-sm text-text-muted" role="status">
          Refreshing message list…
        </p>
      ) : null}

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
                const kept = copies[copyKey];
                setCopies((current) => ({ ...current, new: kept }));
                setNewKey({ moment: kept.moment, channel: kept.channel, language: kept.language });
                setSelectedId(null);
                setErrors({});
                setNotice(null);
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
              ? `${moment.label} — ${view.channels.find((entry) => entry.value === key.channel)?.label}, ${view.languages.find((entry) => entry.value === key.language)?.label}`
              : 'Create a guest message'
          }
          titleLevel={2}
        >
          <form className="space-y-4" onSubmit={onSubmit}>
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
                language. Open it to continue with its kept text.
              </p>
            ) : selected && selected.status !== 'DRAFT' && editable ? (
              <p className="text-sm text-text-muted">
                Replacement draft based on version {selected.version}. The original wording is
                unchanged.
              </p>
            ) : null}
            {!selected ? (
              <p className="text-xs text-text-muted">
                If this moment, channel and language already have a draft, saving updates that
                draft.
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
                  className="min-h-11"
                  dir={key.language === 'UR' ? 'rtl' : 'ltr'}
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
                <Button type="submit" className="min-h-11" disabled={pending || !!refreshError}>
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
                  variant="secondary"
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
                  variant="secondary"
                  className="min-h-11"
                  disabled={pending || !!refreshError || !!unsaved}
                  onClick={() => approve.mutate({ id: selected.id })}
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
                  variant="secondary"
                  className="min-h-11"
                  disabled={pending || !!refreshError || !!unsaved}
                  onClick={() => retire.mutate({ id: selected.id })}
                >
                  {retire.isPending ? 'Retiring…' : 'Retire'}
                </Button>
              ) : null}
            </div>
            {unsaved && selected?.status === 'DRAFT' ? (
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
    </div>
  );
}
