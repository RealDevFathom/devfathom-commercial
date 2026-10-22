import { SectionCard } from '@/components/ui/section-card';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import type { ChurnRiskCustomer } from '@/lib/ai/shared/churn-score.types';

export type ChurnRiskListResult =
  | { status: 'AVAILABLE'; customers: ChurnRiskCustomer[] }
  | { status: 'AI_OFF' | 'DENIED' };

const riskTone: Record<ChurnRiskCustomer['risk'], StatusTone> = {
  HIGH: 'danger',
  MEDIUM: 'warning',
  LOW: 'success',
};

export function ChurnRiskBadge({ risk }: { risk: ChurnRiskCustomer['risk'] }) {
  return <StatusPill status={risk} tone={riskTone[risk]} label={`${risk} risk`} />;
}

/** Read-only presentation: deliberately contains no generate, approve, or send controls. */
export function ChurnRiskList({ result }: { result: ChurnRiskListResult }) {
  return (
    <SectionCard eyebrow="DevFathom AI" eyebrowAccent title="Churn risk">
      {result.status === 'DENIED' ? (
        <p className="text-sm text-text-muted">You do not have access to churn insights.</p>
      ) : result.status === 'AI_OFF' ? (
        <p className="text-sm text-text-muted">
          DevFathom AI is off until an AI provider is configured for this organization.
        </p>
      ) : result.customers.length === 0 ? (
        <p className="text-sm text-text-muted">No customers are currently flagged for churn.</p>
      ) : (
        <ul className="divide-y divide-border-subtle" aria-label="Customers at risk of churn">
          {result.customers.map((customer) => (
            <li
              key={customer.customerId}
              className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <p className="font-medium text-text-strong">{customer.displayName}</p>
                <p className="mt-1 text-sm text-text-muted">{customer.reason}</p>
              </div>
              <ChurnRiskBadge risk={customer.risk} />
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
