import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import BranchComparisonLoading from './branch-comparison/loading';
import PharmacyReportsLoading from './loading';
import RepeatPurchasingLoading from './repeat-purchasing/loading';
import ReplenishmentLoading from './replenishment/loading';
import SupplierCreditFollowUpLoading from './supplier-credit-follow-up/loading';

afterEach(cleanup);

// Each report subroute has its own loading state, so none inherits the "Reports" title.
describe('pharmacy report loading titles', () => {
  it.each([
    ['Reports', PharmacyReportsLoading],
    ['Repeat purchasing', RepeatPurchasingLoading],
    ['Replenishment', ReplenishmentLoading],
    ['Supplier-credit follow-up', SupplierCreditFollowUpLoading],
    ['Branch comparison', BranchComparisonLoading],
  ] as const)('titles the %s loading state after its own page', (heading, Loading) => {
    render(<Loading />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(heading);
  });
});
