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
