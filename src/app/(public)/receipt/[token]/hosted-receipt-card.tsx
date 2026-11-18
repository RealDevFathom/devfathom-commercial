import { formatMinor, formatReceiptIssuedAt } from '@/lib/pharmacy/counter-receipt';
import type { HostedReceiptView } from '@/lib/pharmacy/hosted-receipt-view';

/** Read-only hosted receipt body: every purchased line and the totals, like paper. */
export function HostedReceiptCard({ receipt }: { receipt: HostedReceiptView }) {
  const money = (minor: number) => `${receipt.currency} ${formatMinor(minor)}`;
  return (
    <div className="space-y-6">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-mono text-xs tracking-wider text-text-muted uppercase">Branch</dt>
          <dd className="mt-1 text-text-strong">{receipt.branchName}</dd>
        </div>
        <div>
          <dt className="font-mono text-xs tracking-wider text-text-muted uppercase">Issued</dt>
          <dd className="mt-1 text-text-strong tabular-nums">
            {formatReceiptIssuedAt(receipt.completedAt, receipt.timeZone)}
          </dd>
        </div>
        {receipt.counterLabel ? (
          <div>
            <dt className="font-mono text-xs tracking-wider text-text-muted uppercase">Counter</dt>
            <dd className="mt-1 text-text-strong">{receipt.counterLabel}</dd>
          </div>
        ) : null}
        {receipt.offlineReference ? (
          <div>
            <dt className="font-mono text-xs tracking-wider text-text-muted uppercase">
              Offline copy
            </dt>
            <dd className="mt-1 text-text-strong tabular-nums">{receipt.offlineReference}</dd>
          </div>
        ) : null}
      </dl>
      <div className="overflow-x-auto rounded-md border border-border-subtle">
        <table className="w-full min-w-[20rem] text-sm">
          <caption className="sr-only">Receipt lines</caption>
          <thead className="bg-surface-sunken">
            <tr>
              <th
                scope="col"
                className="px-3 py-2 text-left font-mono text-xs tracking-wider text-text-muted uppercase"
              >
                Item
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-right font-mono text-xs tracking-wider text-text-muted uppercase"
              >
                Qty
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-right font-mono text-xs tracking-wider text-text-muted uppercase"
              >
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {receipt.lines.map((line) => (
              <tr key={line.id} className="border-t border-border-subtle">
                <td className="px-3 py-2 text-text-body">
                  {line.name}
                  {line.strength ? (
                    <span className="text-text-muted"> · {line.strength}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right text-text-body tabular-nums">
                  {line.quantity} {line.saleUnit}
                </td>
                <td className="px-3 py-2 text-right text-text-strong tabular-nums">
                  {money(line.lineTotalMinor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {receipt.tierDiscountLines?.map((text) => (
        <p key={text} className="text-sm">
          {text}
        </p>
      ))}
      <dl className="space-y-2 text-sm">
        {receipt.totals.discountMinor > 0 ? (
          <>
            <div className="flex justify-between gap-4">
              <dt className="text-text-muted">Gross</dt>
              <dd className="tabular-nums text-text-body">{money(receipt.totals.grossMinor)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-text-muted">Discount</dt>
              <dd className="tabular-nums text-text-body">
                −{money(receipt.totals.discountMinor)}
              </dd>
            </div>
          </>
        ) : null}
        <div className="flex justify-between gap-4 border-t border-border-subtle pt-2">
          <dt className="font-semibold text-text-strong">Total</dt>
          <dd className="font-semibold tabular-nums text-text-strong">
            {money(receipt.totals.netMinor)}
          </dd>
        </div>
        {receipt.tenders.map((tender) => (
          <div key={tender.id} className="flex justify-between gap-4">
            <dt className="text-text-muted">{tender.label}</dt>
            <dd className="tabular-nums text-text-body">{money(tender.amountMinor)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
