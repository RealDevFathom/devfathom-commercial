import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  offers: {
    data: [] as unknown[],
    error: null as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  options: {
    data: {
      branches: [{ id: 'branch_1', name: 'Gulberg', timezone: 'Asia/Karachi' }],
      categories: [{ id: 'category_1', name: 'Tea', parentId: null }],
      products: [
        {
          id: 'product_1',
          name: 'Karak chai',
          categoryId: 'category_1',
          variants: [{ id: 'variant_1', name: 'Large' }],
        },
      ],
    },
    error: null as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  create: vi.fn(),
  edit: vi.fn(),
  disable: vi.fn(),
  invalidate: vi.fn(),
  disableOptions: null as null | { onError: (error: { message: string }) => void },
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ restaurantPromotions: { list: { invalidate: mocks.invalidate } } }),
    restaurantPromotions: {
      list: { useQuery: () => mocks.offers },
      pickerOptions: { useQuery: () => mocks.options },
      createOffer: { useMutation: () => ({ isPending: false, mutate: mocks.create }) },
      editOffer: { useMutation: () => ({ isPending: false, mutate: mocks.edit }) },
      disableOffer: { useMutation: (options: typeof mocks.disableOptions) => { mocks.disableOptions = options; return { isPending: false, mutate: mocks.disable }; } },
    },
  },
}));

import { PromotionsConsole } from './promotions-console';

const offer = {
  id: 'promotion_1',
  editRestriction: null,
  organizationId: 'org_1',
  code: 'TENOFF',
  name: 'Ten off',
  status: 'ACTIVE',
  archivedAt: null,
  createdAt: new Date('2026-08-01'),
  updatedAt: new Date('2026-08-01'),
  latestVersion: {
    id: 'version_1',
    organizationId: 'org_1',
    promotionId: 'promotion_1',
    versionNumber: 1,
    status: 'DRAFT',
    effectiveFrom: new Date('2026-09-01'),
    effectiveTo: null,
    timezone: 'Asia/Karachi',
    dayMask: 127,
    startMinute: null,
    endMinute: null,
    activationMode: 'AUTOMATIC',
    couponCodeHash: null,
    requiredPermission: null,
    requiresCoAuthorization: false,
    approvedByStaffId: null,
    approvalReference: null,
    publishedAt: null,
    supersededAt: null,
    targetKind: 'ITEM',
    targetProductIds: ['product_1'],
    targetVariantIds: [],
    targetCategoryIds: [],
    includeDescendants: false,
    componentTargeting: false,
    allowedBranchIds: ['branch_1'],
    allowedChannels: ['DINE_IN'],
    customerSegmentRef: null,
    minimumQuantity: null,
    minimumAmount: null,
    benefitKind: 'PERCENT_OFF',
    benefitBasisPoints: 1000,
    benefitAmount: null,
    buyQuantity: null,
    getQuantity: null,
    applicationBasis: 'ORDER',
    maxBenefitAmount: null,
    currency: 'PKR',
    priority: 0,
    stackingGroup: '',
    stackingMode: 'STACKABLE',
    stopFurtherProcessing: false,
    maxApplicationsPerOrder: null,
    perOrderCap: null,
    globalCap: null,
    perCustomerCap: null,
    budgetAmount: null,
    offlinePolicy: 'ALLOW',
    ruleSnapshot: {},
    ruleHash: 'hash',
    createdAt: new Date(),
    updatedAt: new Date(),
    components: [],
  },
};

beforeEach(() => {
  mocks.offers.data = [];
  mocks.offers.isLoading = false;
  mocks.offers.isError = false;
  mocks.offers.error = null;
  mocks.options.isLoading = false;
  mocks.options.isError = false;
  mocks.options.error = null;
  mocks.create.mockReset();
  mocks.edit.mockReset();
  mocks.disable.mockReset();
});

describe('PromotionsConsole', () => {
  it('renders intentional loading and empty states', () => {
    mocks.offers.isLoading = true;
    const { rerender } = render(<PromotionsConsole />);
    expect(screen.getByRole('status', { name: 'Loading offers' })).toBeInTheDocument();
    mocks.offers.isLoading = false;
    rerender(<PromotionsConsole />);
    expect(screen.getByText('No offers yet')).toBeInTheDocument();
  });

  it('keeps selection visible and row actions keyboard-reachable', () => {
    mocks.offers.data = [offer];
    render(<PromotionsConsole />);
    const offerButton = screen.getByRole('button', { name: /Ten off/ });
    expect(offerButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Edit draft' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Disable offer' })).toBeEnabled();
  });

  it('creates an offer using named branch and product picker values', () => {
    render(<PromotionsConsole />);
    fireEvent.click(screen.getAllByRole('button', { name: /Create offer/ })[0]!);
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Offer name'), {
      target: { value: 'Chai ten' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Offer code/), { target: { value: 'chai10' } });
    fireEvent.change(within(dialog).getByLabelText('Target type'), { target: { value: 'ITEM' } });
    const products = within(dialog).getByLabelText('Products') as HTMLSelectElement;
    within(products).getByRole('option', { name: 'Karak chai' }).setAttribute('selected', '');
    fireEvent.change(products);
    const branches = within(dialog).getByLabelText(/Branches/) as HTMLSelectElement;
    within(branches).getByRole('option', { name: 'Gulberg' }).setAttribute('selected', '');
    fireEvent.change(branches);
    fireEvent.submit(within(dialog).getByRole('button', { name: 'Create offer' }).closest('form')!);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'CHAI10',
        rule: expect.objectContaining({
          targetProductIds: ['product_1'],
          allowedBranchIds: ['branch_1'],
        }),
      }),
      expect.any(Object)
    );
  });
});


describe('offer preservation and feedback', () => {
  it.each([
    { ...offer, latestVersion: { ...offer.latestVersion, status: 'PUBLISHED' } },
    { ...offer, editRestriction: 'Advanced rules are read-only here.' },
    { ...offer, latestVersion: { ...offer.latestVersion, targetProductIds: ['missing'] } },
  ])('does not edit unsupported or unavailable data', (stored) => {
    mocks.offers.data = [stored]; render(<PromotionsConsole />);
    expect(screen.getByRole('button', { name: 'Edit draft' })).toBeDisabled();
    expect(mocks.edit).not.toHaveBeenCalled();
  });
  it('preserves exact unchanged schedule and existing timezone', () => {
    const instant = new Date('2026-09-01T13:14:25.123Z');
    mocks.offers.data = [{ ...offer, latestVersion: { ...offer.latestVersion, effectiveFrom: instant, timezone: 'Europe/London' } }];
    render(<PromotionsConsole />); fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Starts (UTC)')).toHaveValue('2026-09-01T13:14');
    expect(within(dialog).getByLabelText('Timezone')).toHaveValue('Europe/London');
    fireEvent.submit(within(dialog).getByRole('button', { name: 'Save changes' }).closest('form')!);
    expect(mocks.edit).toHaveBeenCalledWith(expect.objectContaining({ expectedVersionId: 'version_1', expectedRuleHash: 'hash', rule: expect.objectContaining({ effectiveFrom: instant, timezone: 'Europe/London' }) }), expect.any(Object));
  });
  it('parses a changed schedule explicitly as UTC', () => {
    mocks.offers.data = [offer]; render(<PromotionsConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
    const dialog = screen.getByRole('dialog'); fireEvent.change(within(dialog).getByLabelText('Starts (UTC)'), { target: { value: '2026-09-02T13:14' } });
    fireEvent.submit(within(dialog).getByRole('button', { name: 'Save changes' }).closest('form')!);
    expect(mocks.edit).toHaveBeenCalledWith(expect.objectContaining({ rule: expect.objectContaining({ effectiveFrom: new Date('2026-09-02T13:14:00Z') }) }), expect.any(Object));
  });
  it('requires an operator reason and displays disable failures', () => {
    mocks.offers.data = [offer];
    mocks.disable.mockImplementation(() => mocks.disableOptions!.onError({ message: 'Offer changed; reload.' }));
    render(<PromotionsConsole />); fireEvent.click(screen.getByRole('button', { name: 'Disable offer' }));
    const dialog = screen.getByRole('dialog'); const confirm = within(dialog).getByRole('button', { name: 'Disable offer' });
    expect(confirm).toBeDisabled(); fireEvent.change(within(dialog).getByLabelText('Reason for disabling'), { target: { value: 'Pricing correction' } }); fireEvent.click(confirm);
    expect(mocks.disable).toHaveBeenCalledWith({ promotionId: 'promotion_1', reason: 'Pricing correction' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Offer changed; reload.');
  });
  it('disables authoring when stale picker data accompanies an access error', () => {
    mocks.offers.error = { data: { code: 'FORBIDDEN' } }; mocks.offers.isError = true;
    render(<PromotionsConsole />); expect(screen.getByRole('button', { name: /Create offer/ })).toBeDisabled();
  });
});
