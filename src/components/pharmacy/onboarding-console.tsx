'use client';

/**
 * PLAT-03 — the pharmacy workspace home: activation status, then the twelve
 * readiness steps as a checklist.
 *
 * The page renders the server's first answer directly (no spinner on first
 * paint), and every attestation replaces the whole checklist with the server's
 * freshly recomputed verdict. That is deliberate rather than optimistic: a
 * recorded claim can be *downgraded* by the evaluator — an attestation with no
 * evidence reference behind it does not count — so showing the row as done
 * before the server agrees would be exactly the "correct data presented
 * misleadingly" defect the UX rules exist to stop. The control is still
 * immediate: it disables and says "Saving…" for the one row being saved, and
 * nothing else on the page freezes.
 */
import { useState } from 'react';
import Link from 'next/link';
import type { inferRouterOutputs } from '@trpc/server';

import {
  ReadinessChecklist,
  type ReadinessChecklistRow,
} from '@/components/onboarding/readiness-checklist';
import { Button, buttonVariants } from '@/components/ui/button';
import type { PharmacyOnboardingGate } from '@/lib/pharmacy/onboarding';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { AppRouter } from '@/server/routers/_app';

type Overview = inferRouterOutputs<AppRouter>['pharmacyOnboarding']['overview'];

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';

export function PharmacyOnboardingConsole({ initial }: { initial: Overview }) {
  const [overview, setOverview] = useState<Overview>(initial);
  const [openGate, setOpenGate] = useState<string | null>(null);
  const [evidenceRef, setEvidenceRef] = useState('');
  const [savingGate, setSavingGate] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const recordGate = trpc.pharmacyOnboarding.recordGate.useMutation({
    onSuccess: (next, variables) => {
      setOverview(next);
      setSavingGate(null);
      const saved = next.items.find((item) => item.key === variables.gate);
      // The server's verdict, not the operator's claim: if it did not stick,
      // the row's own line already says why, and this says it moved or did not.
      setNotice(
        saved?.state === 'DONE'
          ? `“${saved.label}” is recorded as done.`
          : 'That was saved, but the step is still outstanding — see the reason on the step.'
      );
      setOpenGate(null);
      setEvidenceRef('');
    },
    onError: (error) => {
      setSavingGate(null);
      const validation = error.data?.validation as
        Record<string, string[] | undefined> | null | undefined;
      setFieldError(
        validation?.evidenceRef?.[0] ??
          validation?.gate?.[0] ??
          error.message ??
          'That could not be saved. Try again.'
      );
    },
  });

  const rows: ReadinessChecklistRow[] = overview.items.map((item) => ({
    key: item.key,
    step: item.step,
    label: item.label,
    state: item.state,
    why: item.why,
    href: item.href,
    linkLabel: item.linkLabel,
  }));

  const actions = Object.fromEntries(
    overview.items.map((item) => {
      if (!item.attestable || item.state === 'DONE') return [item.key, null];
      const open = openGate === item.key;
      const saving = savingGate === item.key;
      const errorId = `${item.key}-evidence-error`;
      return [
        item.key,
        <div className="pt-1" key={item.key}>
          {open ? (
            <form
              className="space-y-2 rounded-md border border-border-subtle bg-surface-sunken p-3"
              onSubmit={(event) => {
                event.preventDefault();
                setFieldError(null);
                setNotice(null);
                if (!evidenceRef.trim()) {
                  // Inline, on the field, before a round trip (UX rule 11).
                  setFieldError('Say where the evidence for this step is recorded.');
                  return;
                }
                setSavingGate(item.key);
                recordGate.mutate({
                  // The row's key IS the gate — the checklist type keeps it a
                  // plain string so the shared component stays vertical-free.
                  gate: item.key as PharmacyOnboardingGate,
                  evidenceRef: evidenceRef.trim(),
                });
              }}
            >
              <label className={labelClass} htmlFor={`${item.key}-evidence`}>
                Where is the evidence recorded?
              </label>
              <Input
                aria-describedby={fieldError ? errorId : undefined}
                aria-invalid={fieldError ? true : undefined}
                autoFocus
                className="min-h-11"
                id={`${item.key}-evidence`}
                onChange={(event) => setEvidenceRef(event.target.value)}
                placeholder="e.g. Board minute 2026-09-02, or a link to the signed document"
                value={evidenceRef}
              />
              {fieldError ? (
                <p className="text-sm text-destructive" id={errorId} role="alert">
                  {fieldError}
                </p>
              ) : (
                <p className="text-xs text-text-muted">
                  A step you confirm yourself is only counted when it names its evidence — an
                  inspection reads this.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button disabled={saving} size="sm" type="submit">
                  {saving ? 'Saving…' : 'Mark as done'}
                </Button>
                <Button
                  disabled={saving}
                  onClick={() => {
                    setOpenGate(null);
                    setEvidenceRef('');
                    setFieldError(null);
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button
              aria-expanded={false}
              onClick={() => {
                setOpenGate(item.key);
                setEvidenceRef('');
                setFieldError(null);
                setNotice(null);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              Confirm this step
            </Button>
          )}
        </div>,
      ];
    })
  );

  return (
    <div className="min-w-0 space-y-6">
      <SectionCard
        eyebrow="Activation"
        title="Activation status"
        titleLevel={2}
        actions={
          <StatusPill
            status={overview.ready ? 'Ready' : 'Blocked'}
            tone={overview.ready ? 'success' : 'warning'}
          />
        }
      >
        <p className="text-sm text-text-body">{overview.activationSummary}</p>
        <p className="mt-2 text-sm text-text-muted">
          {overview.organization.status === 'ACTIVE'
            ? `${overview.organization.displayName} is active. These steps stay visible so you can see what your activation rests on.`
            : `${overview.organization.displayName} is not activated yet. DevFathom activates a pharmacy once every step below is done — nobody can wave it through.`}
        </p>
        {overview.blocking.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {overview.blocking.map((item) => (
              <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm" key={item.key}>
                <span className="font-mono text-xs text-text-faint">Step {item.step}</span>
                <span className="font-medium text-text-strong">{item.label}</span>
                {item.href && item.linkLabel ? (
                  <Link
                    className="text-primary underline underline-offset-4 hover:text-accent-brand"
                    href={item.href}
                  >
                    {item.linkLabel}
                  </Link>
                ) : (
                  <a
                    className="text-primary underline underline-offset-4 hover:text-accent-brand"
                    href={`#readiness-step-${item.step}`}
                  >
                    Go to this step
                  </a>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </SectionCard>

      {notice ? (
        <p
          className={cn(
            'rounded-md border border-border-subtle bg-surface-raised px-4 py-3 text-sm text-text-body'
          )}
          role="status"
        >
          {notice}
        </p>
      ) : null}

      <ReadinessChecklist
        actions={actions}
        description="Twelve steps take a pharmacy from a new workspace to its first legal sale. Each one says what it needs and where to do it."
        eyebrow="Onboarding"
        rows={rows}
        title="Your setup steps"
      />

      <SectionCard title="Where to next" titleLevel={2}>
        <p className="text-sm text-text-muted">
          The regulatory profile is the step most pharmacies spend the longest on — a licence, a
          qualified person, and the schedules the province permits.
        </p>
        <Link
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-3')}
          href="/pharmacy/regulatory"
        >
          Open the regulatory profile
        </Link>
      </SectionCard>
    </div>
  );
}
