/**
 * Narcotics register, spec section 7 — the per-province shape of a controlled-drug
 * sale entry, driven by the branch's regulatory profile (its `provinceCode` and the
 * linked jurisdiction rule set). The digital register itself already exists; this
 * only adds the province-specific *required fields* #111 does not yet enforce.
 *
 * Only the differences the primary provincial texts actually state are encoded:
 *  - Sindh (Sindh Drugs Rules 1979 as amended 2010, §7b): the retail B/E/F register
 *    records the "name of the patient/purchaser with complete address", so a Sindh
 *    sale needs the patient's complete address, not just a name.
 *  - Punjab (§1) and Balochistan (§7a): the register column is "Name of the patient
 *    /purchaser"; a complete address is not demanded on the register page itself.
 *  - KP and the federal CNS Rules 2001 are NOT OBTAINED (§7c, §7d), so they stay on
 *    the base default — no extra required fields.
 *
 * The bill/invoice number the Sindh register also carries (§7b) belongs to the sale
 * receipt, not to a second copy inside the register, so it is not duplicated here;
 * the register row links to its sale through the stock movement.
 *
 * Reuse of the pending-legal-review flag: a province whose controlled-register rules
 * are still provisional (`controlledRegisterFlags.provisional !== false`) is recorded
 * but not hard-enforced. We do not refuse a sale over a requirement a lawyer has not
 * yet confirmed; enforcement switches on only once the rule set is marked confirmed.
 */

/** Pakistan province codes used by the regulatory profile (mirrors PAKISTAN_PROVINCES). */
export const PROVINCE_SINDH = 'PK-SD';
export const PROVINCE_PUNJAB = 'PK-PB';
export const PROVINCE_BALOCHISTAN = 'PK-BA';

/** What a controlled-drug SALE entry must carry in a given province. */
export type ControlledRegisterRule = {
  code: string;
  /** The sale needs the patient's/purchaser's complete address, not only a name. */
  requiresPatientAddress: boolean;
};

const RULES: Record<string, ControlledRegisterRule> = {
  [PROVINCE_SINDH]: { code: PROVINCE_SINDH, requiresPatientAddress: true },
  [PROVINCE_PUNJAB]: { code: PROVINCE_PUNJAB, requiresPatientAddress: false },
  [PROVINCE_BALOCHISTAN]: { code: PROVINCE_BALOCHISTAN, requiresPatientAddress: false },
};

/** The base rule for any province whose text is not obtained (KP, federal, unknown). */
const DEFAULT_RULE: ControlledRegisterRule = { code: 'DEFAULT', requiresPatientAddress: false };

export function controlledRegisterRule(provinceCode: string | null | undefined): ControlledRegisterRule {
  if (!provinceCode) return DEFAULT_RULE;
  return RULES[provinceCode] ?? { ...DEFAULT_RULE, code: provinceCode };
}

/** The province setting a sale is checked against, resolved from the branch profile. */
export type ProvincialRegisterSetting = {
  provinceCode: string;
  /** The rule set is still pending legal review (`controlledRegisterFlags.provisional`). */
  pendingLegalReview: boolean;
};

/**
 * Read the pending-legal-review marker from a rule set's `controlledRegisterFlags`.
 * Anything but an explicit `provisional: false` counts as pending, matching the guard
 * and the regulatory-profile form, so we never enforce a rule that is not yet confirmed.
 */
export function isPendingLegalReview(controlledRegisterFlags: unknown): boolean {
  const flags =
    controlledRegisterFlags && typeof controlledRegisterFlags === 'object'
      ? (controlledRegisterFlags as { provisional?: unknown })
      : {};
  return flags.provisional !== false;
}

/**
 * The register fields a sale is missing for its province. Empty when nothing is
 * missing, when there is no province setting, or while the province's rules are
 * still pending legal review.
 */
export function missingControlledSaleFields(
  setting: ProvincialRegisterSetting | null | undefined,
  entry: { patientAddress: string | null | undefined }
): string[] {
  if (!setting || setting.pendingLegalReview) return [];
  const rule = controlledRegisterRule(setting.provinceCode);
  const missing: string[] = [];
  if (rule.requiresPatientAddress && !entry.patientAddress?.trim()) {
    missing.push("the patient's complete address");
  }
  return missing;
}

/** A controlled sale refused because its province requires a register field it lacks. */
export class ProvincialRegisterError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      missing.length === 1
        ? `This province's controlled-drug register requires ${missing[0]}.`
        : `This province's controlled-drug register requires ${missing.join(', ')}.`
    );
    this.name = 'ProvincialRegisterError';
  }
}

/** Throw {@link ProvincialRegisterError} when a sale is missing a province-required field. */
export function assertControlledSaleFields(
  setting: ProvincialRegisterSetting | null | undefined,
  entry: { patientAddress: string | null | undefined }
): void {
  const missing = missingControlledSaleFields(setting, entry);
  if (missing.length > 0) throw new ProvincialRegisterError(missing);
}
