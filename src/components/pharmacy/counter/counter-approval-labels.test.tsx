// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CounterPackApprovalDialog } from './counter-pack-approval-dialog';
import { CounterTenderDiscard } from './counter-tender-discard';

afterEach(cleanup);

const approvers = [{ id: 'staff-1', name: 'Manager', self: false }];
const hint = /PIN or .*6-digit.*authenticator|authenticator for approvals, enter its 6-digit code/i;

describe('counter approval dialogs accept a PIN or an authenticator code', () => {
  it('first-expiry pack approval dialog says so', async () => {
    render(
      <CounterPackApprovalDialog
        medicineName="Item"
        loadApprovers={() => Promise.resolve(approvers)}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    );
    const input = await screen.findByLabelText('Approver PIN');
    expect(input).toHaveAccessibleDescription(hint);
    expect(input).toHaveAccessibleDescription(/6-digit code/);
  });

  it('tender discard form says so', async () => {
    render(
      <CounterTenderDiscard loadApprovers={() => Promise.resolve(approvers)} onDiscard={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: /discard this attempt/i }));
    const input = await screen.findByLabelText('Approver PIN');
    expect(input).toHaveAccessibleDescription(hint);
    expect(input).toHaveAccessibleDescription(/6-digit code/);
  });
});
