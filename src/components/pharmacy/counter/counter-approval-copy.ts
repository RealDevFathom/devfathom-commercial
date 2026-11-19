'use client';

import { createContext, useContext } from 'react';

/**
 * DEV-961: what a counter approval takes follows the owner's one setting, "Authenticator for
 * approvals": while it is on (the default), the approver's current authenticator code (a staff
 * member with no login keeps their PIN); while the owner has it off, everyone's permanent PIN.
 * The counter reads the setting once (`approvalAuthenticator.mode`) and provides it here.
 */
export type ApprovalSecretKind = 'CODE' | 'PIN';

/** On by default, so a counter that has not read the setting yet asks for a code. */
export const ApprovalSecretKindContext = createContext<ApprovalSecretKind>('CODE');

export function approvalSecretKind(required: boolean | null | undefined): ApprovalSecretKind {
  return required === false ? 'PIN' : 'CODE';
}

export type CounterApprovalCopy = {
  /** Label of a field for another person's approval. */
  approverLabel: string;
  /** Label of the signed-in manager's or owner's own re-entry (refunds and returns). */
  ownLabel: string;
  /** Hint under the field. */
  hint: string;
  /** Hint under the signed-in manager's or owner's own field. */
  ownHint: string;
};

export const COUNTER_APPROVAL_COPY: Record<ApprovalSecretKind, CounterApprovalCopy> = {
  CODE: {
    approverLabel: 'Approval code',
    ownLabel: 'Your approval code',
    hint: "Enter the approver's current 6-digit code from their authenticator app. A staff member with no login enters their PIN. Nothing is saved on this device.",
    ownHint:
      'Required for every return and refund: the current 6-digit code from your authenticator app. Nothing is saved on this device.',
  },
  PIN: {
    approverLabel: 'Approver PIN',
    ownLabel: 'Your manager or owner PIN',
    hint: "Enter the approver's permanent PIN. The owner has turned the authenticator for approvals off. Nothing is saved on this device.",
    ownHint:
      'Required for every return and refund: your permanent PIN. The owner has turned the authenticator for approvals off. Nothing is saved on this device.',
  },
};

export function useCounterApprovalCopy(): CounterApprovalCopy {
  return COUNTER_APPROVAL_COPY[useContext(ApprovalSecretKindContext)];
}
