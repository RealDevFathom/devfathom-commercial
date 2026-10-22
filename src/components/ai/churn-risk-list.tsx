import { SectionCard } from '@/components/ui/section-card';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import type { ChurnRiskCustomer } from '@/lib/ai/shared/churn-score.types';

import {
  CHURN_RISK_DIRECTION,
  CHURN_RISK_STRINGS,
  type ChurnRiskLocale,
  type ChurnRiskStrings,
} from './churn-risk-list.i18n';

export type ChurnRiskListResult =
  | { status: 'AVAILABLE'; customers: ChurnRiskCustomer[] }
  | { status: 'AI_OFF' | 'DENIED' };

const riskTone: Record<ChurnRiskCustomer['risk'], StatusTone> = {
  HIGH: 'danger',
  MEDIUM: 'warning',
  LOW: 'success',
};

const riskLabelKey: Record<ChurnRiskCustomer['risk'], keyof ChurnRiskStrings> = {
  HIGH: 'riskHigh',
  MEDIUM: 'riskMedium',
  LOW: 'riskLow',
};

export function ChurnRiskBadge({
  risk,
  locale = 'en',
}: {
  risk: ChurnRiskCustomer['risk'];
  locale?: ChurnRiskLocale;
}) {
  const strings = CHURN_RISK_STRINGS[locale];
  return <StatusPill status={risk} tone={riskTone[risk]} label={strings[riskLabelKey[risk]]} />;
}

/** Read-only presentation: deliberately contains no generate, approve, or send controls. */
export function ChurnRiskList({
  result,
  locale = 'en',
}: {
  result: ChurnRiskListResult;
  locale?: ChurnRiskLocale;
}) {
  const strings = CHURN_RISK_STRINGS[locale];

  return (
    <SectionCard
      dir={CHURN_RISK_DIRECTION[locale]}
      lang={locale}
      eyebrow={strings.productLabel}
      eyebrowAccent
      title={strings.title}
    >
      {result.status === 'DENIED' ? (
        <p className="text-sm text-text-muted">{strings.denied}</p>
      ) : result.status === 'AI_OFF' ? (
        <p className="text-sm text-text-muted">{strings.aiOff}</p>
      ) : result.customers.length === 0 ? (
        <p className="text-sm text-text-muted">{strings.empty}</p>
      ) : (
        <ul className="divide-y divide-border-subtle" aria-label={strings.listLabel}>
          {result.customers.map((customer) => (
            <li
              key={customer.customerId}
              className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <p className="font-medium text-text-strong">{customer.displayName}</p>
                <p className="mt-1 text-sm text-text-muted">{customer.reason}</p>
              </div>
              <ChurnRiskBadge risk={customer.risk} locale={locale} />
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
