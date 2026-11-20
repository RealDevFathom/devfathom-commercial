'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';
import {
  counterSetupAdvice,
  isCounterSetupReason,
  type CounterSetupAdvice,
  type CounterSetupReason,
} from '@/lib/pharmacy/counter-setup';
import type { PharmacyApprovalStatus } from '@/lib/pharmacy/approval-status';
import {
  acknowledgedReadinessReasons,
  counterReadinessOkayKey,
  readCounterReadinessOkay,
  subscribeCounterReadinessOkay,
  writeCounterReadinessOkay,
} from '@/lib/pharmacy/counter-readiness-okay';

export type CounterSaleReadinessView = {
  ready: boolean;
  blockers: readonly string[];
  warnings: readonly string[];
  canFixSetup: boolean;
  /** DEV-905: sent only when the workspace is not active: waiting for approval, or not. */
  approval?: PharmacyApprovalStatus | null;
};

/**
 * The counter shows its own open-drawer step (DEV-725), so the drawer is not listed
 * twice. Codes the client does not know are dropped rather than shown as a symbol.
 */
function listed(reasons: readonly string[]): CounterSetupReason[] {
  return reasons.filter(
    (reason): reason is CounterSetupReason =>
      isCounterSetupReason(reason) && reason !== 'DRAWER_NOT_OPEN'
  );
}

/** The next step under a setup message: the owner's fix link, or whom to ask. */
export function CounterSetupNextStep({ advice }: { advice: CounterSetupAdvice }) {
  if (!advice.link && !advice.nextStep) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {advice.nextStep ? <p className="text-text-body">{advice.nextStep}</p> : null}
      {advice.link ? (
        <Link
          href={advice.link.href}
          prefetch={false}
          className={cn(
            buttonVariants({ variant: 'outline' }),
            'h-auto min-h-11 max-w-full whitespace-normal'
          )}
        >
          {advice.link.label}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * DEV-860: the ready-to-sell check, shown before the first scan. It lists what the
 * server says would refuse a bill (blockers) or part of one (warnings), each with its
 * fix for an owner or administrator, or "ask your owner or manager" for anyone else.
 * The server stays the authority: this panel only explains its answer.
 *
 * DEV-970: "Okay" acknowledges the list for this person, branch and computer for the
 * browser session. Limits only: the panel goes away. Something blocks sales: it shrinks
 * to one line that stays on screen with "Show why", because a counter that refuses a sale
 * must always be able to say why. A reason not yet acknowledged brings the full panel back.
 */
export function CounterSaleReadiness({
  readiness,
  branchId,
  checking = false,
  onCheckAgain,
  rememberFor,
  onHidden,
}: {
  readiness: CounterSaleReadinessView;
  branchId: string;
  checking?: boolean;
  onCheckAgain: () => void;
  /** Whose Okay this is: the signed-in person on this computer (the branch is `branchId`). */
  rememberFor: { organizationId: string; accountId: string; deviceId: string | null };
  /** Called after Okay hides the panel completely, so the caller can place focus. */
  onHidden?: () => void;
}) {
  const blockers = listed(readiness.blockers);
  const warnings = listed(readiness.warnings);
  const reasons = [...new Set([...blockers, ...warnings])];
  const okayKey = counterReadinessOkayKey({ ...rememberFor, branchId });
  const readOkay = useCallback(() => readCounterReadinessOkay(okayKey), [okayKey]);
  const acknowledged = acknowledgedReadinessReasons(
    useSyncExternalStore(subscribeCounterReadinessOkay, readOkay, () => null)
  );
  const okayed = acknowledged !== null && reasons.every((reason) => acknowledged.includes(reason));
  // Focus follows the button the person pressed once the new state has rendered.
  const focusNext = useRef<'show-why' | 'title' | 'hidden' | null>(null);
  const showWhyRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    if (target === 'show-why') showWhyRef.current?.focus();
    else if (target === 'title') titleRef.current?.focus();
    else onHidden?.();
  });
  if (reasons.length === 0) return null;
  const blocked = blockers.length > 0;
  if (okayed && !blocked) return null;
  if (okayed) {
    return (
      <section
        aria-labelledby="counter-sale-readiness-title"
        data-counter-sale-readiness="collapsed"
        className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm"
      >
        <div className="flex min-w-0 items-center gap-3">
          <StatusPill status="blocked" tone="warning" label="Blocks sales" />
          <p
            id="counter-sale-readiness-title"
            role="status"
            className="min-w-0 font-semibold text-text-strong"
          >
            Sales are blocked at this counter.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            ref={showWhyRef}
            type="button"
            variant="outline"
            className="min-h-11"
            aria-expanded={false}
            onClick={() => {
              focusNext.current = 'title';
              writeCounterReadinessOkay(okayKey, null);
            }}
          >
            Show why
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={checking}
            onClick={onCheckAgain}
          >
            {checking ? 'Checking…' : 'Check again'}
          </Button>
        </div>
      </section>
    );
  }
  const items = [
    ...blockers.map((reason) => ({ reason, blocking: true })),
    ...warnings.map((reason) => ({ reason, blocking: false })),
  ];
  return (
    <section
      aria-labelledby="counter-sale-readiness-title"
      data-counter-sale-readiness=""
      className={`mb-3 space-y-3 rounded-lg border p-3 text-sm ${
        blocked ? 'border-warning/30 bg-warning/10' : 'border-border-subtle bg-surface-sunken'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          ref={titleRef}
          id="counter-sale-readiness-title"
          tabIndex={-1}
          className="rounded-control font-semibold text-text-strong outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {blocked ? 'This counter cannot sell yet' : 'Some sales are limited'}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={checking}
            onClick={onCheckAgain}
          >
            {checking ? 'Checking…' : 'Check again'}
          </Button>
          <Button
            type="button"
            className="min-h-11"
            aria-label={blocked ? 'Okay, shrink this to one line' : 'Okay, hide this'}
            onClick={() => {
              focusNext.current = blocked ? 'show-why' : 'hidden';
              writeCounterReadinessOkay(okayKey, reasons);
            }}
          >
            Okay
          </Button>
        </div>
      </div>
      <ul className="space-y-3">
        {items.map(({ reason, blocking }) => {
          const advice = counterSetupAdvice(reason, {
            canFixSetup: readiness.canFixSetup,
            branchId,
            approval: readiness.approval,
          });
          return (
            <li key={reason} data-reason={reason} className="flex items-start gap-3">
              <StatusPill
                status={blocking ? 'blocked' : 'limited'}
                tone="warning"
                label={blocking ? 'Blocks sales' : 'Limits sales'}
              />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-text-body">{advice.message}</p>
                <CounterSetupNextStep advice={advice} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
