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
  secretName: string;
  managerInstruction: string;
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
  /** DEV-977 phase 3: the same, when the discount sheet applies to the whole bill. */
  discountApprovalLine: string;
  discountApprovalBill: string;
  /** DEV-977 phase 3: the supervisor block's "how", before "when you add the item" (or apply). */
  discountSupervisorHow: (codeFirst: boolean) => string;
  /** DEV-977 phase 3: the controlled line's refusal notice, and the Authorise sheet's lines. */
  controlledNeeds: string;
  controlledSecretNeeded: string;
  controlledReady: string;
  controlledPharmacistOnly: string;
};

export const COUNTER_APPROVAL_COPY: Record<ApprovalSecretKind, CounterApprovalCopy> = {
  CODE: {
    approverLabel: 'Approval code',
    secretName: 'approval code',
    managerInstruction:
      'A manager or owner enters their current authenticator code. A solo owner can enter their own code.',
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
    discountApprovalLine:
      'The server checks this line’s price and cost. If approval is required, a manager or owner enters their current approval code here.',
    discountApprovalBill:
      'Prescription, restricted and controlled medicines, and items that already have their own discount, voucher or promotion, are left out of a whole-bill discount and named. If you cannot give discounts on your own, a manager or owner approves with their approval code when you apply it.',
    discountSupervisorHow: (codeFirst) =>
      codeFirst
        ? 'They enter the current 6-digit code from their authenticator app on this till'
        : 'They choose their name and enter the current 6-digit code from their authenticator app on this till (a staff member with no login enters their PIN)',
    controlledNeeds:
      'Controlled medicine needs the patient address, the pharmacist’s approval code, and a prescription or an emergency prescriber.',
    controlledSecretNeeded: 'the pharmacist’s approval code',
    controlledReady: 'Ready. The pharmacist’s approval code is checked when the line is added.',
    controlledPharmacistOnly:
      'Controlled medicines need the patient’s address, a prescription or an emergency supply, and an independent pharmacist’s approval code. Ask the pharmacist on duty to add it at this till.',
  },
  PIN: {
    approverLabel: 'Approver PIN',
    secretName: 'PIN',
    managerInstruction:
      'A manager or owner must enter a fresh PIN. A solo owner can enter their own PIN.',
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
    discountApprovalLine:
      'The server checks this line’s price and cost. If approval is required, a manager or owner enters their staff PIN here.',
    discountApprovalBill:
      'Prescription, restricted and controlled medicines, and items that already have their own discount, voucher or promotion, are left out of a whole-bill discount and named. If you cannot give discounts on your own, a manager or owner approves with their PIN when you apply it.',
    discountSupervisorHow: () =>
      'They choose their name and enter their own staff PIN on this till',
    controlledNeeds:
      'Controlled medicine needs the patient address, a pharmacist PIN, and a prescription or an emergency prescriber.',
    controlledSecretNeeded: "the pharmacist's PIN",
    controlledReady: "Ready. The pharmacist's PIN is checked when the line is added.",
    controlledPharmacistOnly:
      "Controlled medicines need the patient's address, a prescription or an emergency supply, and an independent pharmacist's PIN. Ask the pharmacist on duty to add it at this till.",
  },
};

export function useCounterApprovalCopy(): CounterApprovalCopy {
  return COUNTER_APPROVAL_COPY[useContext(ApprovalSecretKindContext)];
}
