import { SectionCard } from '@/components/ui/section-card';
import { supplierCreditFollowUp } from '@/lib/pharmacy/supplier-credit-follow-up';
import { formatUtcInstant } from '@/lib/utc-instant';

const LIMIT = 5;
const linkClass =
  'inline-flex min-h-11 items-center rounded-sm text-sm font-medium text-text-strong underline underline-offset-4 hover:text-text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const money = (value: number) =>
  `PKR ${(value / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (value: number) => formatUtcInstant(new Date(value));

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
        As of {date(Date.parse(queue.asOf))}. Age measures time since issue, not a contractual
        overdue deadline. Read-only priorities; reload for current records.
      </p>
      <p className="mt-2 text-sm text-text-muted">
        Outstanding claims, allocated credit and recorded-but-unallocated credit are separate.
        Matching credit may appear beside several claims; it is not reserved and must not be added
        across them. None proves cash recovered or sales revenue.
      </p>
      {queue.coverage === 'partial' ? (
        <p role="status" className="mt-3 text-sm text-warning">
          Partial results: capped source data. Older claims or matching credits may be missing;
          these are not branch totals.
        </p>
      ) : null}
      {queue.excluded > 0 ? (
        <p role="status" className="mt-3 text-sm text-warning">
          {queue.excluded} records excluded because scope or financial data could not be validated.
          Review source records before reconciliation.
        </p>
      ) : null}
      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="font-medium text-text-strong">Open issued debit notes · oldest first</h3>
          <p className="text-xs text-text-muted">
            Showing {Math.min(LIMIT, queue.claims.length)} of {queue.claims.length} qualifying
            loaded notes.
          </p>
          {queue.claims.length === 0 ? (
            <p className="mt-3 text-sm text-text-muted">
              No open issued debit notes in validated loaded records.
            </p>
          ) : (
            <ol className="mt-3 divide-y divide-border-subtle">
              {queue.claims.slice(0, LIMIT).map((claim) => (
                <li key={claim.id} className="py-3 break-words">
                  <a className={linkClass} href={returnHref(claim.returnId)}>
                    {claim.reference} · {claim.supplier}
                  </a>
                  <p className="text-sm text-text-body">
                    {claim.ageDays === null
                      ? 'Issue age unknown'
                      : `${claim.ageDays} full days since issue`}{' '}
                    · {money(claim.outstandingMinor)} outstanding · {money(claim.allocatedMinor)}{' '}
                    allocated
                  </p>
                  {claim.credits.length ? (
                    <>
                      <p className="mt-2 text-sm text-text-body">
                        Review same-supplier credit for reconciliation:
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
                            Showing {LIMIT} of {claim.credits.length} matching loaded credits. See
                            supplier credit below.
                          </li>
                        ) : null}
                      </ul>
                    </>
                  ) : (
                    <p className="mt-2 text-sm text-text-muted">
                      No matching unallocated credit in validated loaded records. Review the claim
                      with supplier records.
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="font-medium text-text-strong">
            Submitted, undispatched returns · open deadlines first
          </h3>
          <p className="text-xs text-text-muted">
            Showing {Math.min(LIMIT, queue.dispatch.length)} of {queue.dispatch.length} qualifying
            loaded returns.
          </p>
          {queue.dispatch.length === 0 ? (
            <p className="mt-3 text-sm text-text-muted">
              No submitted, undispatched returns in loaded records.
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
                        ? 'Deadline unknown — verify recorded windows before dispatch.'
                        : 'Review before the recorded deadline; dispatch eligibility is checked on the return.'}
                  </p>
                  {row.deadline !== null ? (
                    <p className="text-xs text-text-muted">
                      Earliest recorded deadline: {date(row.deadline)}
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
