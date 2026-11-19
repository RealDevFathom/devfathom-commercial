/**
 * DEV-960 — the owner setting "One pharmacist per shift", per branch: shared, client-safe facts.
 * The server module (`rx-solo-shift-policy.ts`) owns the decision; this file holds the words both
 * sides must agree on.
 *
 * With the setting off (the default), the solo rule (DEV-950) judges "alone" from the branch's
 * staff list: the pharmacist who rang up a prescription line signs its check only when nobody
 * else at the branch could. With it on, that pharmacist may also sign when others are on the
 * staff list, by re-entering their PIN and declaring they are the only pharmacist on duty now.
 * Controlled medicines are never self-signed either way.
 */

/**
 * The statement the owner accepts before turning the setting on. Its version is stored with the
 * accepted text, so once this ships, changing any of the wording needs a new version.
 */
export const RX_SOLO_SHIFT_DISCLAIMER = Object.freeze({
  version: 'rx-solo-shift-on@1',
  title: 'Turn on “One pharmacist per shift” at this branch?',
  text: 'With this on, the pharmacist who rang up a prescription line at this branch may sign its pharmacist check alone, with their own PIN, by declaring that they are the only pharmacist on duty now, even when other pharmacists are on the staff list. DevFathom cannot see who is on shift, so it records each such sign-off with the declaration and the other pharmacists on the staff list at that moment, and shows them to you. Controlled medicines still need an independent pharmacist. Making sure the declaration is true is your responsibility as the owner.',
  acknowledgement:
    'I have read this. This branch runs one pharmacist per shift, and checking the declared sign-offs is my responsibility as the owner.',
});

/** What the policy row stores as accepted: the statement version and the exact text agreed to. */
export function rxSoloShiftDisclaimerRecord(): string {
  return `${RX_SOLO_SHIFT_DISCLAIMER.version}: ${RX_SOLO_SHIFT_DISCLAIMER.text} ${RX_SOLO_SHIFT_DISCLAIMER.acknowledgement}`;
}

/**
 * The declaration the pharmacist confirms at the counter for each declared sign-off. The version
 * and text are written into the sign-off's audit entry.
 */
export const RX_ON_DUTY_DECLARATION = Object.freeze({
  version: 'rx-only-pharmacist-on-duty@1',
  text: 'I am the only pharmacist on duty now.',
});

/** One branch's setting as the owner's page shows it. */
export type RxSoloShiftBranchView = {
  branchId: string;
  branchName: string;
  branchCode: string;
  enabled: boolean;
  version: number;
  source: 'DEFAULT' | 'STORED' | 'FAIL_CLOSED';
  updatedAt: Date | null;
  updatedByName: string | null;
};

/** One declared solo sign-off as the owner's list shows it. */
export type RxDeclaredSoloSignOff = {
  auditId: string;
  signedAt: Date;
  signerId: string | null;
  signerName: string | null;
  branchId: string | null;
  branchName: string | null;
  saleId: string | null;
  receiptNumber: number | null;
  saleLineId: string | null;
  productName: string | null;
  /** The other pharmacists who could sign at that branch at that moment (the staff list). */
  otherSigners: Array<{ id: string; name: string | null }>;
};
