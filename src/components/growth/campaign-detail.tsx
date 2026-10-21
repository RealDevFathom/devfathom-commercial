import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { UtilizationBar } from '@/components/ui/utilization-bar';
import { cn } from '@/lib/utils';
import type { CampaignStatus, GrowthCampaign, GrowthRecipient } from '@/lib/growth/view';

import { formatDiscount, formatPkr, formatWhen } from './format';
import { PendingButton } from './pending-button';

const FLOW: CampaignStatus[] = ['proposed', 'approved', 'scheduled', 'sending', 'sent'];
const RECIPIENT_TONE: Record<GrowthRecipient['status'], StatusTone> = {
  queued: 'warning',
  sent: 'info',
  delivered: 'info',
  failed: 'danger',
  skipped: 'neutral',
  redeemed: 'success',
};

const STATUS_TONE: Record<CampaignStatus, StatusTone> = {
  proposed: 'warning',
  approved: 'success',
  scheduled: 'info',
  sending: 'info',
  sent: 'success',
  cancelled: 'danger',
  exhausted: 'warning',
};

export function CampaignDetail({
  campaign,
  recipients,
  preview,
  cancelAction,
}: {
  campaign: GrowthCampaign;
  recipients: GrowthRecipient[];
  preview: string | null;
  cancelAction: (formData: FormData) => void | Promise<void>;
}) {
  const cancellable =
    campaign.status === 'proposed' ||
    campaign.status === 'approved' ||
    campaign.status === 'scheduled';
  const cap = campaign.budgetCapMinor;
  const spentPct = cap > 0 ? (campaign.spentMinor / cap) * 100 : 0;
  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill status={campaign.status} tone={STATUS_TONE[campaign.status]} />
        <p className="text-sm text-text-muted">Everyone opted in</p>
      </div>
      {FLOW.includes(campaign.status) ? (
        <ol aria-label="Campaign progress" className="flex flex-wrap gap-2">
          {FLOW.map((step) => (
            <li
              key={step}
              aria-current={step === campaign.status ? 'step' : undefined}
              className={cn(
                'inline-flex min-h-11 items-center rounded-full px-3 font-mono text-[0.625rem] font-semibold tracking-wide uppercase',
                step === campaign.status
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface-sunken text-text-muted'
              )}
            >
              {step}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-text-body">
          {campaign.status === 'cancelled'
            ? 'This campaign was cancelled and will not send.'
            : 'The cap is used up, so remaining codes no longer redeem.'}
        </p>
      )}
      <SectionCard title="This campaign" titleLevel={2}>
        <div className="grid gap-5 sm:grid-cols-3">
          <Stat
            label="Reach"
            value={campaign.estimatedReach.toLocaleString('en-PK')}
            sub="Opted-in customers"
          />
          <Stat
            label="Spend"
            value={formatPkr(campaign.spentMinor)}
            sub={`of ${formatPkr(campaign.budgetCapMinor)} cap`}
          />
          <Stat label="Redemptions" value={String(campaign.redemptionCount)} sub="Codes used" />
        </div>
        <UtilizationBar className="mt-5" label="Spend versus cap" value={spentPct} />
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-text-muted">Sends</dt>
            <dd className="text-text-strong">{formatWhen(campaign.sendAt)}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Discount</dt>
            <dd className="text-text-strong">
              {formatDiscount(campaign.discountType, campaign.discountValue)}
            </dd>
          </div>
        </dl>
      </SectionCard>
      <SectionCard title="Why this was proposed" titleLevel={2}>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-body">
          {campaign.rationale ?? 'No rationale was saved with this campaign.'}
        </p>
      </SectionCard>
      <SectionCard title="Message preview" titleLevel={2}>
        {preview ? (
          <p
            aria-label="Message preview"
            className="whitespace-pre-wrap rounded-md border border-border-subtle bg-surface-sunken p-4 text-sm leading-relaxed text-text-body"
          >
            {preview}
          </p>
        ) : (
          <p className="text-sm text-text-muted">The template could not be rendered.</p>
        )}
        <p className="mt-3 text-xs text-text-muted">
          Preview uses the first recipient. Every real send still ends with STOP.
        </p>
      </SectionCard>
      <SectionCard title="Recipients" titleLevel={2}>
        {recipients.length ? (
          <div className="min-w-0">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Redeemed</TableHead>
                  <TableHead>Sale</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recipients.map((recipient) => (
                  <TableRow key={recipient.id}>
                    <TableCell className="whitespace-normal">{recipient.name}</TableCell>
                    <TableCell className="font-mono text-xs">{recipient.phoneMasked}</TableCell>
                    <TableCell>
                      <StatusPill
                        status={recipient.status}
                        tone={RECIPIENT_TONE[recipient.status]}
                      />
                    </TableCell>
                    <TableCell className="text-text-muted">
                      {recipient.sentAt ? formatWhen(recipient.sentAt) : '—'}
                    </TableCell>
                    <TableCell className="text-text-muted">
                      {recipient.redeemedAt ? formatWhen(recipient.redeemedAt) : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{recipient.saleId ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-text-muted">
            Nobody is on this list yet. Recipients are added when the campaign is scheduled.
          </p>
        )}
      </SectionCard>
      {cancellable ? (
        <SectionCard title="Stop this campaign" titleLevel={2}>
          <p className="text-sm text-text-muted">
            Cancel before sending starts. A code that already went out can still be redeemed.
          </p>
          <form action={cancelAction} className="mt-4">
            <input type="hidden" name="campaignId" value={campaign.id} />
            <PendingButton variant="destructive" pendingLabel="Cancelling…" className="min-h-11">
              Cancel campaign
            </PendingButton>
          </form>
        </SectionCard>
      ) : (
        <p className="text-sm text-text-muted">
          Sending has started, so this campaign stays as it is.
        </p>
      )}
      <Link href="/growth" className={cn(buttonVariants({ variant: 'outline' }), 'min-h-11')}>
        All campaigns
      </Link>
    </div>
  );
}
