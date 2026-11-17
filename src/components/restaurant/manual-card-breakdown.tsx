import type { ManualCardSummary } from '@/lib/restaurant/manual-card-summary';

export function ManualCardBreakdown({
  summary,
  staff,
}: {
  summary?: ManualCardSummary | null;
  staff: { id: string; displayName: string }[];
}) {
  if (!summary) {
    return (
      <p className="mt-3 text-sm text-text-muted">
        Manual card breakdown was not recorded for this close.
      </p>
    );
  }
  function figures(row: Omit<ManualCardSummary, 'cashiers'>) {
    return (
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        {[
          ['Count', row.count],
          ['Amount', row.amount],
          ['Tips', row.tipAmount],
          ['Refund / reversal count', row.refundCount],
          ['Refunds / reversals', row.refundAmount],
          ['Tip refunds', row.tipRefundAmount],
          ['Net amount', row.netAmount],
          ['Net tips', row.netTipAmount],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-text-muted">{label}</dt>
            <dd className="font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <section
      aria-label="Card, confirmed manually"
      className="mt-4 space-y-3 rounded-md border border-border-default p-4"
    >
      <h3 className="font-semibold text-text-strong">Card, confirmed manually</h3>
      <p className="text-sm text-text-muted">
        Included in Card totals. Refunds and reversals use their processing date; tips are separate.
      </p>
      {figures(summary)}
      {summary.cashiers.length ? (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">By collecting cashier</h4>
          {summary.cashiers.map((cashier) => (
            <div
              key={cashier.staffProfileId}
              className="space-y-2 border-t border-border-subtle pt-3"
            >
              <p className="break-all text-sm font-medium">
                {cashier.displayName ??
                  staff.find((person) => person.id === cashier.staffProfileId)?.displayName ??
                  'Unknown cashier'}
              </p>
              {figures(cashier)}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-text-muted">No manually confirmed card activity.</p>
      )}
    </section>
  );
}
