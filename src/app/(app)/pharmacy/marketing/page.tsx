import { browserUuid } from '@/lib/browser-uuid';
import { GrowthPanel } from './growth-panel';
import { BasketPanel } from './basket-panel';
import Link from 'next/link';
import { TRPCError } from '@trpc/server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  MARKETING_ACCESS_DENIAL,
  MARKETING_ACCESS_FALLBACK,
} from '@/lib/pharmacy/marketing-access';
import { pharmacyMarketingRouter } from '@/server/routers/pharmacy-marketing';
import { createTRPCContext } from '@/server/trpc';
import { MarketingActionForm } from './action-form';
import { AiNextStep, aiReady, type MarketingAiAvailability } from './ai-next-step';
import { nativeControl as control, inputControl } from './controls';
import { defaultDayRange, defaultSendTime, localTime, zoneLabel } from './period';
import { PeriodFields, SendTimeField } from './period-fields';

export const metadata = { title: 'Marketing · Pharmacy' };
const scalar = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;

async function loadWorkspace(params: Record<string, string | string[] | undefined>) {
  const caller = pharmacyMarketingRouter.createCaller(await createTRPCContext());
  const branches = await caller.branches();
  const branchId = scalar(params.branch) ?? branches[0]?.id;
  if (!branchId) return null;
  const history = await caller.history({ branchId });
  const campaignId = scalar(params.campaign);
  const review = campaignId ? await caller.review({ branchId, campaignId }) : null;
  const delivery = campaignId ? await caller.deliveryHistory({ branchId, campaignId }) : null;
  let growth = null;
  let growthUnavailable = false;
  let growthDenial: string | undefined;
  try {
    growth = await caller.growthHistory({ branchId });
  } catch (error) {
    growthUnavailable = true;
    growthDenial = denialText(error);
  }
  let baskets = null;
  let basketsUnavailable = false;
  let basketsDenial: string | undefined;
  try {
    baskets = await caller.basketHistory({ branchId });
  } catch (error) {
    basketsUnavailable = true;
    basketsDenial = denialText(error);
  }
  let ai: MarketingAiAvailability = null;
  try {
    ai = (await caller.growthAvailability({ branchId })) ?? null;
  } catch {
    // Unknown: the page still names both prerequisites and where to change them.
  }
  return {
    branches,
    branchId,
    history,
    review,
    delivery,
    growth,
    growthUnavailable,
    growthDenial,
    baskets,
    basketsUnavailable,
    basketsDenial,
    ai,
  };
}

/** A router denial explains itself; other failures stay generic. */
function denialText(error: unknown) {
  return error instanceof TRPCError && error.code === 'FORBIDDEN' && error.message !== error.code
    ? error.message
    : undefined;
}

export default async function PharmacyMarketingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const heading = (
    <PageHeader
      eyebrowMuted
      className="[&_p]:text-text-body [&_[data-slot=eyebrow]]:text-text-body"
      eyebrow="Pharmacy"
      heading="Marketing"
      description="Review retail outreach, prepare consented audiences, and track saved campaigns."
    />
  );
  let workspace: Awaited<ReturnType<typeof loadWorkspace>> = null;
  let failed = false;
  let denial: string | null = null;
  try {
    workspace = await loadWorkspace(params);
  } catch (error) {
    failed = true;
    // The router names the one missing requirement (DEV-606); a bare code has no message.
    if (error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code))
      denial =
        error.message && error.message !== error.code ? error.message : MARKETING_ACCESS_FALLBACK;
  }
  if (failed) {
    const link =
      denial === null || denial === MARKETING_ACCESS_DENIAL.BRANCH
        ? { href: '/pharmacy/marketing', label: 'Reload marketing' }
        : { href: '/dashboard', label: 'Go to dashboard' };
    return (
      <main className="min-w-0 space-y-6">
        {heading}
        <SectionCard
          title={denial ? 'Marketing access required' : 'Marketing unavailable'}
          titleLevel={2}
        >
          <p role="alert" className="text-sm text-text-body">
            {denial ?? 'The workspace could not be loaded. Reload to try again.'}
          </p>
          <Link
            href={link.href}
            className="mt-4 inline-flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {link.label}
          </Link>
        </SectionCard>
      </main>
    );
  }
  if (!workspace)
    return (
      <main className="min-w-0 space-y-6">
        {heading}
        <SectionCard title="No active branches" titleLevel={2}>
          <p role="alert" className="text-sm text-text-body">
            {MARKETING_ACCESS_DENIAL.NO_BRANCH}
          </p>
        </SectionCard>
      </main>
    );
  const {
    branches,
    branchId,
    history,
    review,
    delivery,
    growth,
    growthUnavailable,
    growthDenial,
    baskets,
    basketsUnavailable,
    basketsDenial,
    ai,
  } = workspace;
  // DEV-591: every date and send time is picked in the workspace zone, with defaults.
  const timeZone = history.timezone;
  const zone = zoneLabel(timeZone);
  const period = defaultDayRange(timeZone);
  const sendDefault = defaultSendTime(timeZone);
  const local = (instant: Date) => localTime(instant, timeZone);
  return (
    <main key={branchId} className="min-w-0 space-y-6">
      {heading}
      <SectionCard title="Workspace" titleLevel={2}>
        <form action="/pharmacy/marketing" className="flex flex-wrap items-end gap-4">
          <label className="min-w-0 flex-1 text-sm">
            Branch
            <select className={control} name="branch" defaultValue={branchId}>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" className="min-h-11">
            Open branch
          </Button>
        </form>
        <p className="mt-4 text-sm text-text-muted">
          Local sandbox only. No customer messages are sent. Sandbox delivery is simulated. Dates,
          send times and quiet hours on this page use {zone}.
        </p>
      </SectionCard>
      <SectionCard title="Run due sandbox campaigns" titleLevel={2}>
        <p className="mb-3 text-sm text-text-muted">
          Explicitly process up to five due, approved and captured campaigns. Existing consent,
          quiet hours, caps and unknown-outcome guards apply. No scheduler or live delivery.
        </p>
        <MarketingActionForm
          branchId={branchId}
          operation="sandbox-due"
          label="Run bounded sandbox batch"
        >
          <fieldset className="space-y-2">
            <legend className="text-sm">Select up to five captured campaigns</legend>
            {history.campaigns
              .filter((campaign) => campaign.status === 'CAPTURED')
              .map((campaign) => (
                <label key={campaign.id} className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" name="campaignIds" value={campaign.id} />
                  {campaign.name}
                </label>
              ))}
            {!history.campaigns.some((campaign) => campaign.status === 'CAPTURED') && (
              <p className="text-sm text-text-muted">
                No prepared campaigns yet. Approve a campaign and save its prepared captures first.
              </p>
            )}
          </fieldset>
          <details className="rounded-md border border-border-subtle p-4">
            <summary className="min-h-11 cursor-pointer content-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
              Advanced: batch reference
            </summary>
            <label className="mt-2 block text-sm">
              Batch reference
              <Input
                className={inputControl}
                name="requestKey"
                required
                maxLength={128}
                defaultValue={browserUuid()}
                aria-describedby="batch-reference-help"
              />
            </label>
            <p id="batch-reference-help" className="mt-2 text-sm text-text-muted">
              Filled in for you. If the connection drops, run the batch again with the same
              reference: one reference never sends a campaign twice.
            </p>
          </details>
        </MarketingActionForm>
      </SectionCard>
      <GrowthPanel
        branchId={branchId}
        history={growth}
        unavailable={growthUnavailable}
        unavailableReason={growthDenial}
        templates={history.templates}
        timeZone={timeZone}
        zone={zone}
        period={period}
        sendDefault={sendDefault}
        ai={ai}
      />
      <BasketPanel
        branchId={branchId}
        history={baskets}
        unavailable={basketsUnavailable}
        unavailableReason={basketsDenial}
        timeZone={timeZone}
        zone={zone}
        period={period}
        sendDefault={sendDefault}
      />
      {review && (
        <SectionCard
          key={review.campaign.id}
          title={`Review: ${review.campaign.name}`}
          titleLevel={2}
        >
          <div className="space-y-4">
            <StatusPill
              className="text-text-body"
              status={review.campaign.status}
              label={review.campaign.status === 'CAPTURED' ? 'Prepared' : review.campaign.status}
            />
            <p className="whitespace-pre-wrap break-words text-sm">{review.template.body}</p>
            <p className="text-sm text-text-muted">
              Send time: {local(review.campaign.scheduledAt)} ({zone}). Rules:{' '}
              {review.rules.all
                .map(
                  (rule) =>
                    `${rule.field === 'receiptCount' ? 'Completed receipts' : 'Days since last receipt'} ${rule.operator === 'gte' ? 'at least' : rule.operator === 'lte' ? 'at most' : 'equal to'} ${rule.value}`
                )
                .join('; ')}
              .
            </p>
            <p className="break-words text-sm text-text-muted">
              Quiet hours: {String(review.quietHours.startHour).padStart(2, '0')}:00–
              {String(review.quietHours.endHour).padStart(2, '0')}:00 ({zone}). Maximum{' '}
              {review.frequencyCap.max} captures per customer over {review.frequencyCap.windowDays}{' '}
              days. Consent and caps are checked again at capture.
            </p>
            {review.campaign.status === 'DRAFT' && (
              <MarketingActionForm
                branchId={branchId}
                campaignId={review.campaign.id}
                operation="approve"
                label="Approve campaign"
              >
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="reviewed" required className="mt-1 size-5" />I
                  reviewed the copy, retail rules, schedule and frequency limits.
                </label>
              </MarketingActionForm>
            )}
            {review.campaign.status === 'APPROVED' && (
              <div className="grid gap-4 md:grid-cols-2">
                <MarketingActionForm
                  branchId={branchId}
                  campaignId={review.campaign.id}
                  operation="preview"
                  label="Preview audience"
                />
                <MarketingActionForm
                  branchId={branchId}
                  campaignId={review.campaign.id}
                  operation="capture"
                  label="Save prepared captures"
                />
              </div>
            )}
            {review.campaign.status === 'CAPTURED' && (
              <MarketingActionForm
                branchId={branchId}
                campaignId={review.campaign.id}
                operation="sandbox"
                label="Run sandbox dispatch"
              >
                <input type="hidden" name="requestKey" value={browserUuid()} />
                <label className="block text-sm">
                  Sandbox outcome
                  <select name="outcome" className={control} defaultValue="DELIVERED">
                    <option value="DELIVERED">Accepted and delivered (simulated)</option>
                    <option value="REJECTED">Confirmed rejection</option>
                    <option value="TIMEOUT">Timeout — outcome unknown</option>
                    <option value="FAULT">Adapter fault — outcome unknown</option>
                  </select>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="retry"
                    className="mt-1 size-5"
                    disabled={!delivery?.attempts.some((attempt) => attempt.retryable)}
                  />
                  Retry confirmed rejections only. Pending, accepted and unknown attempts cannot
                  resend.
                </label>
              </MarketingActionForm>
            )}
          </div>
        </SectionCard>
      )}
      {delivery && (
        <SectionCard title="Sandbox delivery history" titleLevel={2}>
          <p className="text-sm text-text-body">
            Attempted: {delivery.attempted}. Simulated acceptance: {delivery.accepted}. Simulated
            delivery: {delivery.delivered}. Failed: {delivery.failed}. Unknown: {delivery.unknown}.
            Suppressed: {delivery.suppressed}.
          </p>
          <p className="mt-3 text-sm text-text-muted">
            Counts describe sandbox attempts, including retries, not unique customers. Acceptance
            does not prove delivery. Unknown includes pending or conflicting evidence; resend is
            blocked. Only definite rejections qualify for retry, with consent, opt-out, caps and
            quiet hours checked again by the server. No unattended schedule is enabled here.
          </p>
          {!delivery.attempts.length ? (
            <p className="mt-3 text-sm">No dispatch attempts yet.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {delivery.attempts.map((attempt) => (
                <li key={attempt.id}>
                  {attempt.provider} attempt {attempt.attemptNumber} · {local(attempt.reservedAt)} ·{' '}
                  {attempt.contradictory
                    ? 'Conflicting evidence — resend blocked'
                    : attempt.delivered
                      ? 'Delivered'
                      : attempt.retryable
                        ? 'Confirmed rejection — retry available'
                        : attempt.suppressed
                          ? 'Suppressed'
                          : attempt.failed
                            ? 'Failed — resend blocked'
                            : attempt.accepted
                              ? 'Accepted; delivery unknown — resend blocked'
                              : 'Pending or unknown — resend blocked'}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
      <SectionCard title="Estimated receipt attribution" titleLevel={2}>
        <p className="mb-4 text-sm text-text-body">
          Save estimated links from actual receipts and verified Meta delivery. Sandbox outcomes
          never qualify. Returns reduce the reported amount; this does not measure causal uplift.
        </p>
        <MarketingActionForm
          branchId={branchId}
          operation="attribution"
          label="Generate receipt links"
        >
          <PeriodFields timeZone={timeZone} {...period} />
          <p className="text-sm text-text-muted">
            Whole days in {zone} that have already ended. The last 30 days are filled in for you.
          </p>
        </MarketingActionForm>
      </SectionCard>
      <SectionCard title="Campaign history" titleLevel={2}>
        {!history.campaigns.length ? (
          <p className="text-sm text-text-muted">
            No campaigns yet. Approve a template, then save your first draft below.
          </p>
        ) : (
          <div
            role="region"
            aria-label="Marketing campaigns"
            tabIndex={0}
            className="relative overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <table className="w-full text-left text-sm">
              <thead className="font-mono text-xs uppercase text-text-muted">
                <tr>
                  <th className="p-3">Campaign</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Send time</th>
                  <th className="p-3">Review</th>
                </tr>
              </thead>
              <tbody>
                {history.campaigns.map((campaign) => (
                  <tr
                    key={campaign.id}
                    className="border-t border-border-subtle hover:bg-surface-sunken"
                  >
                    <td className="p-3">{campaign.name}</td>
                    <td className="p-3">
                      <StatusPill
                        className="text-text-body"
                        status={campaign.status}
                        label={campaign.status === 'CAPTURED' ? 'Prepared' : campaign.status}
                      />
                    </td>
                    <td className="whitespace-nowrap p-3 font-mono text-xs">
                      {local(campaign.scheduledAt)}
                    </td>
                    <td className="p-3">
                      <Link
                        className="inline-flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:outline-ring"
                        href={`/pharmacy/marketing?branch=${encodeURIComponent(branchId)}&campaign=${encodeURIComponent(campaign.id)}`}
                      >
                        Open<span className="sr-only"> {campaign.name}</span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-text-muted">
          Latest 50 campaigns. Send times use {zone}. Prepared captures do not establish provider
          acceptance or delivery.
        </p>
      </SectionCard>
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <SectionCard title="Approve a retail template" titleLevel={2}>
          <MarketingActionForm
            branchId={branchId}
            operation="template"
            label="Approve and save template"
          >
            <label className="block text-sm">
              Template name
              <Input className={inputControl} name="name" required maxLength={100} />
            </label>
            <label className="block text-sm">
              Message
              <textarea
                className={`${control} min-h-32 py-3`}
                name="body"
                required
                maxLength={1000}
                aria-describedby="marketing-copy-help"
              />
            </label>
            <p id="marketing-copy-help" className="text-sm text-text-muted">
              Use generic retail copy. Include “Reply STOP to opt out.” Exclude medicines, clinical
              claims and personal information.
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input className="mt-1 size-5" type="checkbox" name="reviewed" required />I reviewed
              this template and approve its use.
            </label>
          </MarketingActionForm>
          <details className="mt-6 border-t border-border-subtle pt-4">
            <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
              Get a generic AI draft
            </summary>
            <div className="mt-4 space-y-4">
              <AiNextStep id="assist-ai-next-step" availability={ai} feature="AI drafts" />
              <MarketingActionForm
                branchId={branchId}
                operation="assist"
                label="Suggest unapproved copy"
                disabled={ai !== null && !aiReady(ai)}
              >
                <label className="block text-sm">
                  Occasion
                  <select className={control} name="occasion">
                    <option value="WELCOME">Welcome</option>
                    <option value="STORE_UPDATE">Store update</option>
                    <option value="RETAIL_OFFER">Retail offer</option>
                  </select>
                </label>
                <p className="text-sm text-text-muted">
                  Only this generic choice goes to the AI provider. Copy and review a suggestion
                  before approving it.
                </p>
              </MarketingActionForm>
            </div>
          </details>
        </SectionCard>
        <SectionCard title="Save a campaign draft" titleLevel={2}>
          <MarketingActionForm
            branchId={branchId}
            operation="draft"
            label="Save draft"
            disabled={!history.templates.length}
          >
            {!history.templates.length && (
              <p className="text-sm text-text-muted">
                Approve a template first to enable this form.
              </p>
            )}
            <label className="block text-sm">
              Campaign name
              <Input className={inputControl} name="name" required maxLength={100} />
            </label>
            <label className="block text-sm">
              Approved template
              <select name="templateId" required className={control}>
                {history.templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm">
                Retail rule
                <select className={control} name="field">
                  <option value="receiptCount">Completed receipt count</option>
                  <option value="daysSinceLastReceipt">Days since last receipt</option>
                </select>
              </label>
              <label className="block text-sm">
                At least
                <Input
                  name="threshold"
                  className={inputControl}
                  type="number"
                  min={0}
                  max={100000}
                  defaultValue={1}
                  required
                />
              </label>
            </div>
            <SendTimeField timeZone={timeZone} zone={zone} defaultValue={sendDefault} />
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm">
                Quiet hours start (0–23)
                <Input
                  name="quietStart"
                  className={inputControl}
                  type="number"
                  min={0}
                  max={23}
                  defaultValue={22}
                  required
                />
              </label>
              <label className="block text-sm">
                Quiet hours end (0–23)
                <Input
                  name="quietEnd"
                  className={inputControl}
                  type="number"
                  min={0}
                  max={23}
                  defaultValue={8}
                  required
                />
              </label>
              <label className="block text-sm">
                Maximum captures per customer
                <Input
                  name="cap"
                  className={inputControl}
                  type="number"
                  min={1}
                  max={10}
                  defaultValue={1}
                  required
                />
              </label>
              <label className="block text-sm">
                Rolling window (days)
                <Input
                  name="window"
                  className={inputControl}
                  type="number"
                  min={1}
                  max={90}
                  defaultValue={7}
                  required
                />
              </label>
            </div>
          </MarketingActionForm>
        </SectionCard>
      </div>
    </main>
  );
}
