import { SectionCard } from '@/components/ui/section-card';
import { supplierCreditFollowUp } from '@/lib/pharmacy/supplier-credit-follow-up';

const LIMIT = 5;
const linkClass =
  'inline-flex min-h-11 items-center rounded-sm text-sm font-medium text-text-strong underline underline-offset-4 hover:text-text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const money = (value: number) =>
  `PKR ${(value / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (value: number) =>
  `${new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(value)} UTC`;

export function FollowUpQueue({
  queue,
  branchId,
}: {
  queue: ReturnType<typeof supplierCreditFollowUp>;
  branchId: string;
}) {
  const returnHref = (id: string) =>
    `/pharmacy/purchasing/returns?${new URLSearchParams({ branch: branchId, return: id })}`;
  return (
    <SectionCard title="Supplier-credit follow-up" titleLevel={2}>
      <p className="text-sm text-text-muted">
        As of {date(Date.parse(queue.asOf))}. Age is days since the debit note was issued, not days
        overdue. Reload the page to update.
      </p>
      <p className="mt-2 text-sm text-text-muted">
        Amounts still owed, credit already allocated and credit received but not yet allocated are
        shown separately. The same credit can appear next to more than one claim, so do not add it
        up across claims. None of this is cash received or sales.
      </p>
      {queue.coverage === 'partial' ? (
        <p role="status" className="mt-3 text-sm text-warning">
          Partial list. Some older claims or credits may be missing, so these are not branch totals.
        </p>
      ) : null}
      {queue.excluded > 0 ? (
        <p role="status" className="mt-3 text-sm text-warning">
          {queue.excluded} records excluded because their branch or amounts could not be checked.
          Review them before settling credit.
        </p>
      ) : null}
      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="font-medium text-text-strong">Debit notes still owed · oldest first</h3>
          <p className="text-xs text-text-muted">
            Showing {Math.min(LIMIT, queue.claims.length)} of {queue.claims.length} debit notes.
          </p>
          {queue.claims.length === 0 ? (
            <p className="mt-3 text-sm text-text-muted">No debit notes are waiting for credit.</p>
          ) : (
            <ol className="mt-3 divide-y divide-border-subtle">
              {queue.claims.slice(0, LIMIT).map((claim) => (
                <li key={claim.id} className="py-3 break-words">
                  <a className={linkClass} href={returnHref(claim.returnId)}>
                    {claim.reference} · {claim.supplier}
                  </a>
                  <p className="text-sm text-text-body">
                    {claim.ageDays === null
                      ? 'Issue date unknown'
                      : `${claim.ageDays} days since issued`}{' '}
                    · {money(claim.outstandingMinor)} outstanding · {money(claim.allocatedMinor)}{' '}
                    allocated
                  </p>
                  {claim.credits.length ? (
                    <>
                      <p className="mt-2 text-sm text-text-body">
                        Unallocated credit from this supplier to check:
                      </p>
                      <ul>
                        {claim.credits.slice(0, LIMIT).map((credit) => (
                          <li key={credit.id}>
                            <a
                              className={linkClass}
                              href={`${returnHref(claim.returnId)}#credit-${encodeURIComponent(credit.id)}`}
                            >
                              {credit.reference} · {money(credit.unallocatedMinor)} unallocated
                            </a>
                          </li>
                        ))}
                        {claim.credits.length > LIMIT ? (
                          <li className="text-xs text-text-muted">
                            Showing {LIMIT} of {claim.credits.length} credits. See Supplier credit
                            below.
                          </li>
                        ) : null}
                      </ul>
                    </>
                  ) : (
                    <p className="mt-2 text-sm text-text-muted">
                      No unallocated credit from this supplier yet. Follow up with the supplier.
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="font-medium text-text-strong">
            Returns waiting to be sent · open deadlines first
          </h3>
          <p className="text-xs text-text-muted">
            Showing {Math.min(LIMIT, queue.dispatch.length)} of {queue.dispatch.length} returns.
          </p>
          {queue.dispatch.length === 0 ? (
            <p className="mt-3 text-sm text-text-muted">
              No submitted returns are waiting to be sent.
            </p>
          ) : (
            <ol className="mt-3 divide-y divide-border-subtle">
              {queue.dispatch.slice(0, LIMIT).map((row) => (
                <li key={row.id} className="py-3 break-words">
                  <a className={linkClass} href={returnHref(row.id)}>
                    {row.reference} · {row.supplier}
                  </a>
                  <p className="text-sm text-text-body">
                    {row.state === 'closed'
                      ? 'Deadline passed — do not dispatch.'
                      : row.state === 'unknown'
                        ? 'Deadline unknown — check the return window dates before sending.'
                        : 'Send it before the deadline. The return checks this again when you dispatch it.'}
                  </p>
                  {row.deadline !== null ? (
                    <p className="text-xs text-text-muted">
                      Earliest deadline: {date(row.deadline)}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
