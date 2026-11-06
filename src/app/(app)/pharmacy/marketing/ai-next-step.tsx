import type { ReactNode } from 'react';
import Link from 'next/link';
import { StatusPill } from '@/components/ui/status-pill';

/** `pharmacyMarketing.growthAvailability`; null when it could not be read. */
export type MarketingAiAvailability = {
  companyAiEnabled: boolean;
  providerReady: boolean;
  canManageAiSettings: boolean;
} | null;

export const aiReady = (availability: MarketingAiAvailability) =>
  Boolean(availability?.companyAiEnabled && availability.providerReady);

const settingsLink = (
  <Link
    href="/organization"
    className="inline-flex min-h-11 items-center font-medium text-text-strong underline focus-visible:outline-2 focus-visible:outline-ring"
  >
    Open Organization settings
  </Link>
);

/**
 * DEV-591: say which AI prerequisite is missing and what to do about it,
 * instead of a bare "requires enabled AI settings and a configured provider".
 * The company switch is the owner's; the provider is connected by DevFathom.
 */
export function AiNextStep({
  id,
  availability,
  feature,
}: {
  id: string;
  availability: MarketingAiAvailability;
  /** What is blocked, as a sentence subject: "AI growth insights". */
  feature: string;
}) {
  if (aiReady(availability)) return null;
  const steps: ReactNode[] = [];
  if (!availability) {
    steps.push(
      <>Check that Ask Fathom is turned on for your company. {settingsLink}</>,
      <>If it is on and this still fails, contact DevFathom support to check the AI connection.</>
    );
  } else {
    if (!availability.companyAiEnabled)
      steps.push(
        availability.canManageAiSettings ? (
          <>Turn on Ask Fathom for your company, then come back to this page. {settingsLink}</>
        ) : (
          <>Ask your workspace owner to turn on Ask Fathom in Organization settings.</>
        )
      );
    if (!availability.providerReady)
      steps.push(
        <>
          Contact DevFathom support and ask them to connect an AI provider for your workspace. You
          cannot change this yourself.
        </>
      );
  }
  return (
    <div
      id={id}
      role="note"
      className="space-y-3 rounded-md border border-border-subtle bg-surface-sunken p-4 text-sm text-text-body"
    >
      <StatusPill status="warning" label="AI not ready" />
      <p className="font-medium text-text-strong">
        {availability ? `${feature} are off for now.` : `${feature} may be unavailable.`}
      </p>
      <ol className="list-decimal space-y-1 pl-5">
        {steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
      <p>Manual campaign drafting keeps working without AI.</p>
    </div>
  );
}
