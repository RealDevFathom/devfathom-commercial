import { formatMinor } from '@/lib/pharmacy/counter-receipt';

/**
 * DEV-977 phase 2B (Counter v2 B1): the khata limit as three figures and a bar. It only draws
 * the ledger balance and limit the panel already shows; the server alone decides a charge.
 */
export function KhataLimitMeter({
  balanceMinor,
  limitMinor,
  chargeMinor,
}: {
  balanceMinor: number;
  limitMinor: number;
  chargeMinor: number | null;
}) {
  const availableMinor = Math.max(0, limitMinor - balanceMinor);
  const afterMinor = balanceMinor + (chargeMinor ?? 0);
  const over = chargeMinor !== null && afterMinor > limitMinor;
  const usedPercent =
    limitMinor > 0 ? Math.min(100, Math.max(0, Math.round((afterMinor / limitMinor) * 100))) : 100;
  return (
    <div className="space-y-2">
      <div
        role="img"
        aria-label={`${formatMinor(Math.max(0, afterMinor))} of ${formatMinor(limitMinor)} limit used${over ? ', over the limit' : ''}`}
        data-over={over ? 'true' : 'false'}
        className="h-2 overflow-hidden rounded-full bg-surface-sunken"
      >
        <span
          className={`block h-full rounded-full ${over ? 'bg-destructive' : 'bg-text-strong'}`}
          style={{ width: `${usedPercent}%` }}
        />
      </div>
      <dl className="grid grid-cols-3 gap-2 text-[13px]">
        <div>
          <dt className="text-text-muted">Limit</dt>
          <dd className="font-semibold tabular-nums text-text-strong">{formatMinor(limitMinor)}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Used</dt>
          <dd className="font-semibold tabular-nums text-text-strong">
            {formatMinor(balanceMinor)}
          </dd>
        </div>
        <div>
          <dt className="text-text-muted">Available</dt>
          <dd className="font-semibold tabular-nums text-text-strong">
            {formatMinor(availableMinor)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
