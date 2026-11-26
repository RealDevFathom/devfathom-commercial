'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { OwnPinLink, PinAwareMessage } from '@/components/pharmacy/pin-aware-message';
import { APPROVAL_AUTHENTICATOR_SETUP_MESSAGE } from '@/lib/auth/session-state';
import { Button } from '@/components/ui/button';
import { ApprovalSecretKindContext } from './counter-approval-copy';

export const CounterSessionContext = createContext(false);

export type ApprovalEntry = {
  pin: string;
  staffProfileId?: string;
  matchingStaffProfileId?: string;
  choiceProof?: string;
};

export type ApprovalMatches = Array<{ id: string; proof: string }>;

export function matchingProfiles(error: unknown): ApprovalMatches | undefined {
  const data = (error as { data?: { matchingStaffProfileIds?: unknown; choiceProofs?: unknown } } | null)?.data;
  const ids = data?.matchingStaffProfileIds;
  const proofs = data?.choiceProofs;
  if (!Array.isArray(ids) || !Array.isArray(proofs) || ids.length < 2 || ids.length !== proofs.length)
    return undefined;
  if (!ids.every((id) => typeof id === 'string') || !proofs.every((proof) => typeof proof === 'string'))
    return undefined;
  return ids.map((id, index) => ({ id, proof: proofs[index] }));
}

export function useApprovalEntry(initialMatches?: ApprovalMatches) {
  const hasSession = useContext(CounterSessionContext);
  const kind = useContext(ApprovalSecretKindContext);
  const [byName, setByName] = useState(false);
  const [matches, setMatches] = useState(initialMatches);
  const [profile, setProfile] = useState('');
  const [pin, setPin] = useState('');
  const codeOnly = hasSession && kind === 'CODE' && !byName && !matches;
  let entry: ApprovalEntry | undefined;
  if (codeOnly) {
    if (/^\d{6}$/.test(pin)) entry = { pin };
  } else if (matches) {
    const selected = matches.find((match) => match.id === profile);
    if (hasSession && kind === 'CODE' && selected && /^\d{6}$/.test(pin))
      entry = { matchingStaffProfileId: profile, choiceProof: selected.proof, pin };
  } else if (profile && /^\d{4,8}$/.test(pin)) {
    entry = { staffProfileId: profile, pin };
  }

  function reset(nextMatches?: ApprovalMatches) {
    setMatches(nextMatches);
    setByName(false);
    setProfile('');
    setPin('');
  }

  return {
    codeOnly,
    matches,
    profile,
    pin,
    entry,
    setProfile,
    setPin,
    reset,
    chooseByName() {
      reset();
      setByName(true);
    },
    visible<T extends { id: string }>(rows: readonly T[]) {
      return matches ? rows.filter((row) => matches.some((match) => match.id === row.id)) : rows;
    },
  };
}

export function UnavailableCounterApprover({ pharmacist = false }: { pharmacist?: boolean }) {
  const kind = useContext(ApprovalSecretKindContext);
  const who = pharmacist ? 'pharmacist' : 'manager or owner';
  if (kind === 'CODE')
    return (
      <>
        No {who} is available to approve.{' '}
        <PinAwareMessage message={APPROVAL_AUTHENTICATOR_SETUP_MESSAGE} />
      </>
    );
  return (
    <>
      {pharmacist
        ? 'No pharmacist is available to approve this batch.'
        : 'No manager or owner has an active staff PIN. A manager or owner creates their own under Settings, Your PIN.'}{' '}
      <OwnPinLink />
    </>
  );
}

export function ApprovalFallback({
  form,
  disabled,
}: {
  form: ReturnType<typeof useApprovalEntry>;
  disabled?: boolean;
}) {
  if (!form.codeOnly) return null;
  return (
    <Button
      type="button"
      variant="outline"
      className="min-h-11"
      disabled={disabled}
      onClick={form.chooseByName}
    >
      Choose the approver by name
    </Button>
  );
}
export function ApprovalNames({
  form,
  children,
}: {
  form: ReturnType<typeof useApprovalEntry>;
  children: ReactNode;
}) {
  if (form.codeOnly) return null;
  return (
    <>
      {form.matches && (
        <p role="status">
          More than one person matches. Choose who is approving and wait for their next
          authenticator code, then enter it.
        </p>
      )}
      {children}
    </>
  );
}

/** Dialog-based approvals get one explicit follow-up only for a structured collision. */
export async function submitDialogApproval<T>(
  request: (matches?: ApprovalMatches) => Promise<ApprovalEntry | null>,
  submit: (entry: ApprovalEntry) => Promise<T>
): Promise<T | null> {
  const entry = await request();
  if (!entry) return null;
  try {
    return await submit(entry);
  } catch (error) {
    const matches = matchingProfiles(error);
    if (!matches || entry.staffProfileId || entry.matchingStaffProfileId) throw error;
    const choice = await request(matches);
    if (!choice) return null;
    if (!choice.matchingStaffProfileId || !matches.some((match) => match.id === choice.matchingStaffProfileId && match.proof === choice.choiceProof))
      throw error;
    return submit(choice);
  }
}
