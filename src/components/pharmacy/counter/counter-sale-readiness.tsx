'use client';

import Link from 'next/link';

import { Button, buttonVariants } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import {
  counterSetupAdvice,
  isCounterSetupReason,
  type CounterSetupAdvice,
  type CounterSetupReason,
} from '@/lib/pharmacy/counter-setup';

export type CounterSaleReadinessView = {
  ready: boolean;
  blockers: readonly string[];
  warnings: readonly string[];
  canFixSetup: boolean;
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
      {advice.nextStep ? <p className="text-text-muted">{advice.nextStep}</p> : null}
      {advice.link ? (
        <Link
          href={advice.link.href}
          prefetch={false}
          className={buttonVariants({
            variant: 'outline',
            className: 'h-auto min-h-11 whitespace-normal',
          })}
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
 */
export function CounterSaleReadiness({
  readiness,
  branchId,
  checking = false,
  onCheckAgain,
}: {
  readiness: CounterSaleReadinessView;
  branchId: string;
  checking?: boolean;
  onCheckAgain: () => void;
}) {
  const blockers = listed(readiness.blockers);
  const warnings = listed(readiness.warnings);
  if (blockers.length === 0 && warnings.length === 0) return null;
  const items = [
    ...blockers.map((reason) => ({ reason, blocking: true })),
    ...warnings.map((reason) => ({ reason, blocking: false })),
  ];
  return (
    <section
      aria-labelledby="counter-sale-readiness-title"
      data-counter-sale-readiness=""
      className={`mb-3 space-y-3 rounded-lg border p-3 text-sm ${
        blockers.length > 0
          ? 'border-warning/30 bg-warning/10'
          : 'border-border-subtle bg-surface-sunken'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="counter-sale-readiness-title" className="font-semibold text-text-strong">
          {blockers.length > 0 ? 'This counter cannot sell yet' : 'Some sales are limited'}
        </h2>
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
      <ul className="space-y-3">
        {items.map(({ reason, blocking }) => {
          const advice = counterSetupAdvice(reason, {
            canFixSetup: readiness.canFixSetup,
            branchId,
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
