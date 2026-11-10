import Link from 'next/link';
import { ArrowRight, Plus } from 'lucide-react';
import {
  PlatformCommandButton,
  PlatformCommandForm,
} from '@/components/platform/platform-command-form';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { requirePlatformRead } from '@/lib/platform/page-access';

const stages = ['DISCOVERY', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'] as const;

function money(value: number | null, currency: string) {
  if (value === null) return 'Value pending';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export default async function CrmPage() {
  await requirePlatformRead('/platform/crm');
  const data = await withPlatformDb(async (db) => {
    const [accounts, leads, opportunities, proposals, followUps] = await Promise.all([
      db.platformAccount.findMany({
        orderBy: { updatedAt: 'desc' },
        include: {
          contacts: { orderBy: { isPrimary: 'desc' }, take: 2 },
          _count: { select: { opportunities: true } },
        },
        take: 100,
      }),
      db.platformLead.findMany({
        orderBy: { createdAt: 'desc' },
        include: { account: { select: { name: true } } },
        take: 100,
      }),
      db.platformOpportunity.findMany({
        orderBy: { updatedAt: 'desc' },
        include: { account: { select: { name: true } }, _count: { select: { proposals: true } } },
        take: 200,
      }),
      db.platformProposal.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          opportunity: { select: { name: true, account: { select: { name: true } } } },
        },
        take: 100,
      }),
      db.platformFollowUp.findMany({
        where: { status: 'OPEN' },
        orderBy: { dueAt: 'asc' },
        include: {
          account: { select: { name: true } },
          lead: { select: { name: true } },
          opportunity: { select: { name: true } },
        },
        take: 100,
      }),
    ]);
    return {
      accounts,
      leads,
      opportunities: opportunities.map((item) => ({
        ...item,
        estimatedValue: item.estimatedValue === null ? null : Number(item.estimatedValue),
      })),
      proposals: proposals.map((item) => ({ ...item, total: Number(item.total) })),
      followUps,
    };
  });
  const accountOptions = data.accounts.map((item) => ({ label: item.name, value: item.id }));
  const opportunityOptions = data.opportunities
    .filter((item) => !['WON', 'LOST'].includes(item.stage))
    .map((item) => ({ label: `${item.account.name} · ${item.name}`, value: item.id }));

  return (
    <div className="mx-auto max-w-[1600px]">
      <PlatformPageHeading
        eyebrow="Sales / full-funnel CRM"
        title="Sales command"
        description="Leads, account relationships, opportunities, proposals, follow-ups, and conversion into a manually activated organization."
      />

      <section className="mt-7">
        <div className="mb-3 flex items-end justify-between">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-accent-brand">
              Pipeline
            </p>
            <h2 id="opportunity-board-title" className="mt-1 font-display text-xl font-semibold">
              Opportunity board
            </h2>
          </div>
          <span className="font-mono text-[9px] text-text-muted">
            {data.opportunities.length} records
          </span>
        </div>
        <div
          role="region"
          aria-labelledby="opportunity-board-title"
          tabIndex={0}
          className="grid auto-cols-[260px] grid-flow-col gap-3 overflow-x-auto pb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {stages.map((stage, stageIndex) => {
            const items = data.opportunities.filter((item) => item.stage === stage);
            return (
              <div
                key={stage}
                className="min-w-[260px] overflow-hidden rounded-lg border border-border-subtle bg-card"
              >
                <div className="flex items-center justify-between border-b border-border-subtle bg-surface-sunken/60 px-3 py-3">
                  <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em]">
                    {stage}
                  </span>
                  <span className="font-mono text-[9px] text-text-muted">{items.length}</span>
                </div>
                <div className="space-y-2 p-2">
                  {items.map((opportunity) => (
                    <article
                      key={opportunity.id}
                      className="rounded-lg border border-border-subtle bg-card p-3"
                    >
                      <p className="text-xs font-semibold">{opportunity.name}</p>
                      <p className="mt-1 text-[10px] text-text-muted">{opportunity.account.name}</p>
                      <p className="mt-3 font-display text-lg font-semibold">
                        {money(opportunity.estimatedValue, opportunity.currency)}
                      </p>
                      <div className="mt-3 flex items-center justify-between">
                        <span className="font-mono text-[9px] text-text-muted">
                          {opportunity.probability}% · {opportunity._count.proposals} proposal
                        </span>
                        {stageIndex < 4 ? (
                          <PlatformCommandButton
                            action="crm.opportunity.stage"
                            label="Advance"
                            tone="quiet"
                            payload={{
                              id: opportunity.id,
                              stage: stages[stageIndex + 1],
                              probability: Math.max(
                                opportunity.probability,
                                [10, 25, 50, 75, 100][stageIndex + 1] ?? 100
                              ),
                              reason: 'Advanced by platform sales operator',
                              lossReason: null,
                            }}
                          />
                        ) : null}
                      </div>
                      {opportunity.stage !== 'LOST' && !opportunity.convertedOrganizationId ? (
                        <Link
                          href={`/platform/organizations/new?opportunityId=${opportunity.id}`}
                          className="mt-3 flex items-center justify-between border-t border-border-subtle pt-3 text-[10px] font-semibold text-accent-brand"
                        >
                          Convert to organization
                          <ArrowRight className="h-3 w-3" />
                        </Link>
                      ) : null}
                    </article>
                  ))}
                  {!items.length ? (
                    <p className="px-2 py-8 text-center text-[10px] text-text-faint">No records</p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="mt-7 grid gap-7 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-7">
          <section className="border border-border-default bg-surface-card">
            <div className="border-b border-border-subtle px-5 py-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-accent-brand">
                Prospect intake
              </p>
              <h2 id="leads-title" className="mt-1 font-display text-xl font-semibold">
                Leads
              </h2>
            </div>
            <div
              role="region"
              aria-labelledby="leads-title"
              tabIndex={0}
              className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <table className="w-full min-w-[700px] text-left">
                <thead className="bg-surface-sunken/60 font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">
                  <tr>
                    <th className="px-4 py-3">Lead</th>
                    <th className="px-4 py-3">Company</th>
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Opened</th>
                    <th className="px-4 py-3">Control</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {data.leads.map((lead) => (
                    <tr key={lead.id}>
                      <td className="px-4 py-3">
                        <p className="text-xs font-semibold">{lead.name}</p>
                        <p className="mt-1 text-[10px] text-text-muted">
                          {lead.email ?? lead.phone ?? 'No contact'}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {lead.account?.name ?? lead.companyName ?? 'Unassigned'}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {lead.source ?? 'Direct'}
                        {lead.source?.startsWith('workspace-request:') && (
                          <div className="mt-2 flex flex-col gap-3">
                            <a
                              className="underline underline-offset-4"
                              href={`/api/platform/workspace-requests/${lead.id}`}
                            >
                              Download request details
                            </a>
                            {lead.source === 'workspace-request:pharmacy' && (
                              <a
                                className="underline underline-offset-4"
                                href={`/api/platform/workspace-requests/${lead.id}?document=1`}
                              >
                                Download licence copy
                              </a>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <PlatformStatus value={lead.status} />
                      </td>
                      <td className="px-4 py-3 font-mono text-[9px]">
                        {lead.createdAt.toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          {lead.status === 'NEW' ? (
                            <>
                              <PlatformCommandButton
                                action="crm.lead.status"
                                label="Qualify"
                                payload={{ id: lead.id, status: 'QUALIFIED' }}
                              />
                              <PlatformCommandButton
                                action="crm.lead.status"
                                label="Disqualify"
                                tone="quiet"
                                payload={{ id: lead.id, status: 'DISQUALIFIED' }}
                              />
                            </>
                          ) : null}
                          {lead.status === 'QUALIFIED' ? (
                            <PlatformCommandButton
                              action="crm.lead.status"
                              label="Convert"
                              payload={{ id: lead.id, status: 'CONVERTED' }}
                            />
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="border border-border-default bg-surface-card">
            <div className="border-b border-border-subtle px-5 py-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-accent-brand">
                Relationship map
              </p>
              <h2 className="mt-1 font-display text-xl font-semibold">Accounts</h2>
            </div>
            <div className="grid gap-px bg-border-subtle md:grid-cols-2">
              {data.accounts.map((account) => (
                <article key={account.id} className="bg-surface-card p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">{account.name}</p>
                      <p className="mt-1 text-[10px] text-text-muted">
                        {[account.industry, account.country].filter(Boolean).join(' · ') ||
                          'Profile pending'}
                      </p>
                    </div>
                    <PlatformStatus value={account.status} />
                  </div>
                  <p className="mt-4 font-mono text-[9px] text-text-muted">
                    {account._count.opportunities} opportunities · {account.contacts.length}{' '}
                    contacts
                  </p>
                </article>
              ))}
            </div>
          </section>

          <section className="border border-border-default bg-surface-card">
            <div className="border-b border-border-subtle px-5 py-4">
              <h2 className="font-display text-xl font-semibold">Proposals</h2>
            </div>
            <div className="divide-y divide-border-subtle">
              {data.proposals.map((proposal) => (
                <div
                  key={proposal.id}
                  className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center"
                >
                  <div>
                    <p className="text-xs font-semibold">
                      {proposal.number} · {proposal.title}
                    </p>
                    <p className="mt-1 text-[10px] text-text-muted">
                      {proposal.opportunity.account.name} · {proposal.opportunity.name}
                    </p>
                  </div>
                  <span className="font-mono text-[10px] font-semibold">
                    {money(proposal.total, proposal.currency)}
                  </span>
                  <PlatformStatus value={proposal.status} />
                  <div className="flex gap-2">
                    {proposal.status === 'DRAFT' ? (
                      <PlatformCommandButton
                        action="crm.proposal.status"
                        label="Send"
                        payload={{ id: proposal.id, status: 'SENT' }}
                      />
                    ) : null}
                    {proposal.status === 'SENT' ? (
                      <>
                        <PlatformCommandButton
                          action="crm.proposal.status"
                          label="Accept"
                          payload={{ id: proposal.id, status: 'ACCEPTED' }}
                        />
                        <PlatformCommandButton
                          action="crm.proposal.status"
                          label="Reject"
                          tone="quiet"
                          payload={{ id: proposal.id, status: 'REJECTED' }}
                        />
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="space-y-7">
          <section className="border border-border-default bg-abyss-900 p-5 text-paper-50">
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-primary-foreground">
              Follow-up queue
            </p>
            <h2 className="mt-1 font-display text-xl font-semibold">Next touches</h2>
            <div className="mt-4 divide-y divide-white/10">
              {data.followUps.map((followUp) => (
                <div key={followUp.id} className="py-3">
                  <div className="flex justify-between gap-3">
                    <p className="text-xs font-semibold text-primary-foreground">
                      {followUp.title}
                    </p>
                    <span className="font-mono text-[9px] text-primary-foreground">
                      {followUp.dueAt.toLocaleDateString()}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] text-abyss-200">
                    {followUp.opportunity?.name ?? followUp.lead?.name ?? followUp.account?.name}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <PlatformCommandButton
                      action="crm.followup.status"
                      label="Complete"
                      payload={{ id: followUp.id, status: 'COMPLETED' }}
                    />
                    <PlatformCommandButton
                      action="crm.followup.status"
                      label="Cancel"
                      tone="quiet"
                      payload={{ id: followUp.id, status: 'CANCELLED' }}
                    />
                  </div>
                </div>
              ))}
              {!data.followUps.length ? (
                <p className="py-7 text-xs text-abyss-200">No open follow-ups.</p>
              ) : null}
            </div>
          </section>

          {[
            {
              summary: 'Add account',
              form: (
                <PlatformCommandForm
                  compact
                  action="crm.account.create"
                  submitLabel="Create account"
                  fields={[
                    {
                      name: 'name',
                      minLength: 1,
                      maxLength: 500,
                      label: 'Account name',
                      required: true,
                    },
                    { name: 'legalName', maxLength: 5000, label: 'Legal name' },
                    { name: 'website', maxLength: 2000, label: 'Website', type: 'url' },
                    { name: 'industry', maxLength: 5000, label: 'Industry' },
                    { name: 'country', maxLength: 5000, label: 'Country' },
                    { name: 'source', maxLength: 5000, label: 'Source' },
                    { name: 'notes', maxLength: 5000, label: 'Notes', type: 'textarea' },
                  ]}
                />
              ),
            },
            {
              summary: 'Add lead',
              form: (
                <PlatformCommandForm
                  compact
                  action="crm.lead.create"
                  submitLabel="Create lead"
                  fields={[
                    {
                      name: 'accountId',
                      label: 'Account',
                      type: 'select',
                      options: accountOptions,
                    },
                    {
                      name: 'name',
                      minLength: 1,
                      maxLength: 500,
                      label: 'Lead name',
                      required: true,
                    },
                    { name: 'email', maxLength: 254, label: 'Email', type: 'email' },
                    { name: 'phone', maxLength: 5000, label: 'Phone' },
                    { name: 'companyName', maxLength: 5000, label: 'Company' },
                    { name: 'source', maxLength: 5000, label: 'Source' },
                    { name: 'notes', maxLength: 5000, label: 'Notes', type: 'textarea' },
                  ]}
                />
              ),
            },
            {
              summary: 'Open opportunity',
              form: (
                <PlatformCommandForm
                  compact
                  action="crm.opportunity.create"
                  submitLabel="Create opportunity"
                  fields={[
                    {
                      name: 'accountId',
                      label: 'Account',
                      type: 'select',
                      required: true,
                      options: accountOptions,
                    },
                    {
                      name: 'name',
                      minLength: 1,
                      maxLength: 500,
                      label: 'Opportunity',
                      required: true,
                    },
                    {
                      name: 'stage',
                      label: 'Stage',
                      type: 'select',
                      required: true,
                      defaultValue: 'DISCOVERY',
                      options: stages.map((value) => ({ label: value, value })),
                    },
                    {
                      name: 'estimatedValue',
                      label: 'Estimated value',
                      type: 'number',
                      min: 0,
                      step: 0.01,
                    },
                    {
                      name: 'currency',
                      minLength: 3,
                      maxLength: 3,
                      label: 'Currency',
                      defaultValue: 'USD',
                    },
                    {
                      name: 'probability',
                      label: 'Probability',
                      type: 'number',
                      defaultValue: 10,
                      min: 0,
                      max: 100,
                    },
                    { name: 'expectedCloseAt', label: 'Expected close', type: 'date' },
                    { name: 'notes', maxLength: 5000, label: 'Notes', type: 'textarea' },
                  ]}
                />
              ),
            },
            {
              summary: 'Draft proposal',
              form: (
                <PlatformCommandForm
                  compact
                  action="crm.proposal.create"
                  submitLabel="Create proposal"
                  fields={[
                    {
                      name: 'opportunityId',
                      label: 'Opportunity',
                      type: 'select',
                      required: true,
                      options: opportunityOptions,
                    },
                    {
                      name: 'number',
                      minLength: 3,
                      maxLength: 100,
                      label: 'Proposal number',
                      required: true,
                    },
                    {
                      name: 'title',
                      minLength: 1,
                      maxLength: 500,
                      label: 'Title',
                      required: true,
                    },
                    {
                      name: 'currency',
                      minLength: 3,
                      maxLength: 3,
                      label: 'Currency',
                      defaultValue: 'USD',
                    },
                    {
                      name: 'total',
                      label: 'Total',
                      type: 'number',
                      required: true,
                      min: 0,
                      step: 0.01,
                    },
                    { name: 'validUntil', label: 'Valid until', type: 'date' },
                    {
                      name: 'lineItems',
                      label: 'Line items',
                      type: 'json',
                      required: true,
                      defaultValue: [
                        { description: 'Platform subscription', quantity: 1, unitPrice: 0 },
                      ],
                    },
                  ]}
                />
              ),
            },
          ].map((item) => (
            <details
              key={item.summary}
              className="group border border-border-default bg-surface-card"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-xs font-semibold">
                {item.summary}
                <Plus className="h-4 w-4 transition group-open:rotate-45" />
              </summary>
              <div className="border-t border-border-subtle px-5">{item.form}</div>
            </details>
          ))}
        </aside>
      </div>
    </div>
  );
}
