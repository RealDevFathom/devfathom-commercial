'use client';

import { trpc } from '@/lib/trpc';
import {
  approvalSecretKind,
  type ApprovalSecretKind,
} from '@/components/pharmacy/counter/counter-approval-copy';

/**
 * DEV-961: what an approval takes in this organization, read from the owner's one setting
 * ("Authenticator for approvals", `approvalAuthenticator.mode`): the current app code while it
 * is on (the default, and until it is read), the permanent PIN while the owner has it off. For
 * wording only; the server's shared verifier decides.
 */
export function useApprovalSecretKind(): ApprovalSecretKind {
  const mode = trpc.approvalAuthenticator.mode.useQuery(undefined, { staleTime: 60_000 });
  return approvalSecretKind(mode?.data?.required);
}

/** The owner's field on a weighty access change. */
export function useOwnApprovalLabel() {
  return useApprovalSecretKind() === 'CODE' ? 'Your approval code' : 'Your PIN';
}

export type OwnerSelfApprovalCopy = {
  /** Catalogue queue: the field for the owner's own approval of an edit. */
  catalogueLabel: string;
  /** Catalogue queue: the line under the heading. */
  catalogueIntro: string;
  /** Catalogue queue: why the field is shown (an edit the owner submitted). */
  ownEditReason: string;
  /** Catalogue queue: why the field is shown (nobody holds the review permission). */
  ownerFallbackReason: string;
  /** Medicine reference review: the field for the owner's own approval. */
  referenceLabel: string;
  /** Medicine reference review: why the field is shown (rows the owner imported or edited). */
  referenceOwnRowsReason: string;
};

/** DEV-976 × DEV-961: the solo owner's own approval of a catalogue or reference change. */
export const OWNER_SELF_APPROVAL_COPY: Record<ApprovalSecretKind, OwnerSelfApprovalCopy> = {
  CODE: {
    catalogueLabel: 'Your approval code (for self-approval)',
    catalogueIntro:
      'Edits stay pending until a catalogue reviewer approves them. A solo owner may approve with the current code from their authenticator app. Every approval is audited.',
    ownEditReason:
      'Nobody else can review, so you approve with the current 6-digit code from your authenticator app.',
    ownerFallbackReason:
      'Nobody holds the catalogue review permission, so you approve as the owner with the current 6-digit code from your authenticator app.',
    referenceLabel: 'Your approval code for reference self-approval',
    referenceOwnRowsReason:
      'Nobody else can review, so you approve the rows you imported or edited yourself with the current 6-digit code from your authenticator app.',
  },
  PIN: {
    catalogueLabel: 'Solo owner PIN (for self-approval)',
    catalogueIntro:
      'Edits stay pending until a catalogue reviewer approves them. A solo owner may approve by entering their own fresh PIN. Every approval is audited.',
    ownEditReason: 'Nobody else can review, so you approve with your own PIN.',
    ownerFallbackReason:
      'Nobody holds the catalogue review permission, so you approve as the owner with your own PIN.',
    referenceLabel: 'Solo owner PIN for reference self-approval',
    referenceOwnRowsReason:
      'Nobody else can review, so you approve the rows you imported or edited yourself with your own PIN.',
  },
};

export function useOwnerSelfApprovalCopy(): OwnerSelfApprovalCopy {
  return OWNER_SELF_APPROVAL_COPY[useApprovalSecretKind()];
}
