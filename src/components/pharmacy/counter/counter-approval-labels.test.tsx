// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalSecretKindContext, type ApprovalSecretKind } from './counter-approval-copy';
import { CounterPackApprovalDialog } from './counter-pack-approval-dialog';
import { CounterTenderDiscard } from './counter-tender-discard';

afterEach(cleanup);

const approvers = [{ id: 'staff-1', name: 'Manager', self: false }];

/** DEV-961: the field follows the owner's authenticator setting; no provider means the default. */
function inMode(kind: ApprovalSecretKind | null, element: ReactElement) {
  return render(
    kind ? (
      <ApprovalSecretKindContext.Provider value={kind}>{element}</ApprovalSecretKindContext.Provider>
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
