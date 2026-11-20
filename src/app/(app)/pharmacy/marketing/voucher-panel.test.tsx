import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { VoucherPanel, voucherState, type VoucherPanelVoucher } from './voucher-panel';

const action = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ marketingAction: action }));

const future = new Date(Date.now() + 10 * 86_400_000);
const voucher = (overrides: Partial<VoucherPanelVoucher> = {}): VoucherPanelVoucher => ({
  id: 'voucher-a',
  code: 'GIFT10',
  name: 'Gift sets',
  discountMinor: 15_000,
  maxUses: 5,
  usedCount: 2,
  validUntil: future,
  active: true,
  revokedAt: null,
  messages: {
    whatsapp: 'Rs 150 off gift sets.\nValid on selected items only / Sirf muntakhib ashya par',
    print: 'Rs 150 off gift sets.\nMedicines excluded / Adviyaat shamil nahin',
  },
  ...overrides,
});

beforeEach(() => {
  action.mockReset();
});

it('DEV-780: lists each voucher with its uses against the limit and its state', () => {
  render(
    <VoucherPanel
      branchId="branch-a"
      vouchers={[
        voucher(),
        voucher({ id: 'voucher-b', code: 'USED', usedCount: 3, maxUses: 3 }),
        voucher({ id: 'voucher-c', code: 'OFF', active: false, revokedAt: new Date() }),
      ]}
      approvers={[]}
      unavailable={false}
      timeZone="Asia/Karachi"
    />
  );
  const table = screen.getByRole('region', { name: 'Issued vouchers' });
  const rows = within(table).getAllByRole('row');
  expect(within(rows[1]!).getByText('2 of 5')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('150.00')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('Active')).toBeInTheDocument();
  expect(within(rows[2]!).getByText('3 of 3')).toBeInTheDocument();
  expect(within(rows[2]!).getByText('Used up')).toBeInTheDocument();
  expect(within(rows[3]!).getByText('Revoked')).toBeInTheDocument();
  // A revoked voucher offers no revoke action; the others do, with their share text.
  expect(within(rows[3]!).queryByRole('button', { name: 'Revoke voucher' })).toBeNull();
  expect(within(rows[1]!).getByRole('button', { name: 'Revoke voucher' })).toBeInTheDocument();
  expect(within(rows[1]!).getByText(/Sirf muntakhib ashya par/)).toBeInTheDocument();
});

it('DEV-780: the owner sets the use limit when issuing and the form posts it', async () => {
  action.mockResolvedValue({ error: false, message: 'Voucher GIFT10 issued.' });
  render(
    <VoucherPanel
      branchId="branch-a"
      vouchers={[]}
      approvers={[{ id: 'staff-b', name: 'Manager B', self: false }]}
      unavailable={false}
      timeZone="Asia/Karachi"
    />
  );
  expect(screen.getByText(/No vouchers yet/)).toBeInTheDocument();
  fireEvent.change(selectFieldControl(screen.getByLabelText('Voucher code', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'GIFT10' } });
  fireEvent.change(selectFieldControl(screen.getByLabelText('Voucher name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'Gift sets' } });
  fireEvent.change(selectFieldControl(screen.getByLabelText('Value per use (Rs)', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '150' } });
  fireEvent.change(selectFieldControl(screen.getByLabelText('Uses allowed', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '25' } });
  fireEvent.change(selectFieldControl(screen.getByLabelText('Message for customers', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
    target: { value: 'Rs 150 off gift sets.' },
  });
  fireEvent.click(screen.getByLabelText(/I reviewed the code, value, use limit/, { selector: ':not([data-select-field-native][aria-hidden="true"])' }));
  expect(selectFieldControl(screen.getByLabelText('Approver', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('staff-b');
  fireEvent.click(screen.getByRole('button', { name: 'Issue voucher' }));
  await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  const data = action.mock.calls[0]![0] as FormData;
  expect(data.get('operation')).toBe('voucher-issue');
  expect(data.get('maxUses')).toBe('25');
  expect(data.get('discountRupees')).toBe('150');
  expect(data.get('timeZone')).toBe('Asia/Karachi');
  expect(await screen.findByText('Voucher GIFT10 issued.')).toBeInTheDocument();
});

it('DEV-780: tells a solo owner to re-enter their own PIN above the cap', () => {
  render(
    <VoucherPanel
      branchId="branch-a"
      vouchers={[]}
      approvers={[{ id: 'staff-a', name: 'Owner A', self: true }]}
      unavailable={false}
    />
  );
  expect(screen.getByText(/You are the only approver, so re-enter your own PIN/)).toBeVisible();
  expect(screen.getByRole('option', { hidden: true, name: 'Owner A (you)' })).toBeInTheDocument();
});

it('DEV-780: disables issuing while vouchers cannot be loaded', () => {
  render(<VoucherPanel branchId="branch-a" vouchers={null} approvers={[]} unavailable />);
  expect(screen.getByRole('alert')).toHaveTextContent('Vouchers could not be loaded');
  expect(screen.getByRole('button', { name: 'Issue voucher' })).toBeDisabled();
});

it('DEV-780: a voucher is expired at its stored end, before it is used up', () => {
  const now = new Date('2026-11-18T10:00:00.000Z');
  expect(voucherState(voucher({ validUntil: now }), now).label).toBe('Expired');
  expect(voucherState(voucher({ usedCount: 5 }), now).label).toBe('Used up');
  expect(voucherState(voucher(), now).label).toBe('Active');
});
