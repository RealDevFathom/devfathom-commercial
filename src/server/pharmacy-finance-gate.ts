import {
  PHARMACY_FINANCE_MANAGE,
  PHARMACY_FINANCE_READ,
  type PharmacyFinanceAction,
} from '@/lib/abac/pharmacy-finance-actions';
import { requirePharmacyFinance } from '@/lib/pharmacy/finance-access';
import { tagProcedureGate } from './procedure-gate-tag';
import { adminProcedure, contextualCapabilityProcedure } from './trpc';

export const pharmacyFinanceGate = (action: PharmacyFinanceAction) =>
  tagProcedureGate(
    async <Result>({
      ctx,
      next,
    }: {
      ctx: Parameters<typeof requirePharmacyFinance>[0];
      next: () => Promise<Result>;
    }) => {
      await requirePharmacyFinance(ctx, action);
      return next();
    },
    { kind: 'capability', action }
  );

// Preserve explicit administrator revocations on the existing administrator path.
export const pharmacyFinanceMemberProcedure = contextualCapabilityProcedure(
  (ctx) => (ctx.session?.user.role === 'ADMIN' ? ['admin:access'] : [PHARMACY_FINANCE_READ]),
  'Finance permission is required.'
);

export const pharmacyFinanceMemberMutation = pharmacyFinanceMemberProcedure.use(
  pharmacyFinanceGate(PHARMACY_FINANCE_MANAGE)
);

export const pharmacyAccountMutation = adminProcedure.use(
  pharmacyFinanceGate(PHARMACY_FINANCE_MANAGE)
);

/** Terminal postings require both finance grants in addition to accounts administration. */
export const pharmacyRefundPostingMutation = pharmacyAccountMutation.use(
  pharmacyFinanceGate(PHARMACY_FINANCE_READ)
);
