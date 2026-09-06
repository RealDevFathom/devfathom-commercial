import { revalidatePath } from 'next/cache';
import ReturnsPage from './returns/page';
import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

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
  expect(screen.getByRole('status')).toHaveTextContent('reserved');
  expect(draft).toHaveValue('Unsaved credit');
  expect(draft).toHaveFocus();
  expect([draft.selectionStart, draft.selectionEnd]).toEqual([1, 5]);
  expect(write).toHaveBeenCalledOnce();
});
