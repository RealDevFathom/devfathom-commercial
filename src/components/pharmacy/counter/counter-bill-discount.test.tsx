import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COUNTER_DISCOUNT_APPROVAL_REQUIRED } from '@/lib/pharmacy/counter-messages';
import { CounterBillDiscountEntry } from './counter-bill-discount';
import { BillDiscountSettingPanel } from './bill-discount-setting-panel';

const mocks = vi.hoisted(() => ({
  setting: {
    data: { enabled: true, canChange: true } as
      { enabled: boolean; canChange: boolean } | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  maximum: { data: { maxDiscountBps: 1_000, canChange: false } },
  apply: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      billDiscountSetting: { useQuery: () => mocks.setting },
      discountMaximum: { useQuery: () => mocks.maximum },
      applyBillDiscount: {
        useMutation: () => ({ mutateAsync: mocks.apply, isPending: false }),
      },
      saveBillDiscountSetting: {
        useMutation: () => ({ mutateAsync: mocks.save, isPending: false }),
      },
    },
  },
}));

const lines = [
  { saleLineId: 'line-1', medicineName: 'Vitamin C', billDiscountMinor: 0 },
  { saleLineId: 'line-2', medicineName: 'Amoxicillin', billDiscountMinor: 0 },
];
const applied = {
  status: 'APPLIED',
  totalMinor: 1_250,
  previousTotalMinor: 0,
  lines: [{ saleLineId: 'line-1', discountMinor: 1_250 }],
  excluded: [{ saleLineId: 'line-2', reason: 'REGULATED' }],
};

function entry(overrides: Partial<Parameters<typeof CounterBillDiscountEntry>[0]> = {}) {
  const props = {
    branchId: 'branch-1',
    saleId: 'sale-1',
    lines,
    disabled: false,
    requestApproval: vi.fn(async () => null),
    onChanged: vi.fn(),
    ...overrides,
  };
  render(<CounterBillDiscountEntry {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setting.data = { enabled: true, canChange: true };
  mocks.setting.isLoading = false;
  mocks.setting.isError = false;
  mocks.setting.refetch.mockResolvedValue({ data: mocks.setting.data });
  mocks.apply.mockResolvedValue(applied);
  mocks.save.mockResolvedValue({ enabled: false });
});

describe('DEV-956 counter whole-bill discount', () => {
  it('shows nothing at all while the owner has the setting off', () => {
    mocks.setting.data = { enabled: false, canChange: false };
    const { container } = render(
      <CounterBillDiscountEntry
        branchId="branch-1"
        saleId="sale-1"
        lines={lines}
        disabled={false}
        requestApproval={vi.fn()}
        onChanged={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('sends a typed rupee amount through the shared money reader and names the items left out', async () => {
    const props = entry();
    fireEvent.click(screen.getByText('Discount the whole bill'));
    fireEvent.click(screen.getByRole('button', { name: 'Amount (Rs)' }));
    fireEvent.change(screen.getByLabelText('Bill discount (Rs)'), { target: { value: '12.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to bill' }));
    await waitFor(() =>
      expect(mocks.apply).toHaveBeenCalledWith({
        branchId: 'branch-1',
        saleId: 'sale-1',
        discount: { kind: 'AMOUNT', minor: 1_250 },
      })
    );
    expect(props.onChanged).toHaveBeenCalledWith(
      'A whole-bill discount of Rs 12.50 is on the bill, shared over 1 item. 1 item was left out.'
    );
    expect(
      screen.getByRole('list', { name: 'Items left out of the bill discount' })
    ).toHaveTextContent(
      'Amoxicillin: not discounted, because prescription, restricted and controlled medicines are never discounted.'
    );
  });

  it("refuses a percentage above the owner's maximum, and a malformed amount, before sending", () => {
    entry();
    fireEvent.click(screen.getByText('Discount the whole bill'));
    fireEvent.change(screen.getByLabelText('Bill discount (%)'), { target: { value: '10.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to bill' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      "10.5% is above the owner's maximum discount of 10%."
    );
    fireEvent.click(screen.getByRole('button', { name: 'Amount (Rs)' }));
    fireEvent.change(screen.getByLabelText('Bill discount (Rs)'), { target: { value: '1.234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to bill' }));
    expect(screen.getByLabelText('Bill discount (Rs)')).toHaveAttribute('aria-invalid', 'true');
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('asks for a manager PIN when the cashier cannot discount alone, then sends it once', async () => {
    const approval = { staffProfileId: 'staff-manager', pin: '2468' };
    mocks.apply
      .mockRejectedValueOnce(new Error(COUNTER_DISCOUNT_APPROVAL_REQUIRED))
      .mockResolvedValueOnce(applied);
    const props = entry({ requestApproval: vi.fn(async () => approval) });
    fireEvent.click(screen.getByText('Discount the whole bill'));
    fireEvent.change(screen.getByLabelText('Bill discount (%)'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to bill' }));
    await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(2));
    expect(props.requestApproval).toHaveBeenCalledWith('5% off the bill');
    expect(mocks.apply).toHaveBeenLastCalledWith({
      branchId: 'branch-1',
      saleId: 'sale-1',
      discount: { kind: 'PERCENT', bps: 500 },
      discountApproval: approval,
    });
  });

  it('tells the cashier the most the bill can take when the server refuses', async () => {
    mocks.apply.mockResolvedValueOnce({
      status: 'REFUSED',
      reason: 'ABOVE_LIMIT',
      requestedMinor: 50_000,
      capacityMinor: 31_600,
      excluded: [],
    });
    const props = entry();
    fireEvent.click(screen.getByText('Discount the whole bill'));
    fireEvent.click(screen.getByRole('button', { name: 'Amount (Rs)' }));
    fireEvent.change(screen.getByLabelText('Bill discount (Rs)'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to bill' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This bill can take at most Rs 316.00 off'
    );
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it('shows the discount on the bill and removes it without an approval', async () => {
    mocks.apply.mockResolvedValueOnce({ ...applied, totalMinor: 0, lines: [], excluded: [] });
    const props = entry({
      lines: [{ ...lines[0]!, billDiscountMinor: 1_250 }, lines[1]!],
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Whole-bill discount: Rs 12.50, shared over 1 of 2 items.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove bill discount' }));
    await waitFor(() =>
      expect(mocks.apply).toHaveBeenCalledWith({
        branchId: 'branch-1',
        saleId: 'sale-1',
        discount: { kind: 'AMOUNT', minor: 0 },
      })
    );
    expect(props.onChanged).toHaveBeenCalledWith('The whole-bill discount was removed.');
  });

  it('is disabled while the bill has taken a payment or the counter is busy', () => {
    entry({ disabled: true });
    fireEvent.click(screen.getByText('Discount the whole bill'));
    expect(screen.getByRole('button', { name: 'Apply to bill' })).toBeDisabled();
    expect(screen.getByLabelText('Bill discount (%)')).toBeDisabled();
  });
});

describe('DEV-956 owner whole-bill discount setting', () => {
  it('shows the setting off by default and turns it on only with the owner PIN', async () => {
    mocks.setting.data = { enabled: false, canChange: true };
    mocks.save.mockResolvedValueOnce({ enabled: true });
    render(<BillDiscountSettingPanel branchId="branch-1" />);
    expect(screen.getByText('Off')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Turn on whole-bill discount' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '2468' } });
    fireEvent.click(button);
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({ branchId: 'branch-1', enabled: true, pin: '2468' })
    );
    expect(await screen.findByRole('status')).toHaveTextContent('The whole-bill discount is on.');
    expect(screen.getByLabelText('Your PIN')).toHaveValue('');
  });

  it('tells everyone else only the owner can change it, with no PIN field', () => {
    mocks.setting.data = { enabled: true, canChange: false };
    render(<BillDiscountSettingPanel branchId="branch-1" />);
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(screen.getByText('Only the owner can change this setting.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Your PIN')).toBeNull();
  });

  it('explains a failed read and offers a retry', () => {
    mocks.setting.data = undefined;
    mocks.setting.isError = true;
    render(<BillDiscountSettingPanel branchId="branch-1" />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The whole-bill discount setting is unavailable.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.setting.refetch).toHaveBeenCalled();
  });
});
