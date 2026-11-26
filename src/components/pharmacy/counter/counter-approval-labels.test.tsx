// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      discountMaximum: {
        useQuery: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
      },
    },
  },
}));

import { CounterSessionContext, submitDialogApproval } from './counter-approval-entry';
import { ApprovalSecretKindContext, type ApprovalSecretKind } from './counter-approval-copy';
import { CounterDiscountEntry } from './counter-discount';
import { CounterPackApprovalDialog } from './counter-pack-approval-dialog';
import { CounterTenderDiscard } from './counter-tender-discard';

afterEach(cleanup);

const approvers = [{ id: 'staff-1', name: 'Manager', self: false }];

/** DEV-961: the field follows the owner's authenticator setting; no provider means the default. */
function inMode(kind: ApprovalSecretKind | null, element: ReactElement) {
  return render(
    kind ? (
      <ApprovalSecretKindContext.Provider value={kind}>
        {element}
      </ApprovalSecretKindContext.Provider>
    ) : (
      element
    )
  );
}

const packDialog = (
  <CounterPackApprovalDialog
    medicineName="Item"
    loadApprovers={() => Promise.resolve(approvers)}
    onCancel={vi.fn()}
    onConfirm={vi.fn()}
  />
);
const discard = (
  <CounterTenderDiscard loadApprovers={() => Promise.resolve(approvers)} onDiscard={vi.fn()} />
);

describe('DEV-961 counter approval fields follow the authenticator setting', () => {
  it.each([null, 'CODE'] as const)(
    'ask for the approver’s current app code while it is on (provider: %s)',
    async (kind) => {
      inMode(kind, packDialog);
      const input = await screen.findByLabelText('Approval code');
      expect(input).toHaveAccessibleDescription(/6-digit code from their authenticator app/);
      expect(screen.getByRole('dialog')).toHaveAccessibleDescription(/current authenticator code/);
      expect(input).toHaveAccessibleDescription(/no login enters their PIN/);
      cleanup();
      inMode(kind, discard);
      fireEvent.click(screen.getByRole('button', { name: /discard this attempt/i }));
      expect(await screen.findByLabelText('Approval code')).toHaveAccessibleDescription(
        /6-digit code/
      );
    }
  );

  it('ask for the approver’s permanent PIN while the owner has it off', async () => {
    inMode('PIN', packDialog);
    const input = await screen.findByLabelText('Approver PIN');
    expect(input).toHaveAccessibleDescription(/permanent PIN/);
    expect(input).not.toHaveAccessibleDescription(/6-digit/);
    cleanup();
    inMode('PIN', discard);
    fireEvent.click(screen.getByRole('button', { name: /discard this attempt/i }));
    expect(await screen.findByLabelText('Approver PIN')).toHaveAccessibleDescription(
      /permanent PIN/
    );
  });
});

describe('DEV-961 the discount sheet says how a manager or owner approves', () => {
  const entry = (
    <CounterDiscountEntry
      branchId="branch-a"
      held={null}
      disabled={false}
      onHold={vi.fn()}
      onClear={vi.fn()}
    />
  );
  it.each([null, 'CODE'] as const)('with their approval code while it is on (%s)', (kind) => {
    inMode(kind, entry);
    fireEvent.click(screen.getByRole('button', { name: 'Discount' }));
    expect(
      screen.getByText(/a manager or owner approves with their approval code when you add the item/)
    ).toBeInTheDocument();
  });
  it('with their PIN while the owner has it off', () => {
    inMode('PIN', entry);
    fireEvent.click(screen.getByRole('button', { name: 'Discount' }));
    expect(
      screen.getByText(/a manager or owner approves with their PIN when you add the item/)
    ).toBeInTheDocument();
  });
});

const staff = [
  { id: 'a', name: 'Alex', self: false },
  { id: 'b', name: 'Blair', self: false },
  { id: 'c', name: 'Casey', self: false },
];
const loadStaff = async () => staff;

it.each([
  [true, 'CODE', true],
  [false, 'CODE', false],
  [true, 'PIN', false],
] as const)('selects the entry flow for session=%s, mode=%s', async (session, mode, codeFirst) => {
  const confirm = vi.fn();
  render(
    <CounterSessionContext.Provider value={session}>
      <ApprovalSecretKindContext.Provider value={mode}>
        <CounterPackApprovalDialog
          medicineName="Fixture pack"
          loadApprovers={loadStaff}
          onCancel={vi.fn()}
          onConfirm={confirm}
        />
      </ApprovalSecretKindContext.Provider>
    </CounterSessionContext.Provider>
  );
  const input = screen.getByLabelText(mode === 'CODE' ? 'Approval code' : 'Approver PIN');
  if (codeFirst) {
    expect(screen.queryByLabelText('Approving manager or owner')).toBeNull();
    fireEvent.change(input, { target: { value: '1234' } });
    expect(screen.getByRole('button', { name: 'Approve pack' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve pack' }));
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ pin: '123456' });
    fireEvent.click(screen.getByRole('button', { name: 'Choose the approver by name' }));
  }
  await screen.findByRole('option', { name: 'Blair' });
  expect(input).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Approving manager or owner'), { target: { value: 'b' } });
  fireEvent.change(input, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Approve pack' }));
  expect(confirm).toHaveBeenLastCalledWith({ staffProfileId: 'b', pin: '123456' });
});

it('offers only the returned names after a collision and requires an explicit choice', async () => {
  const onDiscard = vi
    .fn()
    .mockResolvedValueOnce({
      status: 'unknown',
      message: 'Choose the approver',
      matchingStaffProfileIds: ['a', 'c'],
    })
    .mockResolvedValueOnce({ status: 'rejected', message: 'Discarded' });
  render(
    <CounterSessionContext.Provider value={true}>
      <CounterTenderDiscard loadApprovers={loadStaff} onDiscard={onDiscard} />
    </CounterSessionContext.Provider>
  );
  fireEvent.click(screen.getByRole('button', { name: /discard this attempt/i }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Fixture reason' } });
  fireEvent.change(screen.getByLabelText('Approval code'), { target: { value: '123456' } });
  const submit = screen.getByRole('button', { name: 'Discard payment attempt' });
  fireEvent.click(submit);
  expect(onDiscard).toHaveBeenCalledExactlyOnceWith({ pin: '123456', reason: 'Fixture reason' });
  await screen.findByRole('option', { name: 'Casey' });
  expect(screen.queryByRole('option', { name: 'Blair' })).toBeNull();
  expect(screen.getByLabelText('Approving manager or owner')).toHaveValue('');
  expect(submit).toBeDisabled();
  expect(screen.getByLabelText('Approval code')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Approving manager or owner'), { target: { value: 'c' } });
  fireEvent.change(screen.getByLabelText('Approval code'), { target: { value: '654321' } });
  fireEvent.click(submit);
  expect(onDiscard).toHaveBeenLastCalledWith({
    matchingStaffProfileId: 'c',
    pin: '654321',
    reason: 'Fixture reason',
  });
});

it('continues a line approval only after a matching person is explicitly chosen', async () => {
  const collision = Object.assign(new Error('Choose the approver'), {
    data: { matchingStaffProfileIds: ['a', 'c'] },
  });
  const request = vi
    .fn()
    .mockResolvedValueOnce({ pin: '123456' })
    .mockResolvedValueOnce({ matchingStaffProfileId: 'c', pin: '654321' });
  const send = vi.fn().mockRejectedValueOnce(collision).mockResolvedValueOnce('approved');
  await expect(submitDialogApproval(request, send)).resolves.toBe('approved');
  expect(request.mock.calls).toEqual([[], [['a', 'c']]]);
  expect(send.mock.calls).toEqual([
    [{ pin: '123456' }],
    [{ matchingStaffProfileId: 'c', pin: '654321' }],
  ]);

  request.mockResolvedValueOnce({ pin: '123456' }).mockResolvedValueOnce(null);
  send.mockClear().mockRejectedValueOnce(collision);
  await expect(submitDialogApproval(request, send)).resolves.toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
});
