import { selectFieldControl } from '@/lib/testing/select-field';
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
  editPending: false,
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
      editOffer: { useMutation: () => ({ isPending: mocks.editPending, mutate: mocks.edit }) },
      disableOffer: {
        useMutation: (options: typeof mocks.disableOptions) => {
          mocks.disableOptions = options;
          return { isPending: false, mutate: mocks.disable };
        },
      },
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

const originalPickerOptions = structuredClone(mocks.options.data);

beforeEach(() => {
  mocks.options.data = structuredClone(originalPickerOptions);
  mocks.editPending = false;
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
    fireEvent.change(
      selectFieldControl(
        within(dialog).getByLabelText('Target type', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'ITEM' } }
    );
    const products = within(dialog).getByLabelText('Products') as HTMLSelectElement;
    within(products)
      .getByRole('option', { hidden: true, name: 'Karak chai' })
      .setAttribute('selected', '');
    fireEvent.change(products);
    const branches = within(dialog).getByLabelText(/Branches/) as HTMLSelectElement;
    within(branches)
      .getByRole('option', { hidden: true, name: 'Gulberg' })
      .setAttribute('selected', '');
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
    mocks.offers.data = [stored];
    render(<PromotionsConsole />);
    expect(screen.getByRole('button', { name: 'Edit draft' })).toBeDisabled();
    expect(mocks.edit).not.toHaveBeenCalled();
  });
  it('preserves exact unchanged schedule and existing timezone', () => {
    const instant = new Date('2026-09-01T13:14:25.123Z');
    mocks.offers.data = [
      {
        ...offer,
        latestVersion: {
          ...offer.latestVersion,
          effectiveFrom: instant,
          timezone: 'Europe/London',
        },
      },
    ];
    render(<PromotionsConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Starts (UTC)')).toHaveValue('2026-09-01T13:14');
    expect(
      selectFieldControl(
        within(dialog).getByLabelText('Timezone', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('Europe/London');
    fireEvent.submit(within(dialog).getByRole('button', { name: 'Save changes' }).closest('form')!);
    expect(mocks.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersionId: 'version_1',
        expectedRuleHash: 'hash',
        rule: expect.objectContaining({ effectiveFrom: instant, timezone: 'Europe/London' }),
      }),
      expect.any(Object)
    );
  });
  it('parses a changed schedule explicitly as UTC', () => {
    mocks.offers.data = [offer];
    render(<PromotionsConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Starts (UTC)'), {
      target: { value: '2026-09-02T13:14' },
    });
    fireEvent.submit(within(dialog).getByRole('button', { name: 'Save changes' }).closest('form')!);
    expect(mocks.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: expect.objectContaining({ effectiveFrom: new Date('2026-09-02T13:14:00Z') }),
      }),
      expect.any(Object)
    );
  });
  it('requires an operator reason and displays disable failures', () => {
    mocks.offers.data = [offer];
    mocks.disable.mockImplementation(() =>
      mocks.disableOptions!.onError({ message: 'Offer changed; reload.' })
    );
    render(<PromotionsConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable offer' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Disable offer' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason for disabling'), {
      target: { value: 'Pricing correction' },
    });
    fireEvent.click(confirm);
    expect(mocks.disable).toHaveBeenCalledWith({
      promotionId: 'promotion_1',
      reason: 'Pricing correction',
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Offer changed; reload.');
  });
  it('disables authoring when stale picker data accompanies an access error', () => {
    mocks.offers.error = { data: { code: 'FORBIDDEN' } };
    mocks.offers.isError = true;
    render(<PromotionsConsole />);
    expect(screen.getByRole('button', { name: /Create offer/ })).toBeDisabled();
  });
});

const bundleRows = [
  {
    productIds: ['product_2', 'product_1', 'product_2'],
    categoryIds: ['category_2', 'category_1', 'category_2'],
    quantity: 2,
  },
  { productIds: [], categoryIds: ['category_1'], quantity: 3 },
  { productIds: ['product_1'], categoryIds: [], quantity: 1 },
];
const preciseStart = new Date('2026-09-01T13:14:25.123Z');
const preciseEnd = new Date('2026-09-15T15:16:27.456Z');
function installBundle(components = bundleRows) {
  mocks.options.data = {
    branches: [
      ...originalPickerOptions.branches,
      { id: 'branch_2', name: 'Model Town', timezone: 'Asia/Karachi' },
    ],
    categories: [
      ...originalPickerOptions.categories,
      { id: 'category_2', name: 'Snacks', parentId: null },
    ],
    products: [
      ...originalPickerOptions.products,
      {
        id: 'product_2',
        name: 'Samosa',
        categoryId: 'category_2',
        variants: [{ id: 'variant_2', name: 'Regular' }],
      },
    ],
  };
  mocks.offers.data = [
    {
      ...offer,
      latestVersion: {
        ...offer.latestVersion,
        effectiveFrom: preciseStart,
        effectiveTo: preciseEnd,
        dayMask: 42,
        startMinute: 1140,
        endMinute: 300,
        benefitKind: 'BUNDLE_PRICE',
        benefitBasisPoints: null,
        benefitAmount: '450.00',
        targetProductIds: ['product_2', 'product_1', 'product_2'],
        targetVariantIds: ['variant_2', 'variant_1', 'variant_2'],
        allowedBranchIds: ['branch_2', 'branch_1', 'branch_2'],
        allowedChannels: ['DELIVERY', 'DINE_IN', 'DELIVERY'],
        includeDescendants: true,
        componentTargeting: true,
        maxBenefitAmount: '100.00',
        maxApplicationsPerOrder: 4,
        perOrderCap: 3,
        priority: 7,
        stackingGroup: 'lunch',
        stackingMode: 'GROUP_EXCLUSIVE',
        stopFurtherProcessing: true,
        components: structuredClone(components).map((component, ordinal) => ({
          ...component,
          id: `component_${ordinal}`,
          ordinal,
          variantIds: [],
        })),
      },
    },
  ];
}
function openBundle(components = bundleRows) {
  installBundle(components);
  render(<PromotionsConsole />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
  return screen.getByRole('dialog');
}
const bundleRow = (n: number) =>
  within(screen.getByRole('group', { name: `Bundle component ${n}` }));
function submitBundle(dialog: HTMLElement) {
  fireEvent.submit(
    within(dialog)
      .getByRole('button', { name: /Save changes|Saving/ })
      .closest('form')!
  );
}
function submittedBundle(dialog: HTMLElement) {
  submitBundle(dialog);
  expect(mocks.edit).toHaveBeenCalledTimes(1);
  expect(mocks.create).not.toHaveBeenCalled();
  return mocks.edit.mock.calls[0]![0];
}
function selectIds(element: HTMLElement, ids: string[]) {
  const select = element as HTMLSelectElement;
  for (const option of Array.from(select.options)) option.selected = ids.includes(option.value);
  fireEvent.change(select);
}
function expectPreservedRule(input: { rule: unknown }) {
  expect(input.rule).toMatchObject({
    effectiveFrom: preciseStart,
    effectiveTo: preciseEnd,
    dayMask: 42,
    startMinute: 1140,
    endMinute: 300,
    allowedBranchIds: ['branch_2', 'branch_1', 'branch_2'],
    allowedChannels: ['DELIVERY', 'DINE_IN', 'DELIVERY'],
    includeDescendants: true,
    componentTargeting: true,
    maxBenefitAmount: '100.00',
    maxApplicationsPerOrder: 4,
    perOrderCap: 3,
    priority: 7,
    stackingGroup: 'lunch',
    stackingMode: 'GROUP_EXCLUSIVE',
    stopFurtherProcessing: true,
  });
}
describe('ordered bundle draft authoring', () => {
  it('creates an ordered product and category bundle from named pickers', () => {
    render(<PromotionsConsole />);
    fireEvent.click(screen.getAllByRole('button', { name: /Create offer/ })[0]!);
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Offer name'), {
      target: { value: 'Tea bundle' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Offer code/), {
      target: { value: 'tea_bundle' },
    });
    fireEvent.change(
      selectFieldControl(
        within(dialog).getByLabelText('Target type', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'ORDER' } }
    );
    fireEvent.change(
      selectFieldControl(
        within(dialog).getByLabelText('Benefit type', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      {
        target: { value: 'BUNDLE_PRICE' },
      }
    );
    fireEvent.change(within(dialog).getByLabelText('Benefit amount'), {
      target: { value: '450.00' },
    });
    selectIds(bundleRow(1).getByLabelText('Product alternatives'), ['product_1']);
    fireEvent.change(bundleRow(1).getByLabelText('Required quantity'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add component' }));
    selectIds(bundleRow(2).getByLabelText('Category alternatives'), ['category_1']);
    fireEvent.submit(within(dialog).getByRole('button', { name: 'Create offer' }).closest('form')!);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      name: 'Tea bundle',
      code: 'TEA_BUNDLE',
      rule: {
        targetKind: 'ORDER',
        targetProductIds: [],
        targetVariantIds: [],
        targetCategoryIds: [],
        benefitKind: 'BUNDLE_PRICE',
        benefitAmount: '450.00',
        benefitBasisPoints: null,
        components: [
          { productIds: ['product_1'], categoryIds: [], quantity: 2 },
          { productIds: [], categoryIds: ['category_1'], quantity: 1 },
        ],
      },
    });
  });

  it.each(['unchanged', 'name-only'])(
    'preserves exact selections and supported fields on %s save',
    (kind) => {
      const dialog = openBundle();
      for (const label of ['Product alternatives', 'Category alternatives'])
        fireEvent.change(bundleRow(1).getByLabelText(label));
      for (const label of ['Products', 'Variants', /Branches/, 'Channels'])
        fireEvent.change(within(dialog).getByLabelText(label));
      if (kind === 'name-only')
        fireEvent.change(within(dialog).getByLabelText('Offer name'), {
          target: { value: 'Lunch bundle' },
        });
      const input = submittedBundle(dialog);
      expect(input.rule.components).toEqual(bundleRows);
      expectPreservedRule(input);
      expect(input).toMatchObject({
        name: kind === 'name-only' ? 'Lunch bundle' : offer.name,
        expectedVersionId: offer.latestVersion.id,
        expectedRuleHash: offer.latestVersion.ruleHash,
        expectedUpdatedAt: offer.latestVersion.updatedAt,
        rule: {
          targetProductIds: ['product_2', 'product_1', 'product_2'],
          targetVariantIds: ['variant_2', 'variant_1', 'variant_2'],
        },
      });
    }
  );
  it('keeps entered values with their rows across move, remove, and add', () => {
    const dialog = openBundle();
    expect(bundleRow(1).getByRole('button', { name: 'Move component 1 up' })).toBeDisabled();
    expect(bundleRow(3).getByRole('button', { name: 'Move component 3 down' })).toBeDisabled();
    fireEvent.change(bundleRow(3).getByLabelText('Required quantity'), { target: { value: '7' } });
    fireEvent.click(bundleRow(3).getByRole('button', { name: 'Move component 3 up' }));
    expect(bundleRow(2).getByLabelText('Required quantity')).toHaveValue(7);
    expect(bundleRow(2).getByLabelText('Product alternatives')).toHaveValue(['product_1']);
    expect(bundleRow(3).getByLabelText('Required quantity')).toHaveValue(3);
    fireEvent.click(bundleRow(1).getByRole('button', { name: 'Remove component 1' }));
    expect(bundleRow(1).getByLabelText('Required quantity')).toHaveValue(7);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add component' }));
    expect(bundleRow(3).getByLabelText('Product alternatives')).toHaveValue([]);
    expect(bundleRow(3).getByLabelText('Category alternatives')).toHaveValue([]);
    selectIds(bundleRow(3).getByLabelText('Product alternatives'), ['product_2']);
    fireEvent.change(bundleRow(3).getByLabelText('Required quantity'), { target: { value: '4' } });
    const input = submittedBundle(dialog);
    expectPreservedRule(input);
    expect(input.rule.components).toEqual([
      { productIds: ['product_1'], categoryIds: [], quantity: 7 },
      { productIds: [], categoryIds: ['category_1'], quantity: 3 },
      { productIds: ['product_2'], categoryIds: [], quantity: 4 },
    ]);
  });
  it('retains surviving ID order and appends a reselected ID without altering other rows', () => {
    const dialog = openBundle();
    const products = bundleRow(1).getByLabelText('Product alternatives');
    selectIds(products, ['product_2']);
    selectIds(products, ['product_1', 'product_2']);
    const input = submittedBundle(dialog);
    expectPreservedRule(input);
    expect(input.rule.components).toEqual([
      { ...bundleRows[0], productIds: ['product_2', 'product_2', 'product_1'] },
      ...bundleRows.slice(1),
    ]);
  });
  it.each([0, 1])('blocks editing when component %i contains an unavailable category', (index) => {
    const components = structuredClone(bundleRows);
    components[index]!.categoryIds = ['missing_category'];
    installBundle(components);
    render(<PromotionsConsole />);
    expect(screen.getByRole('button', { name: 'Edit draft' })).toBeDisabled();
    expect(screen.getByText(/selected records are unavailable/i)).toBeInTheDocument();
    expect(mocks.edit).not.toHaveBeenCalled();
  });
  it('preserves all twenty components and prevents adding a twenty-first', () => {
    const components = Array.from({ length: 20 }, (_, index) => ({
      productIds: ['product_1'],
      categoryIds: [],
      quantity: index + 1,
    }));
    const dialog = openBundle(components);
    const add = within(dialog).getByRole('button', { name: 'Add component' });
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(screen.getAllByRole('group', { name: /^Bundle component \d+$/ })).toHaveLength(20);
    expect(submittedBundle(dialog).rule.components).toEqual(components);
  });
  it('rejects an empty added component without dropping it', () => {
    const dialog = openBundle();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add component' }));
    submitBundle(dialog);
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    expect(screen.getAllByRole('group', { name: /^Bundle component \d+$/ })).toHaveLength(4);
  });
  it('rejects removal of every component at submission', () => {
    const dialog = openBundle();
    for (let n = 0; n < 3; n++)
      fireEvent.click(bundleRow(1).getByRole('button', { name: 'Remove component 1' }));
    submitBundle(dialog);
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();
  });
  it.each(['', '0', '-1', '1.5'])(
    'rejects invalid component quantity %j at submission',
    (quantity) => {
      const dialog = openBundle();
      fireEvent.change(bundleRow(1).getByLabelText('Required quantity'), {
        target: { value: quantity },
      });
      submitBundle(dialog);
      expect(mocks.edit).not.toHaveBeenCalled();
      expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    }
  );
  it('retains bundle rows while switching benefit type temporarily', () => {
    const dialog = openBundle();
    fireEvent.click(bundleRow(3).getByRole('button', { name: 'Move component 3 up' }));
    fireEvent.change(
      selectFieldControl(
        within(dialog).getByLabelText('Benefit type', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      {
        target: { value: 'PERCENT_OFF' },
      }
    );
    expect(screen.queryByRole('group', { name: 'Bundle component 1' })).not.toBeInTheDocument();
    fireEvent.change(
      selectFieldControl(
        within(dialog).getByLabelText('Benefit type', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      {
        target: { value: 'BUNDLE_PRICE' },
      }
    );
    expect(submittedBundle(dialog).rule.components).toEqual([
      bundleRows[0],
      bundleRows[2],
      bundleRows[1],
    ]);
  });
  it.each(['CATEGORY', 'ORDER'])(
    'clears only incompatible target arrays on explicit transition to %s',
    (target) => {
      const dialog = openBundle();
      fireEvent.change(
        selectFieldControl(
          within(dialog).getByLabelText('Target type', {
            selector: ':not([data-select-field-native][aria-hidden="true"])',
          })
        ),
        { target: { value: target } }
      );
      if (target === 'CATEGORY')
        selectIds(within(dialog).getByLabelText('Categories'), ['category_1']);
      const input = submittedBundle(dialog);
      expectPreservedRule(input);
      expect(input.rule.components).toEqual(bundleRows);
      expect(input.rule).toMatchObject({
        targetKind: target,
        targetProductIds: [],
        targetVariantIds: [],
        targetCategoryIds: target === 'CATEGORY' ? ['category_1'] : [],
      });
    }
  );
  it('keeps selected IDs when picker records disappear while the dialog is open', () => {
    installBundle();
    const { rerender } = render(<PromotionsConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
    mocks.options.data = { ...mocks.options.data, products: originalPickerOptions.products };
    rerender(<PromotionsConsole />);
    expect(submittedBundle(screen.getByRole('dialog')).rule.components).toEqual(bundleRows);
  });
  it('retains inputs and displays stale-save errors without retrying', () => {
    const dialog = openBundle();
    fireEvent.change(bundleRow(1).getByLabelText('Required quantity'), { target: { value: '7' } });
    mocks.edit.mockImplementation((_input, options) =>
      options.onError({ message: 'The offer changed. Reload before editing.' })
    );
    submitBundle(dialog);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('The offer changed');
    expect(bundleRow(1).getByLabelText('Required quantity')).toHaveValue(7);
    expect(mocks.edit).toHaveBeenCalledTimes(1);
  });
  it('disables controls and blocks programmatic submission while saving', () => {
    mocks.editPending = true;
    const dialog = openBundle();
    expect(bundleRow(1).getByLabelText('Required quantity')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Add component' })).toBeDisabled();
    submitBundle(dialog);
    expect(mocks.edit).not.toHaveBeenCalled();
  });
});
