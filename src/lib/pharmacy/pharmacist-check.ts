/**
 * DEV-911 — the owner switch for the pharmacist check and prescription record at each sale:
 * shared, client-safe facts. The server module (`pharmacist-check-policy.ts`) owns the
 * decision; this file holds the words both sides must agree on.
 */

/**
 * The disclaimer the owner accepts before turning the check off. The version is stored with
 * the accepted text, so once this ships, changing any of the wording needs a new version.
 */
export const PHARMACIST_CHECK_DISCLAIMER = Object.freeze({
  version: 'pharmacist-check-off@1',
  title: 'Turn off the pharmacist check and prescription record at each sale?',
  text: 'With this turned off, the app will no longer ask a pharmacist to check prescription-only and controlled medicines at the sale, and will no longer ask for a prescription to be recorded. Keeping to the drug laws, including pharmacist supervision and prescription records, is then entirely your responsibility as the owner. DevFathom does not check it for you.',
  acknowledgement:
    'I have read this. Keeping to the drug laws at the sale is my responsibility as the owner.',
});

/** What the audit stores as accepted: the disclaimer version and the exact text agreed to. */
export function pharmacistCheckDisclaimerRecord(): string {
  return `${PHARMACIST_CHECK_DISCLAIMER.version}: ${PHARMACIST_CHECK_DISCLAIMER.text} ${PHARMACIST_CHECK_DISCLAIMER.acknowledgement}`;
}

/** The plain note the counter shows on a prescription-only or controlled line while it is off. */
export const PHARMACIST_CHECK_OFF_NOTE = 'Pharmacist check is switched off by the owner';

/** The controlled register's marker on a sale entry written while the check was off. */
export const PHARMACIST_CHECK_OFF_SIGNATURE_PREFIX = 'pharmacist-check-off:';

export function pharmacistCheckOffSignature(policyVersion: number): string {
  return `${PHARMACIST_CHECK_OFF_SIGNATURE_PREFIX}v${policyVersion}`;
}

/** The setting as the settings page and the counter show it. */
export type PharmacistCheckPolicyView = {
  enabled: boolean;
  version: number;
  source: 'DEFAULT' | 'STORED' | 'FAIL_CLOSED';
  updatedAt: Date | null;
  updatedByName: string | null;
};
