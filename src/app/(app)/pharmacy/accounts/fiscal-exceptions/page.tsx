import type { Metadata } from 'next';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { formatWorkspaceDateTime, workspaceZoneLabel } from '@/lib/timezone';
import {
  FISCAL_EXCEPTION_COVERAGE, FISCAL_EXCEPTION_NOTICE,
  type FiscalExceptionRegister,
} from '@/lib/pharmacy/accounts/fiscal-exceptions';
import { loadFiscalExceptionRegister } from './access';
import {
  fiscalExceptionError, fiscalExceptionHref, fiscalExceptionQuery, type FiscalExceptionQuery,
} from './query';

export const metadata: Metadata = { title: 'Fiscal exception evidence · Pharmacy accounts' };

export default async function FiscalExceptionsPage({ searchParams }: {
  searchParams: Promise<FiscalExceptionQuery>;
}) {
  const query = await searchParams;
  let input: ReturnType<typeof fiscalExceptionQuery> | null = null;
  let register: FiscalExceptionRegister | null = null;
  let error: string | null = null;
  try {
    input = fiscalExceptionQuery(query);
    register = await loadFiscalExceptionRegister(input);
  } catch (cause) {
    error = fiscalExceptionError(cause);
  }
  const scalar = (value: unknown) => typeof value === 'string' ? value : '';
  // Recorded instants and the creation window are both on the organisation's clock.
  const shopTime = (value: string) => (
    <time dateTime={value}>{formatWorkspaceDateTime(value, register?.timeZone)}</time>
  );

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader eyebrow="Pharmacy accounts" heading="Fiscal exception evidence"
        description="Inspect local queued, rejected and dead fiscal documents for one active branch." />
      <p className="text-sm text-text-muted">{FISCAL_EXCEPTION_NOTICE}</p>
      <SectionCard title="Branch and creation window">
        <form action="/pharmacy/accounts/fiscal-exceptions" className="grid gap-4 md:grid-cols-2">
          <label className="text-sm text-text-body">
            Active branch ID
            <Input name="branchId" defaultValue={scalar(input?.branchId ?? query.branchId)} required maxLength={128}
              className="mt-1 min-h-11" aria-describedby="fiscal-window-help" />
          </label>
          <label className="text-sm text-text-body">
            Created from
            <Input name="from" type="date" defaultValue={scalar(register?.filters.from ?? input?.from ?? query.from)} required className="mt-1 min-h-11" />
          </label>
          <label className="text-sm text-text-body">
            Created before (not included)
            <Input name="to" type="date" defaultValue={scalar(register?.filters.to ?? input?.to ?? query.to)} required className="mt-1 min-h-11" />
          </label>
          <label className="text-sm text-text-body">
            Rows per page
            <Input name="pageSize" type="number" min={1} max={100} required
              defaultValue={Number.isFinite(input?.pageSize) ? input?.pageSize : 50} className="mt-1 min-h-11" />
          </label>
          <p id="fiscal-window-help" className="text-sm text-text-muted md:col-span-2">
            Use the branch ID from your workspace administrator. Maximum 92 days, excluding the end date.
            {register ? ` Days run midnight to midnight, ${workspaceZoneLabel(register.timeZone)} time.` : ''}
            {' '}Filters restart at page 1. Schedule values are recorded metadata; they do not trigger work.
          </p>
          <Button type="submit" size="touch">Apply evidence window</Button>
        </form>
      </SectionCard>
      {error ? (
        <SectionCard title="Evidence unavailable">
          <p role="alert" className="text-sm text-text-muted">{error}</p>
          <Button disabled variant="secondary" size="touch" className="mt-4">Download page CSV</Button>
        </SectionCard>
      ) : null}
      {register ? (
        <SectionCard title="Current local exceptions">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <StatusPill status={register.configuredMode} label={`Configured: ${register.configuredMode}`} />
            <p className="min-w-0 break-words text-sm text-text-body">{register.branch.name} · {register.branch.id}</p>
            <a href={fiscalExceptionHref(register.filters, true)}
              className={buttonVariants({ variant: 'secondary', size: 'touch' })}>Download page CSV</a>
          </div>
          <p className="mb-3 text-sm text-text-muted">{FISCAL_EXCEPTION_COVERAGE}</p>
          <p className="mb-4 break-words text-xs text-text-muted">
            Read started {shopTime(register.readAt)}. Created from {register.filters.from} up to (not
            including) {register.filters.to}. CSV downloads re-read this page and may differ from the screen.
          </p>
          <div role="region" aria-label="Fiscal exception documents" tabIndex={0}
            className="overflow-x-auto rounded-md border border-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <table className="w-full min-w-[1000px] text-sm tabular-nums">
              <thead className="bg-surface-sunken font-mono text-xs uppercase text-text-muted">
                <tr>
                  {['Local document reference', 'Kind', 'Document mode', 'State', 'Attempts / limit',
                    'Next recorded attempt', 'Created / updated'].map((label, index) => (
                    <th key={label} scope="col" className={`p-3 ${index === 4 ? 'text-right' : 'text-left'}`}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {register.rows.map((row) => (
                  <tr key={row.id} className="hover:bg-surface-sunken">
                    <th scope="row" className="max-w-64 break-words p-3 text-left font-medium text-text-strong">
                      {row.localReference}<span className="mt-1 block font-mono text-xs text-text-muted">{row.id}</span>
                    </th>
                    <td className="p-3">{row.kind}</td>
                    <td className="p-3"><StatusPill status={row.integratorMode} /></td>
                    <td className="p-3"><StatusPill status={row.status} tone={row.status === 'QUEUED' ? 'warning' : 'danger'} /></td>
                    <td className="p-3 text-right">{row.attempts} / {row.maxAttempts}</td>
                    <td className="p-3 text-xs">{row.nextAttemptAt ? shopTime(row.nextAttemptAt) : 'Not recorded'}</td>
                    <td className="p-3 text-xs">{shopTime(row.createdAt)}<br />{shopTime(row.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!register.rows.length ? (
            <p className="mt-4 text-sm text-text-muted">
              No matching current exceptions were returned on this page. Try page 1 or adjust the branch and window.
              Missing evidence is unknown; this does not establish compliance.
            </p>
          ) : null}
          <p className="mt-4 text-sm text-text-muted" role="status">
            Page {register.filters.page + 1} of at most 20 · {register.rows.length} rows · Total unknown.
            {' '}{register.hasMoreAtRead ? 'Page capped; additional matches existed at read time.' : 'No further matches observed at read time.'}
            {' '}{register.pageCapReached ? 'Pagination cap reached. Narrow the creation window to inspect more evidence.' : ''}
          </p>
          <nav aria-label="Evidence pages" className="mt-4 flex flex-wrap gap-3">
            {register.filters.page > 0 ? (
              <Link className={buttonVariants({ variant: 'outline', size: 'touch' })}
                href={fiscalExceptionHref({ ...register.filters, page: register.filters.page - 1 })}>Previous page</Link>
            ) : <Button disabled variant="outline" size="touch">Previous page</Button>}
            {register.nextPage !== null ? (
              <Link className={buttonVariants({ variant: 'outline', size: 'touch' })}
                href={fiscalExceptionHref({ ...register.filters, page: register.nextPage })}>Next page</Link>
            ) : <Button disabled variant="outline" size="touch">Next page</Button>}
          </nav>
        </SectionCard>
      ) : null}
    </div>
  );
}
