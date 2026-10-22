import { moneyLabel } from '@/lib/finance/currency';

type InvoiceTotalsProps = {
  subtotal: number;
  tax: number;
  total: number;
  amountPaid: number;
  balance: number;
  currency: string;
};

export function InvoiceTotals({
  subtotal,
  tax,
  total,
  amountPaid,
  balance,
  currency,
}: InvoiceTotalsProps) {
  return (
    <div className="w-full max-w-xs space-y-1.5 text-sm">
      <div className="flex justify-between text-slate-600">
        <span>Subtotal</span>
        <span className="tabular-nums">{moneyLabel(subtotal, currency)}</span>
      </div>
      <div className="flex justify-between text-slate-600">
        <span>Tax</span>
        <span className="tabular-nums">{moneyLabel(tax, currency)}</span>
      </div>
      <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-900">
        <span>Total</span>
        <span className="tabular-nums">{moneyLabel(total, currency)}</span>
      </div>
      {amountPaid > 0 && (
        <>
          <div className="flex justify-between text-slate-600">
            <span>Amount paid</span>
            <span className="tabular-nums">{moneyLabel(amountPaid, currency)}</span>
          </div>
          <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-900">
            <span>Balance due</span>
            <span className="tabular-nums">{moneyLabel(balance, currency)}</span>
          </div>
        </>
      )}
    </div>
  );
}
