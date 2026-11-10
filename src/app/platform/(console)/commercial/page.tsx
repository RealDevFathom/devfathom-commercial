import { Plus } from 'lucide-react';
import {
  PlatformCommandButton,
  PlatformCommandForm,
} from '@/components/platform/platform-command-form';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { requirePlatformRead } from '@/lib/platform/page-access';

function money(value: number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export default async function CommercialPage() {
  await requirePlatformRead('/platform/commercial');
  const data = await withPlatformDb(async (db) => {
    const [organizations, opportunities, modules, contracts, invoices, payments, renewals] =
      await Promise.all([
        db.organization.findMany({
          where: { status: { notIn: ['PURGED'] } },
          orderBy: { displayName: 'asc' },
          select: { id: true, displayName: true, currency: true },
        }),
        db.platformOpportunity.findMany({
          where: { stage: { not: 'LOST' } },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, account: { select: { name: true } } },
        }),
        db.platformModule.findMany({
          where: { active: true },
          orderBy: { sortOrder: 'asc' },
          select: { id: true, name: true },
        }),
        db.platformContract.findMany({
          orderBy: { endDate: 'asc' },
          include: {
            organization: { select: { displayName: true } },
            modules: { include: { module: { select: { name: true } } } },
            _count: { select: { invoices: true, renewals: true } },
          },
          take: 250,
        }),
        db.platformInvoice.findMany({
          orderBy: { dueAt: 'desc' },
          include: {
            organization: { select: { displayName: true } },
            _count: { select: { payments: true } },
          },
          take: 250,
        }),
        db.platformPayment.findMany({
          orderBy: { createdAt: 'desc' },
          include: {
            organization: { select: { displayName: true } },
            invoice: { select: { number: true } },
          },
          take: 100,
        }),
        db.platformRenewal.findMany({
          orderBy: { dueAt: 'asc' },
          include: {
            organization: { select: { displayName: true } },
            contract: { select: { number: true } },
          },
          take: 100,
        }),
      ]);
    return {
      organizations,
      opportunities,
      modules,
      contracts: contracts.map((item) => ({ ...item, value: Number(item.value) })),
      invoices: invoices.map((item) => ({
        ...item,
        subtotal: Number(item.subtotal),
        tax: Number(item.tax),
        total: Number(item.total),
      })),
      payments: payments.map((item) => ({ ...item, amount: Number(item.amount) })),
      renewals: renewals.map((item) => ({
        ...item,
        proposedValue: item.proposedValue === null ? null : Number(item.proposedValue),
      })),
    };
  });
  const organizationOptions = data.organizations.map((item) => ({
    label: item.displayName,
    value: item.id,
  }));
  const contractOptions = data.contracts.map((item) => ({
    label: `${item.organization.displayName} · ${item.number}`,
    value: item.id,
  }));
  const invoiceOptions = data.invoices
    .filter((item) => item.status !== 'PAID')
    .map((item) => ({
      label: `${item.organization.displayName} · ${item.number} · ${money(item.total, item.currency)}`,
      value: item.id,
    }));
  const activeContractValue = data.contracts
    .filter((item) => item.status === 'ACTIVE')
    .reduce((sum, item) => sum + item.value, 0);
  const receivables = data.invoices
    .filter((item) => !['PAID', 'VOID'].includes(item.status))
    .reduce((sum, item) => sum + item.total, 0);

  return (
    <div className="mx-auto max-w-[1600px]">
      <PlatformPageHeading
        eyebrow="Commercial / contract ledger"
        title="Commercial control"
        description="Contract value, seats, modules, expiry, grace, renewals, invoices, and cash application in one auditable ledger."
      />

      <section className="mt-7 grid gap-px overflow-hidden rounded-lg border border-border-subtle bg-border-subtle shadow-none md:grid-cols-3">
        {[
          [
            'Active contracted value',
            money(activeContractValue, 'USD'),
            `${data.contracts.filter((item) => item.status === 'ACTIVE').length} contracts`,
          ],
          [
            'Open receivables',
            money(receivables, 'USD'),
            `${data.invoices.filter((item) => !['PAID', 'VOID'].includes(item.status)).length} invoices`,
          ],
          [
            'Renewal book',
            String(data.renewals.filter((item) => item.status === 'UPCOMING').length),
            'upcoming renewal records',
          ],
        ].map(([label, value, detail]) => (
          <article key={label} className="bg-card p-5">
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
              {label}
            </p>
            <p className="mt-5 font-display text-3xl font-semibold tracking-[-0.04em] text-text-strong">
              {value}
            </p>
            <p className="mt-2 text-xs text-text-muted">{detail}</p>
          </article>
        ))}
      </section>

      <div className="mt-7 grid gap-7 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-7">
          <section className="overflow-x-auto border border-border-default bg-surface-card">
            <div className="border-b border-border-subtle px-5 py-4">
              <h2 className="font-display text-xl font-semibold">Contracts</h2>
            </div>
            <table className="w-full min-w-[900px] text-left">
              <thead className="bg-surface-sunken/60 font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">
                <tr>
                  <th className="px-4 py-3">Contract</th>
                  <th className="px-4 py-3">Organization</th>
                  <th className="px-4 py-3">Value</th>
                  <th className="px-4 py-3">Seats / modules</th>
                  <th className="px-4 py-3">Term</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Control</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {data.contracts.map((contract) => (
                  <tr key={contract.id}>
                    <td className="px-4 py-4">
                      <p className="text-xs font-semibold">{contract.number}</p>
                      <p className="mt-1 text-[10px] text-text-muted">{contract.title}</p>
                    </td>
                    <td className="px-4 py-4 text-xs">{contract.organization.displayName}</td>
                    <td className="px-4 py-4 font-mono text-[10px]">
                      {money(contract.value, contract.currency)}
                    </td>
                    <td className="px-4 py-4 text-xs">
                      {contract.seatLimit} seats · {contract.modules.length} modules
                    </td>
                    <td className="px-4 py-4 font-mono text-[9px]">
                      {contract.startDate.toLocaleDateString()} →{' '}
                      {contract.endDate.toLocaleDateString()}
                    </td>
                    <td className="px-4 py-4">
                      <PlatformStatus value={contract.status} />
                    </td>
                    <td className="px-4 py-4">
                      <details className="min-w-48">
                        <summary className="cursor-pointer text-[10px] font-semibold text-accent-brand">
                          Change status
                        </summary>
                        <PlatformCommandForm
                          compact
                          action="commercial.contract.status"
                          submitLabel="Apply"
                          fields={[
                            {
                              name: 'id',
                              label: 'Contract',
                              type: 'hidden',
                              defaultValue: contract.id,
                            },
                            {
                              name: 'status',
                              label: 'Status',
                              type: 'select',
                              required: true,
                              defaultValue: contract.status,
                              options: [
                                'DRAFT',
                                'ACTIVE',
                                'GRACE',
                                'EXPIRED',
                                'TERMINATED',
                                'RENEWAL_DUE',
                              ].map((value) => ({ label: value, value })),
                            },
                            {
                              name: 'reason',
                              minLength: 5,
                              maxLength: 500,
                              label: 'Reason',
                              type: 'textarea',
                              required: true,
                            },
                          ]}
                        />
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="overflow-x-auto border border-border-default bg-surface-card">
            <div className="border-b border-border-subtle px-5 py-4">
              <h2 className="font-display text-xl font-semibold">Invoice ledger</h2>
            </div>
            <table className="w-full min-w-[850px] text-left">
              <thead className="bg-surface-sunken/60 font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">
                <tr>
                  <th className="px-4 py-3">Invoice</th>
                  <th className="px-4 py-3">Organization</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Due</th>
                  <th className="px-4 py-3">Payments</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Control</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {data.invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="px-4 py-4 text-xs font-semibold">{invoice.number}</td>
                    <td className="px-4 py-4 text-xs">{invoice.organization.displayName}</td>
                    <td className="px-4 py-4 font-mono text-[10px]">
                      {money(invoice.total, invoice.currency)}
                    </td>
                    <td className="px-4 py-4 font-mono text-[9px]">
                      {invoice.dueAt.toLocaleDateString()}
                    </td>
                    <td className="px-4 py-4 text-xs">{invoice._count.payments}</td>
                    <td className="px-4 py-4">
                      <PlatformStatus value={invoice.status} />
                    </td>
                    <td className="px-4 py-4">
                      <details className="min-w-48">
                        <summary className="cursor-pointer text-[10px] font-semibold text-accent-brand">
                          Change status
                        </summary>
                        <PlatformCommandForm
                          compact
                          action="commercial.invoice.status"
                          submitLabel="Apply"
                          fields={[
                            {
                              name: 'id',
                              label: 'Invoice',
                              type: 'hidden',
                              defaultValue: invoice.id,
                            },
                            {
                              name: 'status',
                              label: 'Status',
                              type: 'select',
                              required: true,
                              defaultValue: invoice.status,
                              options: [
                                'DRAFT',
                                'ISSUED',
                                'PARTIALLY_PAID',
                                'PAID',
                                'OVERDUE',
                                'VOID',
                              ].map((value) => ({ label: value, value })),
                            },
                            {
                              name: 'reason',
                              minLength: 5,
                              maxLength: 500,
                              label: 'Reason',
                              type: 'textarea',
                              required: true,
                            },
                          ]}
                        />
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="grid gap-7 lg:grid-cols-2">
            <section className="border border-border-default bg-surface-card">
              <div className="border-b border-border-subtle px-5 py-4">
                <h2 className="font-display text-lg font-semibold">Recent payments</h2>
              </div>
              <div className="divide-y divide-border-subtle">
                {data.payments.map((payment) => (
                  <div
                    key={payment.id}
                    className="flex items-center justify-between gap-3 px-5 py-3.5"
                  >
                    <div>
                      <p className="text-xs font-semibold">{payment.organization.displayName}</p>
                      <p className="mt-1 font-mono text-[9px] text-text-muted">
                        {payment.invoice.number} · {payment.method ?? 'method pending'}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-[10px] font-semibold">
                        {money(payment.amount, payment.currency)}
                      </p>
                      <div className="mt-1">
                        <PlatformStatus value={payment.status} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="border border-border-default bg-surface-card">
              <div className="border-b border-border-subtle px-5 py-4">
                <h2 className="font-display text-lg font-semibold">Renewals</h2>
              </div>
              <div className="divide-y divide-border-subtle">
                {data.renewals.map((renewal) => (
                  <div
                    key={renewal.id}
                    className="flex items-center justify-between gap-3 px-5 py-3.5"
                  >
                    <div>
                      <p className="text-xs font-semibold">{renewal.organization.displayName}</p>
                      <p className="mt-1 font-mono text-[9px] text-text-muted">
                        {renewal.contract.number} · due {renewal.dueAt.toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <PlatformStatus value={renewal.status} />
                      {renewal.status === 'UPCOMING' ? (
                        <PlatformCommandButton
                          action="commercial.renewal.status"
                          label="Start"
                          payload={{ id: renewal.id, status: 'IN_PROGRESS' }}
                        />
                      ) : null}
                      {renewal.status === 'IN_PROGRESS' ? (
                        <div className="flex gap-2">
                          <PlatformCommandButton
                            action="commercial.renewal.status"
                            label="Renewed"
                            payload={{ id: renewal.id, status: 'RENEWED' }}
                          />
                          <PlatformCommandButton
                            action="commercial.renewal.status"
                            label="Lost"
                            tone="quiet"
                            payload={{ id: renewal.id, status: 'LOST' }}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>

        <aside className="space-y-4">
          {[
            {
              title: 'Create contract',
              form: (
                <PlatformCommandForm
                  compact
                  action="commercial.contract.create"
                  submitLabel="Create contract"
                  fields={[
                    {
                      name: 'organizationId',
                      label: 'Organization',
                      type: 'select',
                      required: true,
                      options: organizationOptions,
                    },
                    {
                      name: 'opportunityId',
                      label: 'Opportunity',
                      type: 'select',
                      options: data.opportunities.map((item) => ({
                        label: `${item.account.name} · ${item.name}`,
                        value: item.id,
                      })),
                    },
                    {
                      name: 'number',
                      minLength: 3,
                      maxLength: 100,
                      label: 'Contract number',
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
                      name: 'status',
                      label: 'Status',
                      type: 'select',
                      required: true,
                      defaultValue: 'DRAFT',
                      options: [
                        'DRAFT',
                        'ACTIVE',
                        'GRACE',
                        'EXPIRED',
                        'TERMINATED',
                        'RENEWAL_DUE',
                      ].map((value) => ({ label: value, value })),
                    },
                    {
                      name: 'currency',
                      minLength: 3,
                      maxLength: 3,
                      label: 'Currency',
                      defaultValue: 'USD',
                      required: true,
                    },
                    {
                      name: 'value',
                      label: 'Contract value',
                      type: 'number',
                      min: 0,
                      step: 0.01,
                      required: true,
                    },
                    {
                      name: 'billingInterval',
                      label: 'Billing interval',
                      type: 'select',
                      required: true,
                      defaultValue: 'ANNUAL',
                      options: ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'CUSTOM'].map((value) => ({
                        label: value,
                        value,
                      })),
                    },
                    {
                      name: 'seatLimit',
                      label: 'Seat limit',
                      type: 'number',
                      required: true,
                      min: 1,
                    },
                    { name: 'startDate', label: 'Start date', type: 'date', required: true },
                    { name: 'endDate', label: 'End date', type: 'date', required: true },
                    { name: 'graceUntil', label: 'Grace until', type: 'date' },
                    { name: 'autoRenew', label: 'Auto renew', type: 'checkbox' },
                    {
                      name: 'moduleIds',
                      label: 'Module IDs',
                      type: 'json',
                      defaultValue: data.modules.map((item) => item.id),
                      help: 'Remove IDs that are not included in this contract.',
                    },
                    { name: 'notes', maxLength: 5000, label: 'Notes', type: 'textarea' },
                  ]}
                />
              ),
            },
            {
              title: 'Create invoice',
              form: (
                <PlatformCommandForm
                  compact
                  action="commercial.invoice.create"
                  submitLabel="Create invoice"
                  fields={[
                    {
                      name: 'organizationId',
                      label: 'Organization',
                      type: 'select',
                      required: true,
                      options: organizationOptions,
                    },
                    {
                      name: 'contractId',
                      label: 'Contract',
                      type: 'select',
                      options: contractOptions,
                    },
                    {
                      name: 'number',
                      minLength: 3,
                      maxLength: 100,
                      label: 'Invoice number',
                      required: true,
                    },
                    {
                      name: 'currency',
                      minLength: 3,
                      maxLength: 3,
                      label: 'Currency',
                      defaultValue: 'USD',
                      required: true,
                    },
                    {
                      name: 'subtotal',
                      label: 'Subtotal',
                      type: 'number',
                      min: 0,
                      step: 0.01,
                      required: true,
                    },
                    {
                      name: 'tax',
                      label: 'Tax',
                      type: 'number',
                      min: 0,
                      step: 0.01,
                      defaultValue: 0,
                    },
                    { name: 'dueAt', label: 'Due date', type: 'date', required: true },
                    { name: 'issueNow', label: 'Issue now', type: 'checkbox' },
                    {
                      name: 'lineItems',
                      label: 'Line items',
                      type: 'json',
                      required: true,
                      defaultValue: [
                        { description: 'Platform subscription', quantity: 1, unitPrice: 0 },
                      ],
                    },
                    { name: 'notes', maxLength: 5000, label: 'Notes', type: 'textarea' },
                  ]}
                />
              ),
            },
            {
              title: 'Record payment',
              form: (
                <PlatformCommandForm
                  compact
                  action="commercial.payment.record"
                  submitLabel="Record payment"
                  fields={[
                    {
                      name: 'invoiceId',
                      label: 'Invoice',
                      type: 'select',
                      required: true,
                      options: invoiceOptions,
                    },
                    {
                      name: 'amount',
                      label: 'Amount',
                      type: 'number',
                      min: 0,
                      step: 0.01,
                      required: true,
                    },
                    {
                      name: 'currency',
                      minLength: 3,
                      maxLength: 3,
                      label: 'Currency',
                      defaultValue: 'USD',
                      required: true,
                    },
                    {
                      name: 'method',
                      minLength: 1,
                      maxLength: 500,
                      label: 'Payment method',
                      required: true,
                    },
                    { name: 'externalRef', maxLength: 5000, label: 'External reference' },
                    {
                      name: 'idempotencyKey',
                      minLength: 8,
                      maxLength: 200,
                      label: 'Idempotency key',
                      required: true,
                      placeholder: 'bank-ref-or-unique-key',
                    },
                    {
                      name: 'status',
                      label: 'Status',
                      type: 'select',
                      required: true,
                      defaultValue: 'SUCCEEDED',
                      options: ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'].map((value) => ({
                        label: value,
                        value,
                      })),
                    },
                    { name: 'failureReason', maxLength: 5000, label: 'Failure reason' },
                  ]}
                />
              ),
            },
            {
              title: 'Open renewal',
              form: (
                <PlatformCommandForm
                  compact
                  action="commercial.renewal.create"
                  submitLabel="Create renewal"
                  fields={[
                    {
                      name: 'organizationId',
                      label: 'Organization',
                      type: 'select',
                      required: true,
                      options: organizationOptions,
                    },
                    {
                      name: 'contractId',
                      label: 'Contract',
                      type: 'select',
                      required: true,
                      options: contractOptions,
                    },
                    { name: 'dueAt', label: 'Due date', type: 'date', required: true },
                    {
                      name: 'proposedValue',
                      label: 'Proposed value',
                      type: 'number',
                      min: 0,
                      step: 0.01,
                    },
                    { name: 'proposedSeats', label: 'Proposed seats', type: 'number', min: 1 },
                    { name: 'notes', maxLength: 5000, label: 'Notes', type: 'textarea' },
                  ]}
                />
              ),
            },
          ].map((item) => (
            <details
              key={item.title}
              className="group border border-border-default bg-surface-card"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-xs font-semibold">
                {item.title}
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
