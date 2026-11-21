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
  /** Controlled medicine, step 3: the pharmacist's field, the line above the steps and the note
   * under the field. */
  pharmacistLabel: string;
  controlledIntro: string;
  pharmacistCleared: string;
  /** Controlled medicine return: the witnessing pharmacist's field and the line above it. */
  witnessLabel: string;
  witnessIntro: string;
  /** The discount sheet: who approves a discount the cashier may not give alone, and how. */
  discountApproval: string;
};

export const COUNTER_APPROVAL_COPY: Record<ApprovalSecretKind, CounterApprovalCopy> = {
  CODE: {
    approverLabel: 'Approval code',
    ownLabel: 'Your approval code',
    hint: "Enter the approver's current 6-digit code from their authenticator app. A staff member with no login enters their PIN. Nothing is saved on this device.",
    ownHint:
      'Required for every return and refund: the current 6-digit code from your authenticator app. Nothing is saved on this device.',
    pharmacistLabel: 'Pharmacist’s approval code',
    controlledIntro:
      'Patient address and the pharmacist’s approval code are required. Use a prescription, or record an emergency supply. Online only.',
    pharmacistCleared:
      'Leave the earlier serial blank unless this repeats a previous entry. The code is cleared after each attempt.',
    witnessLabel: 'Witness approval code',
    witnessIntro:
      'Controlled medicine. A different pharmacist must witness this return with the current code from their authenticator app (a pharmacist with no login enters their PIN). Nothing is saved on this device.',
    discountApproval:
      'Prescription, restricted and controlled medicines are never discounted. If you cannot give discounts on your own, a manager or owner approves with their approval code when you add the item.',
  },
  PIN: {
    approverLabel: 'Approver PIN',
    ownLabel: 'Your manager or owner PIN',
    hint: "Enter the approver's permanent PIN. The owner has turned the authenticator for approvals off. Nothing is saved on this device.",
    ownHint:
      'Required for every return and refund: your permanent PIN. The owner has turned the authenticator for approvals off. Nothing is saved on this device.',
    pharmacistLabel: 'Pharmacist PIN',
    controlledIntro:
      'Patient address and a pharmacist PIN are required. Use a prescription, or record an emergency supply. Online only.',
    pharmacistCleared:
      'Leave the earlier serial blank unless this repeats a previous entry. PIN is cleared after each attempt.',
    witnessLabel: 'Witness PIN',
    witnessIntro:
      'Controlled medicine. A different pharmacist must witness this return with a fresh PIN. The PIN is never saved on this device.',
    discountApproval:
      'Prescription, restricted and controlled medicines are never discounted. If you cannot give discounts on your own, a manager or owner approves with their PIN when you add the item.',
  },
};

export function useCounterApprovalCopy(): CounterApprovalCopy {
  return COUNTER_APPROVAL_COPY[useContext(ApprovalSecretKindContext)];
}
