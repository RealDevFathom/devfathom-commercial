import { revalidatePath } from 'next/cache';
import ReturnsPage from './returns/page';
import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

// Actual purchasing page/action lifecycle regressions; first two replay WHA-1349 findings.
const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  hasModule: vi.fn(),
  createCaller: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/server/routers/pharmacy-purchasing', () => ({
  pharmacyPurchasingRouter: { createCaller: mocks.createCaller },
}));

import SuppliersPage from './suppliers/page';
import OrdersPage from './orders/page';
import ReceivingPage from './receiving/page';

const actor = {
  session: { expires: '2099-01-01', user: { id: 'user-1', organizationId: 'org-1' } },
  organization: { id: 'org-1', slug: 'acme', status: 'ACTIVE' },
  support: null,
};

function contextStub(enabledModules = ['pharmacy-procurement']) {
  return {
    session: actor.session,
    organization: actor.organization,
    entitlements: { organizationId: 'org-1', enabledModules },
    db: {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          organizationRole: {
            permissions: [
              { capability: 'pharmacy.procurement', effect: 'ALLOW' },
              // PR J: approving and sending is its own permission (Manager, Owner).
              { capability: 'pharmacy:procurement-approve', effect: 'ALLOW' },
              // PR J: the returns board books debit notes and credits, so it
              // needs financial report access as well (Manager + Finance).
              { capability: 'reports:financial', effect: 'ALLOW' },
            ],
          },
          permissionOverrides: [],
        }),
      },
    },
  };
}

const licensedSupplier = {
  id: 'sup-ok',
  name: 'Karachi Distributors',
  legalName: 'Karachi Distributors (Pvt) Ltd',
  authorized: true,
  active: true,
  serviceArea: 'Karachi South',
  contactName: 'Ayesha',
  contactPhone: '0300-0000000',
  paymentTermsDays: 30,
  creditLimitMinor: 500_000,
  eligibility: { orderable: true as const, reason: null },
  governingLicence: {
    id: 'lic-1',
    licenceType: 'Drug sale licence',
    licenceNumber: 'DSL-1',
    issuingAuthority: 'DRAP',
    issuedAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    evidenceUri: null,
    verified: true,
    recordedByUserId: null,
    superseded: false,
    daysToExpiry: 300,
  },
  licences: [],
};

const lapsedSupplier = {
  ...licensedSupplier,
  id: 'sup-lapsed',
  name: 'Lahore Wholesale',
  authorized: true,
  eligibility: { orderable: false as const, reason: 'NO_VALID_LICENCE' as const },
  governingLicence: null,
  licences: [],
};

const workspace = {
  branches: [
    {
      id: 'branch-1',
      code: 'MAIN',
      name: 'Main branch',
      city: 'Karachi',
      defaultStockLocationId: 'loc-1',
    },
  ],
  stockLocations: [
    {
      id: 'loc-1',
      branchId: 'branch-1',
      code: 'SHELF',
      name: 'Front shelf',
      kind: 'STORE',
      coldChain: false,
    },
    {
      id: 'loc-q',
      branchId: 'branch-1',
      code: 'QUAR',
      name: 'Quarantine',
      kind: 'QUARANTINE',
      coldChain: false,
    },
  ],
  medicines: [
    {
      id: 'med-1',
      productName: 'Amoxicillin 500mg',
      brandName: null,
      coldChain: false,
      controlled: false,
      packs: [
        {
          packLevelId: 'pack-1',
          level: 'STRIP',
          presentation: 'Capsule, 10 per strip',
          canonicalUnitsPerPack: 10,
          conversionLabel: '1 STRIP = 10 units',
        },
      ],
    },
  ],
  suppliers: [licensedSupplier, lapsedSupplier],
  approvers: [{ id: 'user-2', name: 'Bilal', email: 'bilal@example.test' }],
};

function callerStub(overrides: Record<string, unknown> = {}) {
  return {
    workspace: vi.fn().mockResolvedValue(workspace),
    suppliers: vi.fn().mockResolvedValue([licensedSupplier, lapsedSupplier]),
    requisitions: vi.fn().mockResolvedValue([]),
    purchaseOrders: vi.fn().mockResolvedValue([]),
    goodsReceipts: vi.fn().mockResolvedValue([]),
    receivingExceptionQueue: vi.fn().mockResolvedValue([]),
    purchaseReturns: vi.fn().mockResolvedValue([]),
    returnableLots: vi.fn().mockResolvedValue([]),
    supplierCredits: vi.fn().mockResolvedValue([]),
    receivedAgainstOrder: vi.fn().mockResolvedValue({}),
    lotsFromReceipt: vi.fn().mockResolvedValue([]),
    resolveScan: vi.fn(),
    compareQuotes: vi.fn().mockResolvedValue({ ranking: [] }),
    landedCost: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(revalidatePath).mockReset();
  vi.unstubAllGlobals();
  mocks.hasModule.mockImplementation((entitlements: { enabledModules: string[] }, module: string) =>
    entitlements.enabledModules.includes(module)
  );
  mocks.resolveTenantActor.mockResolvedValue(actor);
  mocks.createTRPCContext.mockResolvedValue(contextStub());
  mocks.createCaller.mockReturnValue(callerStub());
});

const params = (query: Record<string, string> = {}) => Promise.resolve(query);

it.each([undefined, 'req-other', 'req-source'])(
  'shows a draft quote ranking from its own requisition with req=%s',
  async (selectedRequisition) => {
    const requisition = (id: string, medicine: string) => ({
      id,
      reference: id,
      status: 'SUBMITTED',
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      lines: [
        {
          id: `${id}-line`,
          medicine: { productName: medicine },
          quantityPacks: 10,
          canonicalUnitsPerPack: 10,
          canonicalUnits: 100,
        },
      ],
      quotes: [],
      purchaseOrders: [],
    });
    const compareQuotes = vi.fn().mockImplementation(async ({ requisitionLineId }) => ({
      ranking:
        requisitionLineId === 'req-source-line'
          ? [
              {
                quoteId: 'quote-source',
                rank: 2,
              },
              { quoteId: 'quote-better', rank: 1 },
            ].map((row) => ({
              ...row,
              supplierId: 'sup-ok',
              supplierName: 'Karachi Distributors',
              comparable: true,
              pricePerPackMinor: 1000,
              effectiveUnitCostMicroMinor: 100_000_000,
              effectiveSellableUnitCostMicroMinor: 100_000_000,
              forecastSellThroughPacks: 10,
              atRiskBonusPacks: 0,
              packsForRequirement: 10,
              bonusPacks: 0,
              moqPacks: 1,
              leadTimeDays: 2,
              minimumExpiryDays: 365,
              reasons: ['Lead time 2 days; shortest shelf life offered 365 days.'],
            }))
          : [],
    }));
    mocks.createCaller.mockReturnValue(
      callerStub({
        requisitions: vi
          .fn()
          .mockResolvedValue([
            requisition('req-source', 'Source medicine'),
            requisition('req-other', 'Other medicine'),
          ]),
        purchaseOrders: vi.fn().mockResolvedValue([
          {
            id: 'po-quote',
            reference: 'PO-QUOTE',
            status: 'DRAFT',
            quoteId: 'quote-source',
            supplier: { name: 'Karachi Distributors' },
            requisition: { id: 'req-source', reference: 'req-source' },
            createdByUserId: 'user-9',
            lines: [],
            approvals: [],
            goodsReceipts: [],
          },
        ]),
        compareQuotes,
      })
    );
    render(
      await OrdersPage({
        searchParams: params({
          po: 'po-quote',
          ...(selectedRequisition ? { req: selectedRequisition } : {}),
        }),
      })
    );
    expect(screen.getByText('Current distributor ranking for this draft')).toBeVisible();
    expect(screen.getByText(/Source medicine: selected quote ranked #2 of 2/)).toBeVisible();
    expect(screen.queryByText(/Other medicine: selected quote ranked/)).not.toBeInTheDocument();
    expect(
      compareQuotes.mock.calls.filter(([input]) => input.requisitionLineId === 'req-source-line')
    ).toHaveLength(1);
  }
);

it('review: submitted order success remains visible after refreshed status removes the submitting form', async () => {
  const order = {
    id: 'po-1',
    reference: 'PO-1',
    status: 'DRAFT',
    supplier: { id: 'sup-ok', name: 'Karachi Distributors' },
    branch: null,
    branchId: null,
    supplierId: 'sup-ok',
    requisition: null,
    lines: [],
    approvals: [],
    goodsReceipts: [],
    createdByUserId: 'user-9',
  };
  const list = vi.fn().mockResolvedValue([order]);
  const write = vi.fn().mockResolvedValue({});
  mocks.createCaller.mockReturnValue(
    callerStub({
      purchaseOrders: list,
      submitPurchaseOrder: write,
      landedCost: vi.fn().mockResolvedValue({
        payableMinor: 0,
        landedCostMinor: 0,
        taxMinor: 0,
        chargesMinor: 0,
        canonicalUnits: 0,
        netCostMinor: 0,
        lines: [],
      }),
    })
  );
  vi.stubGlobal('window', { document, location: { origin: 'https://workspace.test' } });
  const view = render(await OrdersPage({ searchParams: params({ po: 'po-1' }) }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
  });
  expect(write).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Order submitted for approval. Somebody else/)).toBeVisible();
  list.mockResolvedValue([{ ...order, status: 'SUBMITTED' }]);
  view.rerender(await OrdersPage({ searchParams: params({ po: 'po-1' }) }));
  expect(screen.getByRole('button', { name: 'Approve' })).toBeVisible();
  expect(screen.queryByText(/Order submitted for approval. Somebody else/)).toBeInTheDocument();
});
it('review: refreshed authorization offers the distinct withdrawal action', async () => {
  const list = vi.fn().mockResolvedValue([{ ...licensedSupplier, authorized: false }]);
  const write = vi.fn().mockResolvedValue({});
  mocks.createCaller.mockReturnValue(
    callerStub({ suppliers: list, setSupplierAuthorization: write })
  );
  vi.stubGlobal('window', { document, location: { origin: 'https://workspace.test' } });
  const view = render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Authorize this supplier' }));
  });
  expect(write).toHaveBeenCalledTimes(1);
  list.mockResolvedValue([{ ...licensedSupplier, authorized: true }]);
  view.rerender(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
  expect(screen.getByRole('button', { name: 'Withdraw authorization' })).toBeEnabled();
});

it('keeps a sibling supplier draft, caret, focus and selected record through authorization refresh', async () => {
  const list = vi.fn().mockResolvedValue([{ ...licensedSupplier, authorized: false }]);
  const write = vi.fn().mockResolvedValue({});
  mocks.createCaller.mockReturnValue(
    callerStub({ suppliers: list, setSupplierAuthorization: write })
  );
  const replace = vi.fn();
  vi.stubGlobal('window', { document, location: { origin: 'https://workspace.test', replace } });
  const view = render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
  const draft = screen.getByLabelText(/Trading name/) as HTMLInputElement;
  fireEvent.change(draft, { target: { value: 'Unfinished supplier' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Authorize this supplier' }));
  });
  draft.focus();
  draft.setSelectionRange(2, 8);
  list.mockResolvedValue([{ ...licensedSupplier, authorized: true }]);
  view.rerender(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
  expect(screen.getByLabelText(/Trading name/)).toBe(draft);
  expect(draft).toHaveValue('Unfinished supplier');
  expect(draft).toHaveFocus();
  expect([draft.selectionStart, draft.selectionEnd]).toEqual([2, 8]);
  expect(screen.getByRole('link', { name: /Karachi Distributors.*Karachi South/ })).toHaveAttribute(
    'aria-current',
    'true'
  );
  expect(replace).not.toHaveBeenCalled();
  expect(write).toHaveBeenCalledOnce();
});

it('offers the validated new supplier destination without selecting it automatically', async () => {
  const write = vi.fn().mockResolvedValue({ id: 'new-supplier', name: 'New supplier' });
  mocks.createCaller.mockReturnValue(callerStub({ createSupplier: write }));
  const replace = vi.fn();
  vi.stubGlobal('window', { document, location: { origin: 'https://workspace.test', replace } });
  render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
  fireEvent.change(screen.getByLabelText(/Trading name/), { target: { value: 'New supplier' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
  });
  const link = screen.getByRole('link', { name: 'View saved record' });
  const target = new URL(link.getAttribute('href')!);
  expect(target.origin).toBe('https://workspace.test');
  expect(target.pathname).toBe('/pharmacy/purchasing/suppliers');
  expect(target.searchParams.get('supplier')).toBe('new-supplier');
  expect(screen.getByRole('link', { name: /Karachi Distributors.*Karachi South/ })).toHaveAttribute(
    'aria-current',
    'true'
  );
  expect(replace).not.toHaveBeenCalled();
  expect(write).toHaveBeenCalledOnce();
});

it('does not unlock pending or uncertain supplier writes through operation changes or remounts', async () => {
  let reject!: (error: Error) => void;
  const write = vi.fn(
    () =>
      new Promise((_resolve, rejectWrite) => {
        reject = rejectWrite;
      })
  );
  const list = vi.fn().mockResolvedValue([{ ...licensedSupplier, authorized: false }]);
  mocks.createCaller.mockReturnValue(
    callerStub({ suppliers: list, setSupplierAuthorization: write })
  );
  vi.stubGlobal('window', { document, location: { origin: 'https://workspace.test' } });
  const view = render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
  fireEvent.click(screen.getByRole('button', { name: 'Authorize this supplier' }));
  list.mockResolvedValue([{ ...licensedSupplier, authorized: true }]);
  view.rerender(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
  expect(screen.getByRole('button', { name: 'Withdraw authorization' })).toBeDisabled();
  await act(async () => {
    reject(new Error('response lost'));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Could not confirm the outcome');
  view.rerender(await SuppliersPage({ searchParams: params() }));
  view.rerender(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
  const next = screen.getByRole('button', { name: 'Withdraw authorization' });
  expect(next).toBeDisabled();
  fireEvent.submit(next.closest('form')!);
  list.mockResolvedValue([{ ...licensedSupplier, authorized: false }]);
  view.rerender(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
  const original = screen.getByRole('button', { name: 'Authorize this supplier' });
  expect(original).toBeDisabled();
  fireEvent.submit(original.closest('form')!);
  expect(write).toHaveBeenCalledOnce();
});

it('retains a completed operation lock when refreshed props or selection remount its form', async () => {
  const write = vi.fn().mockResolvedValue({});
  mocks.createCaller.mockReturnValue(
    callerStub({
      suppliers: vi.fn().mockResolvedValue([{ ...licensedSupplier, authorized: false }]),
      setSupplierAuthorization: write,
    })
  );
  vi.stubGlobal('window', { document, location: { origin: 'https://workspace.test' } });
  const view = render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Authorize this supplier' }));
  });
  view.rerender(await SuppliersPage({ searchParams: params() }));
  view.rerender(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
  const original = screen.getByRole('button', { name: 'Authorize this supplier' });
  expect(original).toBeDisabled();
  fireEvent.submit(original.closest('form')!);
  expect(write).toHaveBeenCalledOnce();
  expect(screen.getByRole('status')).toHaveTextContent('authorized');
});

it('delivers the order outcome even when revalidation removes its form before the action resolves', async () => {
  const order = {
    id: 'po-1',
    reference: 'PO-1',
    status: 'DRAFT',
    supplier: { id: 'sup-ok', name: 'Karachi Distributors' },
    branch: null,
    branchId: null,
    supplierId: 'sup-ok',
    requisition: null,
    lines: [],
    approvals: [],
    goodsReceipts: [],
    createdByUserId: 'user-9',
  };
  let complete!: (value: object) => void;
  const write = vi.fn(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      })
  );
  const list = vi.fn().mockResolvedValue([order]);
  mocks.createCaller.mockReturnValue(
    callerStub({
      purchaseOrders: list,
      submitPurchaseOrder: write,
      landedCost: vi.fn().mockResolvedValue({
        payableMinor: 0,
        landedCostMinor: 0,
        taxMinor: 0,
        chargesMinor: 0,
        canonicalUnits: 0,
        netCostMinor: 0,
        lines: [],
      }),
    })
  );
  vi.stubGlobal('window', { document, location: { origin: 'https://workspace.test' } });
  const view = render(await OrdersPage({ searchParams: params({ po: 'po-1' }) }));
  fireEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
  list.mockResolvedValue([{ ...order, status: 'SUBMITTED' }]);
  view.rerender(await OrdersPage({ searchParams: params({ po: 'po-1' }) }));
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await act(async () => {
    complete({});
  });
  expect(screen.getByText(/Order submitted for approval. Somebody else/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  expect(write).toHaveBeenCalledOnce();
});

it('makes Receiving Reverse a distinct operation after a confirmed Post', async () => {
  const receipt = {
    id: 'gr-1',
    reference: 'GR-1',
    status: 'DRAFT',
    supplier: licensedSupplier,
    supplierInvoiceRef: 'INV-1',
    supplierInvoiceDate: new Date('2026-09-01'),
    receivedAt: new Date('2026-09-01'),
    lines: [],
    exceptions: [],
  };
  const list = vi.fn().mockResolvedValue([receipt]);
  const post = vi.fn().mockResolvedValue({});
  const reverse = vi.fn().mockResolvedValue({});
  mocks.createCaller.mockReturnValue(
    callerStub({ goodsReceipts: list, postGoodsReceipt: post, reverseGoodsReceipt: reverse })
  );
  vi.stubGlobal('window', { document, location: { origin: 'https://workspace.test' } });
  const view = render(await ReceivingPage({ searchParams: params({ receipt: 'gr-1' }) }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Post into stock' }));
  });
  expect(post).toHaveBeenCalledOnce();
  list.mockResolvedValue([{ ...receipt, status: 'POSTED' }]);
  view.rerender(await ReceivingPage({ searchParams: params({ receipt: 'gr-1' }) }));
  const reverseButton = screen.getByRole('button', { name: 'Reverse posting' });
  expect(reverseButton).toBeEnabled();
  expect(screen.getByRole('status')).toHaveTextContent('posted');
  expect(reverse).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(/Why is this being reversed/), {
    target: { value: 'Invoice correction' },
  });
  await act(async () => {
    fireEvent.click(reverseButton);
  });
  expect(reverse).toHaveBeenCalledOnce();
  fireEvent.submit(reverseButton.closest('form')!);
  expect(reverse).toHaveBeenCalledOnce();
});

it('keeps Returns success and sibling credit draft when Submit becomes Dispatch', async () => {
  const row = {
    id: 'ret-1',
    reference: 'RET-1',
    status: 'DRAFT',
    kind: 'PURCHASE_RETURN',
    supplier: licensedSupplier,
    createdAt: new Date('2026-09-01'),
    lines: [],
    debitNotes: [],
  };
  const list = vi.fn().mockResolvedValue([row]);
  const write = vi.fn().mockResolvedValue({});
  mocks.createCaller.mockReturnValue(
    callerStub({ purchaseReturns: list, submitPurchaseReturn: write })
  );
  vi.stubGlobal('window', { document, location: { origin: 'https://workspace.test' } });
  const view = render(await ReturnsPage({ searchParams: params({ return: 'ret-1' }) }));
  const draft = screen.getByLabelText(/Credit note reference/) as HTMLInputElement;
  fireEvent.change(draft, { target: { value: 'Unsaved credit' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Submit and reserve the stock' }));
  });
  draft.focus();
  draft.setSelectionRange(1, 5);
  list.mockResolvedValue([{ ...row, status: 'SUBMITTED' }]);
  view.rerender(await ReturnsPage({ searchParams: params({ return: 'ret-1' }) }));
  expect(screen.getByRole('button', { name: 'Dispatch to supplier' })).toBeEnabled();
  const outcome = screen.getByRole('link', { name: 'View saved record' }).parentElement!;
  expect(within(outcome).getByRole('status')).toHaveTextContent(
    /^Return submitted\. The quantity is reserved and can no longer be sold\. Check the updated record before starting another change\.$/
  );
  expect(
    screen.getByText(
      '1 records excluded because scope or financial data could not be validated. Review source records before reconciliation.'
    )
  ).toHaveAttribute('role', 'status');
  expect(draft).toHaveValue('Unsaved credit');
  expect(draft).toHaveFocus();
  expect([draft.selectionStart, draft.selectionEnd]).toEqual([1, 5]);
  expect(write).toHaveBeenCalledOnce();
});

it('review: same allocation cannot repeat through the credit and debit-note forms after uncertain outcome', async () => {
  const note = {
    id: 'dn-1',
    reference: 'DN-1',
    issuedAt: new Date('2026-09-01'),
    position: {
      expectedCreditMinor: 10000,
      receivedCreditMinor: 0,
      outstandingMinor: 10000,
      varianceMinor: 0,
      status: 'OPEN',
    },
  };
  const ret = {
    id: 'ret-1',
    reference: 'RET-1',
    status: 'DISPATCHED',
    kind: 'PURCHASE_RETURN',
    supplier: licensedSupplier,
    createdAt: new Date('2026-09-01'),
    lines: [],
    debitNotes: [note],
  };
  const credit = {
    id: 'cr-1',
    reference: 'CR-1',
    supplier: licensedSupplier,
    supplierId: 'sup-ok',
    amountMinor: 10000,
    receivedAt: new Date('2026-09-01'),
    allocations: [],
  };
  const write = vi.fn().mockRejectedValue(new Error('unknown write outcome'));
  mocks.createCaller.mockReturnValue(
    callerStub({
      purchaseReturns: vi.fn().mockResolvedValue([ret]),
      supplierCredits: vi.fn().mockResolvedValue([credit]),
      allocateSupplierCredit: write,
    })
  );
  vi.stubGlobal('window', { document, location: { origin: 'https://workspace.test' } });
  render(await ReturnsPage({ searchParams: params({ return: 'ret-1' }) }));
  const buttons = screen.getAllByRole('button', { name: 'Allocate' });
  expect(buttons).toHaveLength(2);
  for (const button of buttons) {
    const form = button.closest('form')!;
    fireEvent.change(form.querySelector('input[name="amountMinor"]')!, {
      target: { value: '10.00' },
    });
    const select = form.querySelector('select')!;
    fireEvent.change(select, {
      target: { value: select.name === 'supplierCreditId' ? 'cr-1' : 'dn-1' },
    });
  }
  await act(async () => {
    fireEvent.click(buttons[0]);
  });
  expect(write).toHaveBeenCalledTimes(1);
  expect(buttons[0]).toBeDisabled();
  await act(async () => {
    fireEvent.click(buttons[1]);
  });
  expect(write.mock.calls[0][0]).toMatchObject({
    supplierCreditId: 'cr-1',
    debitNoteId: 'dn-1',
    amountMinor: 1000,
  });
  if (write.mock.calls.length > 1) expect(write.mock.calls[1][0]).toEqual(write.mock.calls[0][0]);
  expect(write).toHaveBeenCalledTimes(1);
});
it('review: supplier outcome and same-operation lock survive refreshed read failure and recovery', async () => {
  const list = vi.fn().mockResolvedValue([{ ...licensedSupplier, authorized: false }]);
  const write = vi.fn().mockResolvedValue({});
  mocks.createCaller.mockReturnValue(
    callerStub({ suppliers: list, setSupplierAuthorization: write })
  );
  vi.stubGlobal('window', { document, location: { origin: 'https://workspace.test' } });
  const view = render(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Authorize this supplier' }));
  });
  list.mockRejectedValue(new Error('read failed'));
  view.rerender(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
  expect(screen.getByRole('status')).toHaveTextContent('Supplier authorized');
  expect(
    screen.getByText(/This read failure does not confirm or undo earlier changes/)
  ).toBeVisible();
  expect(screen.queryByText(/nothing was written/i)).toBeNull();
  list.mockResolvedValue([{ ...licensedSupplier, authorized: false }]);
  view.rerender(await SuppliersPage({ searchParams: params({ supplier: 'sup-ok' }) }));
  const button = screen.getByRole('button', { name: 'Authorize this supplier' });
  expect(button).toBeDisabled();
  fireEvent.submit(button.closest('form')!);
  expect(write).toHaveBeenCalledOnce();
});

function allocationFixture(write: ReturnType<typeof vi.fn>) {
  const note = (id: string) => ({
    id,
    reference: id,
    issuedAt: new Date('2026-09-01'),
    position: {
      expectedCreditMinor: 10000,
      receivedCreditMinor: 0,
      outstandingMinor: 10000,
      varianceMinor: 0,
      status: 'OPEN',
    },
  });
  const ret = {
    id: 'ret-1',
    reference: 'RET-1',
    status: 'DISPATCHED',
    kind: 'PURCHASE_RETURN',
    supplier: licensedSupplier,
    createdAt: new Date('2026-09-01'),
    lines: [],
    debitNotes: [note('dn-1'), note('dn-2')],
  };
  const credit = (id: string) => ({
    id,
    reference: id,
    supplier: licensedSupplier,
    supplierId: 'sup-ok',
    amountMinor: 10000,
    receivedAt: new Date('2026-09-01'),
    allocations: [],
  });
  mocks.createCaller.mockReturnValue(
    callerStub({
      purchaseReturns: vi.fn().mockResolvedValue([ret]),
      supplierCredits: vi.fn().mockResolvedValue([credit('cr-1'), credit('cr-2')]),
      allocateSupplierCredit: write,
    })
  );
  vi.stubGlobal('window', { document, location: { origin: 'https://workspace.test' } });
}

function allocationForm(presentation: 'credit' | 'debit', id: string) {
  const name = presentation === 'credit' ? 'supplierCreditId' : 'debitNoteId';
  const form = screen
    .getAllByRole('button', { name: 'Allocate' })
    .map((button) => button.closest('form')!)
    .find(
      (form) =>
        form.querySelector(`input[type="hidden"][name="${name}"]`)?.getAttribute('value') === id
    );
  if (!form) throw new Error(`Allocation presentation missing: ${presentation} ${id}`);
  return form;
}

// Simulate stale enabled DOM and changed live selects without React change events.
// Correctness must come from the synchronous dispatch guard, not disabled styling.
function prepareLiveAllocation(form: HTMLFormElement, selection: string, amount = '10.00') {
  form.querySelector('fieldset')!.disabled = false;
  form.querySelector('select')!.value = selection;
  (form.querySelector('input[name="amountMinor"]') as HTMLInputElement).value = amount;
  const values = new FormData(form);
  return {
    branchId: values.get('branchId'),
    supplierCreditId: values.get('supplierCreditId'),
    debitNoteId: values.get('debitNoteId'),
    amountMinor: Number(values.get('amountMinor')) * 100,
  };
}

it.each([
  ['credit', 'pending'],
  ['debit', 'pending'],
  ['credit', 'uncertain'],
  ['debit', 'uncertain'],
  ['credit', 'committed'],
  ['debit', 'committed'],
] as const)(
  'blocks the opposite allocation presentation after %s dispatch is %s',
  async (direction, phase) => {
    let complete!: (value: object) => void;
    const write =
      phase === 'pending'
        ? vi.fn(
            () =>
              new Promise((resolve) => {
                complete = resolve;
              })
          )
        : phase === 'uncertain'
          ? vi.fn().mockRejectedValue(new Error('unknown result'))
          : vi.fn().mockResolvedValue({});
    allocationFixture(write);
    const view = render(await ReturnsPage({ searchParams: params({ return: 'ret-1' }) }));
    const first = allocationForm(direction, direction === 'credit' ? 'cr-1' : 'dn-1');
    const expected = prepareLiveAllocation(first, direction === 'credit' ? 'dn-1' : 'cr-1');
    await act(async () => {
      fireEvent.submit(first);
    });
    expect(write).toHaveBeenCalledExactlyOnceWith(expected);
    expect(expected).toEqual({
      branchId: 'branch-1',
      supplierCreditId: 'cr-1',
      debitNoteId: 'dn-1',
      amountMinor: 1000,
    });
    // Remove and restore selected debit forms without replacing the page store.
    view.rerender(await ReturnsPage({ searchParams: params() }));
    view.rerender(await ReturnsPage({ searchParams: params({ return: 'ret-1' }) }));
    const opposite = allocationForm(
      direction === 'credit' ? 'debit' : 'credit',
      direction === 'credit' ? 'dn-1' : 'cr-1'
    );
    expect(prepareLiveAllocation(opposite, direction === 'credit' ? 'cr-1' : 'dn-1')).toEqual(
      expected
    );
    await act(async () => {
      fireEvent.submit(opposite);
    });
    expect(write).toHaveBeenCalledExactlyOnceWith(expected);
    // Changing amount cannot turn the completed/uncertain pair into a fresh attempt.
    prepareLiveAllocation(opposite, direction === 'credit' ? 'cr-1' : 'dn-1', '11.00');
    await act(async () => {
      fireEvent.submit(opposite);
    });
    expect(write).toHaveBeenCalledOnce();
    if (phase === 'pending')
      await act(async () => {
        complete({});
      });
  }
);

it.each(['pending', 'uncertain'] as const)(
  'blocks overlapping selections but permits unrelated pairs during an %s allocation',
  async (phase) => {
    let complete!: (value: object) => void;
    const write = vi.fn().mockResolvedValue({});
    if (phase === 'pending')
      write.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          })
      );
    else write.mockRejectedValueOnce(new Error('unknown result'));
    allocationFixture(write);
    const view = render(await ReturnsPage({ searchParams: params({ return: 'ret-1' }) }));
    const draft = screen.getByLabelText(/Credit note reference/) as HTMLInputElement;
    fireEvent.change(draft, { target: { value: 'Unrelated credit draft' } });
    const first = allocationForm('credit', 'cr-1');
    const expected = prepareLiveAllocation(first, 'dn-1');
    await act(async () => {
      fireEvent.submit(first);
    });
    expect(write).toHaveBeenCalledExactlyOnceWith(expected);
    view.rerender(await ReturnsPage({ searchParams: params() }));
    view.rerender(await ReturnsPage({ searchParams: params({ return: 'ret-1' }) }));
    // Different credit, same debit; then same credit, different debit.
    const otherCredit = allocationForm('credit', 'cr-2');
    expect(prepareLiveAllocation(otherCredit, 'dn-1')).toEqual({
      ...expected,
      supplierCreditId: 'cr-2',
    });
    await act(async () => {
      fireEvent.submit(otherCredit);
    });
    const otherDebit = allocationForm('debit', 'dn-2');
    expect(prepareLiveAllocation(otherDebit, 'cr-1')).toEqual({ ...expected, debitNoteId: 'dn-2' });
    await act(async () => {
      fireEvent.submit(otherDebit);
    });
    expect(write).toHaveBeenCalledOnce();
    const unrelated = prepareLiveAllocation(otherCredit, 'dn-2');
    await act(async () => {
      fireEvent.submit(otherCredit);
    });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toEqual(unrelated);
    expect(unrelated).toEqual({
      branchId: 'branch-1',
      supplierCreditId: 'cr-2',
      debitNoteId: 'dn-2',
      amountMinor: 1000,
    });
    expect(screen.getByLabelText(/Credit note reference/)).toBe(draft);
    expect(draft).toHaveValue('Unrelated credit draft');
    if (phase === 'pending')
      await act(async () => {
        complete({});
      });
  }
);
