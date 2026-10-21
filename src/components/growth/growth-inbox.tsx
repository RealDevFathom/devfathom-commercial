'use client';

import { useState } from 'react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type {
  CampaignStatus,
  GrowthCampaign,
  GrowthConnection,
  GrowthTab,
  GrowthTemplate,
} from '@/lib/growth/view';
import { campaignInTab } from '@/lib/growth/view';

import {
  formatDiscount,
  formatPkr,
  formatWhen,
  growthFieldClass,
  KIND_LABEL,
  rupeesInput,
  TEMPLATE_LABEL,
} from './format';
import { ConnectionChip } from './growth-nav';
import { PendingButton } from './pending-button';

const TABS: GrowthTab[] = ['proposed', 'scheduled', 'sent', 'all'];
const TAB_LABEL: Record<GrowthTab, string> = {
  proposed: 'Proposed',
  scheduled: 'Scheduled',
  sent: 'Sent',
  all: 'All',
};
const TAB_HINT: Record<GrowthTab, string> = {
  proposed: 'Nothing sends until you approve it.',
  scheduled: 'Approved campaigns wait here for the next send tick, then move to sending.',
  sent: 'Finished campaigns, including ones that used up their cap.',
  all: 'Every campaign, including ones you rejected.',
};
const TONE: Record<CampaignStatus, StatusTone> = {
  proposed: 'warning',
  approved: 'success',
  scheduled: 'info',
  sending: 'info',
  sent: 'success',
  cancelled: 'danger',
  exhausted: 'warning',
};

const EMPTY: Record<GrowthTab, string> = {
  proposed:
    'Koi naya proposal nahi. The weekly planner adds some on Monday, or create one yourself.',
  scheduled: 'Nothing is waiting to send.',
  sent: 'No campaign has finished yet.',
  all: 'No campaigns yet.',
};

function CampaignActions({
  campaign,
  onEdit,
  approveAction,
  rejectAction,
}: {
  campaign: GrowthCampaign;
  onEdit: (campaign: GrowthCampaign) => void;
  approveAction: (formData: FormData) => void | Promise<void>;
  rejectAction: (formData: FormData) => void | Promise<void>;
}) {
  if (campaign.status !== 'proposed') {
    return (
      <Link
        href={`/growth/${campaign.id}`}
        className={cn(buttonVariants({ variant: 'outline' }), 'min-h-11')}
      >
        Open
      </Link>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <form action={approveAction}>
        <input type="hidden" name="campaignId" value={campaign.id} />
        <PendingButton
          pendingLabel="Approving…"
          className="min-h-11"
          aria-label={`Approve ${campaign.name}`}
        >
          Approve
        </PendingButton>
      </form>
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        aria-label={`Edit ${campaign.name}`}
        onClick={() => onEdit(campaign)}
      >
        Edit
      </Button>
      <form action={rejectAction}>
        <input type="hidden" name="campaignId" value={campaign.id} />
        <PendingButton
          variant="destructive"
          pendingLabel="Rejecting…"
          className="min-h-11"
          aria-label={`Reject ${campaign.name}`}
        >
          Reject
        </PendingButton>
      </form>
    </div>
  );
}

function CampaignFields({
  campaign,
  templates,
  defaultSendAt,
}: {
  campaign: GrowthCampaign | null;
  templates: GrowthTemplate[];
  defaultSendAt: string;
}) {
  const [discountType, setDiscountType] = useState(campaign?.discountType ?? 'percent');
  const discountDefault =
    campaign?.discountType === 'fixed' && campaign.discountValue != null
      ? rupeesInput(campaign.discountValue)
      : campaign?.discountType === 'percent' && campaign.discountValue != null
        ? String(campaign.discountValue)
        : '10';
  return (
    <>
      {campaign ? <input type="hidden" name="campaignId" value={campaign.id} /> : null}
      <label className="block text-sm text-text-body">
        Name
        <input
          className={growthFieldClass}
          name="name"
          required
          maxLength={80}
          defaultValue={campaign?.name ?? ''}
        />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm text-text-body">
          Kind
          <select
            className={growthFieldClass}
            name="kind"
            defaultValue={campaign?.kind ?? 'manual'}
          >
            {Object.entries(KIND_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-sm text-text-muted sm:col-span-2">Everyone who opted in.</p>
        <label className="block text-sm text-text-body">
          Send at (Karachi)
          <input
            className={growthFieldClass}
            name="sendAt"
            type="datetime-local"
            required
            defaultValue={campaign ? toLocal(campaign.sendAt) : defaultSendAt}
          />
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm text-text-body">
          Discount
          <select
            className={growthFieldClass}
            name="discountType"
            value={discountType}
            onChange={(event) =>
              setDiscountType(event.target.value as GrowthCampaign['discountType'])
            }
          >
            <option value="percent">Percent</option>
            <option value="fixed">Fixed rupees</option>
            <option value="none">No discount</option>
          </select>
        </label>
        {discountType === 'none' ? null : (
          <label className="block text-sm text-text-body">
            {discountType === 'percent' ? 'Percent off' : 'Rupees off'}
            <input
              className={growthFieldClass}
              name="discountValue"
              inputMode="decimal"
              defaultValue={discountDefault}
              required
            />
          </label>
        )}
        <label className="block text-sm text-text-body">
          Budget cap (PKR)
          <input
            className={growthFieldClass}
            name="budgetRupees"
            inputMode="decimal"
            required
            defaultValue={campaign ? rupeesInput(campaign.budgetCapMinor) : '2000'}
          />
        </label>
        <label className="block text-sm text-text-body">
          Template
          <select
            className={growthFieldClass}
            name="templateId"
            defaultValue={campaign?.templateId ?? templates[0]?.id}
          >
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {TEMPLATE_LABEL[template.key] ?? template.key}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-sm text-text-body">
        Rationale
        <textarea
          className={`${growthFieldClass} min-h-24 py-2`}
          name="rationale"
          maxLength={600}
          defaultValue={campaign?.rationale ?? ''}
        />
      </label>
    </>
  );
}

function toLocal(iso: string): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}`;
}

export function GrowthInbox({
  campaigns,
  templates,
  connection,
  defaultSendAt,
  initialTab = 'proposed',
  approveAction,
  rejectAction,
  saveAction,
}: {
  campaigns: GrowthCampaign[];
  templates: GrowthTemplate[];
  connection: GrowthConnection;
  defaultSendAt: string;
  initialTab?: GrowthTab;
  approveAction: (formData: FormData) => void | Promise<void>;
  rejectAction: (formData: FormData) => void | Promise<void>;
  saveAction: (formData: FormData) => void | Promise<void>;
}) {
  const [tab, setTab] = useState<GrowthTab>(initialTab);
  const [draft, setDraft] = useState<GrowthCampaign | 'new' | null>(null);
  const editing = draft && draft !== 'new' ? draft : null;
  const visible = campaigns.filter((campaign) => campaignInTab(campaign.status, tab));

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <ConnectionChip connection={connection} />
        <Button type="button" className="min-h-11" onClick={() => setDraft('new')}>
          Create manual campaign
        </Button>
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (
            value === 'proposed' ||
            value === 'scheduled' ||
            value === 'sent' ||
            value === 'all'
          ) {
            setTab(value);
          }
        }}
      >
        <TabsList className="flex h-auto w-full flex-wrap justify-start">
          {TABS.map((item) => (
            <TabsTrigger key={item} value={item} className="min-h-11">
              {TAB_LABEL[item]} (
              {campaigns.filter((campaign) => campaignInTab(campaign.status, item)).length})
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={tab} className="mt-4">
          <p className="mb-4 text-sm text-text-muted">{TAB_HINT[tab]}</p>
          {visible.length === 0 ? (
            <SectionCard title="Nothing in this tab" titleLevel={2}>
              <p className="text-sm text-text-body">{EMPTY[tab]}</p>
            </SectionCard>
          ) : (
            <>
              <div data-testid="campaign-cards" className="space-y-3 md:hidden">
                {visible.map((campaign) => (
                  <SectionCard key={campaign.id} title={campaign.name} titleLevel={2}>
                    <div className="mb-3 flex flex-wrap gap-2">
                      <Badge variant="outline" mono>
                        {KIND_LABEL[campaign.kind]}
                      </Badge>
                      <StatusPill status={campaign.status} tone={TONE[campaign.status]} />
                    </div>
                    <dl className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <dt className="text-text-muted">Sends</dt>
                        <dd>{formatWhen(campaign.sendAt)}</dd>
                      </div>
                      <div>
                        <dt className="text-text-muted">Reach</dt>
                        <dd className="tabular-nums">{campaign.estimatedReach}</dd>
                      </div>
                      <div>
                        <dt className="text-text-muted">Discount</dt>
                        <dd>{formatDiscount(campaign.discountType, campaign.discountValue)}</dd>
                      </div>
                      <div>
                        <dt className="text-text-muted">Cap</dt>
                        <dd>{formatPkr(campaign.budgetCapMinor)}</dd>
                      </div>
                    </dl>
                    <p
                      className="mt-3 line-clamp-2 text-sm text-text-muted"
                      title={campaign.rationale ?? undefined}
                    >
                      {campaign.rationale ?? 'No rationale yet.'}
                    </p>
                    <div className="mt-4">
                      <CampaignActions
                        campaign={campaign}
                        onEdit={setDraft}
                        approveAction={approveAction}
                        rejectAction={rejectAction}
                      />
                    </div>
                  </SectionCard>
                ))}
              </div>
              <div data-testid="campaign-table" className="hidden min-w-0 md:block">
                <Table className="min-w-[960px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Sends</TableHead>
                      <TableHead numeric>Reach</TableHead>
                      <TableHead>Discount</TableHead>
                      <TableHead numeric>Cap</TableHead>
                      <TableHead>Why</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((campaign) => (
                      <TableRow key={campaign.id}>
                        <TableCell className="whitespace-normal">
                          <Link
                            href={`/growth/${campaign.id}`}
                            className="font-medium text-text-strong underline-offset-4 hover:underline"
                          >
                            {campaign.name}
                          </Link>
                          <p className="text-xs text-text-muted">Everyone opted in</p>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" mono>
                            {KIND_LABEL[campaign.kind]}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <StatusPill status={campaign.status} tone={TONE[campaign.status]} />
                        </TableCell>
                        <TableCell className="whitespace-normal text-text-muted">
                          {formatWhen(campaign.sendAt)}
                        </TableCell>
                        <TableCell numeric>{campaign.estimatedReach}</TableCell>
                        <TableCell>
                          {formatDiscount(campaign.discountType, campaign.discountValue)}
                        </TableCell>
                        <TableCell numeric>{formatPkr(campaign.budgetCapMinor)}</TableCell>
                        <TableCell className="max-w-xs whitespace-normal">
                          <p
                            className="line-clamp-2 text-sm text-text-muted"
                            title={campaign.rationale ?? undefined}
                          >
                            {campaign.rationale ?? '—'}
                          </p>
                        </TableCell>
                        <TableCell>
                          <CampaignActions
                            campaign={campaign}
                            onEdit={setDraft}
                            approveAction={approveAction}
                            rejectAction={rejectAction}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit campaign' : 'New campaign'}</DialogTitle>
            <DialogDescription>
              It stays a proposal until you approve it, unless the budget is under the auto-approve
              amount.
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <form key={editing?.id ?? 'new'} action={saveAction} className="grid gap-4">
              <CampaignFields
                campaign={editing}
                templates={templates}
                defaultSendAt={defaultSendAt}
              />
              <DialogFooter>
                <PendingButton pendingLabel="Saving…" className="min-h-11">
                  Save proposal
                </PendingButton>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
