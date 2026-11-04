/**
 * DEV-753 — the owner switch for supplier compliance checks: shared, client-safe facts.
 *
 * The switch is bounded to two PUR-01 checks: supplier licence evidence and supplier
 * trade authorization. Turning it off changes what this software asks for and refuses.
 * It does not change the law, supplier records, licence evidence, or anyone's
 * permissions. The server module (`supplier-compliance-policy.ts`) owns the decision;
 * this file holds the words both sides must agree on.
 */

/**
 * The warning the owner acknowledges before turning the checks off. The version is
 * stored with the acknowledgement, so changing any of this text needs a new version.
 */
export const SUPPLIER_COMPLIANCE_WARNING = Object.freeze({
  version: 'supplier-compliance-off@1',
  title: 'Turn off supplier licence and authorization checks?',
  paragraphs: Object.freeze([
    'This only stops the app from asking for supplier licence evidence and supplier trade authorization, and from refusing purchase orders and goods receipts when they are missing.',
    'It does not remove any legal obligation to buy medicines only from licensed suppliers. As the pharmacy owner, you remain responsible for where your stock comes from and for your pharmacy’s compliance.',
    'Everything else is still checked: approvals and PINs, batch, expiry and stock checks, invoice and accounting records, branch access, and controlled-medicine rules. Licences already on file stay on file and are not changed.',
  ]),
  acknowledgement:
    'I understand that turning off these checks does not remove supplier-licensing obligations, and that I remain responsible for sourcing and compliance.',
});

/** What is stored as the acknowledgement: the warning version and the exact sentence agreed to. */
export function supplierComplianceAcknowledgementRecord(): string {
  return `${SUPPLIER_COMPLIANCE_WARNING.version}: ${SUPPLIER_COMPLIANCE_WARNING.acknowledgement}`;
}

/** The writes that consult the policy and leave evidence when the checks are off. */
export const SUPPLIER_COMPLIANCE_OPERATIONS = [
  'PURCHASE_ORDER_CREATE',
  'PURCHASE_ORDER_APPROVE',
  'PURCHASE_ORDER_SEND',
  'GOODS_RECEIPT_CREATE',
  'GOODS_RECEIPT_POST',
  'CENTRAL_PURCHASE_ORDER_CREATE',
] as const;
export type SupplierComplianceOperation = (typeof SUPPLIER_COMPLIANCE_OPERATIONS)[number];

/**
 * The policy as the purchasing screens show it. `source` separates a stored owner
 * decision from the built-in default and from a read failure that was enforced.
 */
export type SupplierCompliancePolicyView = {
  checksEnabled: boolean;
  version: number;
  source: 'DEFAULT' | 'STORED' | 'FAIL_CLOSED';
  updatedAt: Date | null;
  updatedByName: string | null;
};

/**
 * The status words for a supplier's PUR-01 standing. Policy status (checked or not) is
 * kept apart from evidence status (what is on file): with the checks off a supplier is
 * "Not checked", never "Verified", "Licensed" or "Authorized" on the policy's account.
 */
export const SUPPLIER_CHECKS_DISABLED_LABEL = 'Checks disabled';
export const SUPPLIER_NOT_CHECKED_LABEL = 'Not checked';
