'use client';

/**
 * #709 — the FBR "Am I Tier-1?" self-check wizard.
 *
 * One verdict, decided on the server from the answers (the client never sends
 * a result), stored with the answers in an
 * audit row, and shown here with every criterion's outcome and the dated
 * source it rests on. The check is asked again twelve months after it was last
 * answered. It is guidance, not tax advice, and says so wherever a result is
 * shown.
 */
import { useState, type FormEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import type {
  FbrTier1Answer,
  FbrTier1Answers,
  FbrTier1CriterionKey,
  FbrTier1CriterionOutcome,
  FbrTier1Result,
} from '@/lib/pharmacy/fbr-tier1';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type Status = inferRouterOutputs<AppRouter>['pharmacyOnboarding']['fbrTier1Status'];

const labelClass =
  'block font-mono text-xs font-semibold uppercase tracking-wide text-text-muted';

const dayFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });
const day = (value: Date | string) => dayFormat.format(new Date(value));
const rupees = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 });

const CHOICES: { value: FbrTier1Answer; label: string }[] = [
  { value: 'YES', label: 'Yes' },
  { value: 'NO', label: 'No' },
  { value: 'UNSURE', label: 'Not sure' },
];

const RESULT_TONE: Record<FbrTier1Result, 'danger' | 'success' | 'warning'> = {
  TIER_1: 'danger',
  NOT_TIER_1: 'success',
  UNSURE: 'warning',
};

const OUTCOME_LABEL: Record<FbrTier1CriterionOutcome, string> = {
  MET: 'Applies',
  NOT_MET: 'Does not apply',
  UNKNOWN: 'Not known',
};
const OUTCOME_TONE: Record<FbrTier1CriterionOutcome, 'danger' | 'success' | 'warning'> = {
  MET: 'danger',
  NOT_MET: 'success',
  UNKNOWN: 'warning',
};

type ChoiceKey =
  | 'chainOutlet'
  | 'airConditionedMallOrPlaza'
  | 'bulkImportWholesaleAndRetail'
  | 'bankCardPos'
  | 'otherNotifiedCategory';
type AmountKey = 'electricityBillRupees12Months' | 'annualTurnoverRupees';

const FIELD_FOR: Record<FbrTier1CriterionKey, ChoiceKey | AmountKey> = {
  chainOutlet: 'chainOutlet',
  airConditionedMallOrPlaza: 'airConditionedMallOrPlaza',
  electricityBill12Months: 'electricityBillRupees12Months',
  wholesaleAndRetail: 'bulkImportWholesaleAndRetail',
  bankCardPos: 'bankCardPos',
  otherNotifiedCategory: 'otherNotifiedCategory',
  annualTurnover: 'annualTurnoverRupees',
};

/** Blank means "I don't know" (null); otherwise whole rupees, commas allowed. */
function parseRupees(raw: string): number | null | 'invalid' {
  const cleaned = raw.replaceAll(',', '').replaceAll(' ', '').trim();
  if (cleaned === '') return null;
  if (!/^\d+$/.test(cleaned)) return 'invalid';
  const value = Number(cleaned);
  return Number.isSafeInteger(value) ? value : 'invalid';
}

export function FbrTier1Check({ initial }: { initial: Status }) {
  const [status, setStatus] = useState<Status>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const previous: FbrTier1Answers | undefined = status.latest?.answers;

  const record = trpc.pharmacyOnboarding.recordFbrTier1Check.useMutation({
    onSuccess: (next) => {
      setStatus(next);
      setErrors({});
      setSaved(true);
    },
    onError: (error) => {
      const validation = (error.data?.validation ?? null) as Record<
        string,
        string[] | undefined
      > | null;
      const next: Record<string, string> = {};
      for (const [field, messages] of Object.entries(validation ?? {})) {
        if (messages?.[0]) next[field] = messages[0];
      }
      if (Object.keys(next).length === 0) next.form = error.message;
      setErrors(next);
      setSaved(false);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next: Record<string, string> = {};
    const choice = (name: ChoiceKey): FbrTier1Answer | null => {
      const value = form.get(name);
      if (value === 'YES' || value === 'NO' || value === 'UNSURE') return value;
      next[name] = 'Choose Yes, No or Not sure.';
      return null;
    };
    const amount = (name: AmountKey): number | null => {
      const value = parseRupees(String(form.get(name) ?? ''));
      if (value === 'invalid') {
        next[name] = 'Enter whole rupees using digits only, or leave it blank if you do not know.';
        return null;
      }
      return value;
    };
    const answers = {
      chainOutlet: choice('chainOutlet'),
      airConditionedMallOrPlaza: choice('airConditionedMallOrPlaza'),
      electricityBillRupees12Months: amount('electricityBillRupees12Months'),
      bulkImportWholesaleAndRetail: choice('bulkImportWholesaleAndRetail'),
      bankCardPos: choice('bankCardPos'),
      otherNotifiedCategory: choice('otherNotifiedCategory'),
      annualTurnoverRupees: amount('annualTurnoverRupees'),
    };
    if (Object.keys(next).length > 0) {
      setErrors(next);
      setSaved(false);
      event.currentTarget
        .querySelector<HTMLElement>(`[name="${Object.keys(next)[0]}"]`)
        ?.focus();
      return;
    }
    record.mutate(answers as FbrTier1Answers);
  }

  const latest = status.latest;

  return (
    <div className="space-y-6">
      <SectionCard title="Not tax advice" titleLevel={2} compact>
        <p className="text-sm text-text-body">{status.disclaimer}</p>
      </SectionCard>

      {latest ? (
        <SectionCard
          title="Your latest answer"
          titleLevel={2}
          actions={
            <StatusPill
              status={latest.evaluation.result}
              label={latest.evaluation.headline}
              tone={RESULT_TONE[latest.evaluation.result]}
              className="max-w-40 whitespace-normal sm:max-w-none"
            />
          }
        >
          <div className="space-y-4" aria-live="polite">
            <p className="font-display text-lg font-semibold text-text-strong">
              {latest.evaluation.headline}
            </p>
            <p className="text-sm text-text-muted">
              Answered {day(latest.assessedAt)}
              {latest.assessedBy ? ` by ${latest.assessedBy}` : ''}. Ask again by{' '}
              {day(latest.recheckDueAt)}.
            </p>
            {status.recheckDue ? (
              <p className="text-sm font-medium text-warning" role="status">
                It has been twelve months since this was answered. Your circumstances may have
                changed — answer the questions again below.
              </p>
            ) : null}
            {saved ? (
              <p className="text-sm font-medium text-success" role="status">
                Saved. Your answers and this result are kept in your audit log.
              </p>
            ) : null}
            {latest.evaluation.result === 'TIER_1' ? (
              <p className="text-sm text-text-body">
                Tier-1 retailers must integrate their point of sale with FBR.{' '}
                <a
                  className="font-medium text-primary underline underline-offset-4 hover:text-accent-brand focus-visible:outline-2 focus-visible:outline-ring"
                  href="https://www.fbr.gov.pk/pos-technical-assistance/163085/163087"
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Read FBR’s official integration setup instructions (opens in a new tab)
                </a>
              </p>
            ) : latest.evaluation.result === 'UNSURE' ? (
              <p className="text-sm text-text-body">
                At least one answer could not be settled. Take these answers to your tax adviser
                before deciding.
              </p>
            ) : null}
            <ul className="divide-y divide-border">
              {latest.evaluation.criteria.map((criterion) => {
                const definition = status.criteria.find((item) => item.key === criterion.key);
                return (
                  <li
                    className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
                    key={criterion.key}
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm text-text-body">{definition?.question}</p>
                      <p className="text-xs text-text-muted">
                        Source:{' '}
                        <a
                          className="underline underline-offset-4 hover:text-accent-brand"
                          href={criterion.source.url}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          {criterion.source.title}
                        </a>{' '}
                        ({day(criterion.source.date)})
                        {criterion.confirmed ? '' : ' — not confirmed by FBR'}
                      </p>
                    </div>
                    <StatusPill
                      status={criterion.outcome}
                      label={OUTCOME_LABEL[criterion.outcome]}
                      tone={OUTCOME_TONE[criterion.outcome]}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        </SectionCard>
      ) : (
        <SectionCard title="Not answered yet" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Nobody in this workspace has answered the Tier-1 self-check. It takes a minute: answer
            the questions below.
          </p>
        </SectionCard>
      )}

      <SectionCard title={latest ? 'Answer again' : 'The questions'} titleLevel={2}>
        <form className="space-y-6" noValidate onSubmit={submit}>
          <p className="text-sm text-text-muted">
            Any confirmed criterion makes a retailer Tier-1. The turnover claim alone returns
            “Unsure” until FBR confirms it. Choose “Not sure” or leave an amount blank rather
            than guess.
          </p>
          {status.criteria.map((criterion) => {
            const field = FIELD_FOR[criterion.key];
            const error = errors[field];
            const hintId = `${field}-hint`;
            const errorId = `${field}-error`;
            const sourceLine = (
              <p className="text-xs text-text-muted" id={hintId}>
                {criterion.help} Source: {criterion.source.title} ({day(criterion.source.date)}).
              </p>
            );
            if (field === 'electricityBillRupees12Months' || field === 'annualTurnoverRupees') {
              const value = previous?.[field];
              return (
                <div className="min-w-0 space-y-1" key={criterion.key}>
                  <label className={labelClass} htmlFor={field}>
                    {criterion.question}
                  </label>
                  <Input
                    aria-describedby={error ? `${errorId} ${hintId}` : hintId}
                    aria-invalid={error ? true : undefined}
                    className="mt-1 min-h-11 max-w-sm tabular-nums"
                    defaultValue={value === null || value === undefined ? '' : rupees.format(value)}
                    id={field}
                    inputMode="numeric"
                    name={field}
                    placeholder="Leave blank if you do not know"
                  />
                  {error ? (
                    <p className="text-sm text-destructive" id={errorId} role="alert">
                      {error}
                    </p>
                  ) : null}
                  {sourceLine}
                </div>
              );
            }
            return (
              <fieldset
                aria-describedby={error ? `${errorId} ${hintId}` : hintId}
                aria-invalid={error ? true : undefined}
                className="min-w-0 space-y-2"
                key={criterion.key}
              >
                <legend className={labelClass}>{criterion.question}</legend>
                <div className="flex flex-wrap gap-2">
                  {CHOICES.map((option) => (
                    <label
                      className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-input bg-surface-raised px-3 text-sm text-text-body has-[:checked]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                      key={option.value}
                    >
                      <input
                        className="accent-primary"
                        defaultChecked={previous?.[field] === option.value}
                        name={field}
                        type="radio"
                        value={option.value}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
                {error ? (
                  <p className="text-sm text-destructive" id={errorId} role="alert">
                    {error}
                  </p>
                ) : null}
                {sourceLine}
              </fieldset>
            );
          })}
          {errors.form ? (
            <p className="text-sm text-destructive" role="alert">
              {errors.form}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={record.isPending} size="touch" type="submit">
              {record.isPending ? 'Checking…' : 'Check and save'}
            </Button>
            <p className="text-xs text-text-muted">Not tax advice. Your answers are kept.</p>
          </div>
        </form>
      </SectionCard>
    </div>
  );
}
