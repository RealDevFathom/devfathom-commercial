/**
 * #458 / DEV-243: the seller printed on an agency's client invoice is the
 * agency itself — its legal name and the invoice address / tax ID it keeps on
 * its workspace profile — never the DevFathom platform brand.
 *
 * Callers pass their tenant-scoped (row-level-security) client and the
 * workspace id they already authenticated, so the read is filtered both by the
 * explicit predicate and by the `organization_isolation` policy. The invoice id
 * in a URL (the emailed print link carries only that) never selects whose
 * identity is printed.
 */

type IssuerRow = {
  legalName: string;
  displayName: string;
  invoiceAddress: string | null;
  invoiceTaxId: string | null;
};

const ISSUER_SELECT = {
  legalName: true,
  displayName: true,
  invoiceAddress: true,
  invoiceTaxId: true,
} as const;

export type InvoiceIssuerDb = {
  organization: {
    findUnique(args: {
      where: { id: string };
      select: typeof ISSUER_SELECT;
    }): Promise<IssuerRow | null>;
  };
};

export type InvoiceIssuer = {
  /** Legal name, falling back to the display name if the legal name is blank. */
  name: string;
  /** Multi-line postal address, or null when the workspace has not set one. */
  address: string | null;
  /** Tax / VAT / NTN registration, or null when the workspace has not set one. */
  taxId: string | null;
};

const present = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** Shape a workspace row into the issuer block; blank optional fields become null. */
export function toInvoiceIssuer(row: IssuerRow | null): InvoiceIssuer | null {
  if (!row) return null;
  const name = present(row.legalName) ?? present(row.displayName);
  if (!name) return null;
  return { name, address: present(row.invoiceAddress), taxId: present(row.invoiceTaxId) };
}

/** Read the invoice seller identity for the authenticated workspace. */
export async function readInvoiceIssuer(
  db: InvoiceIssuerDb,
  organizationId: string
): Promise<InvoiceIssuer | null> {
  const row = await db.organization.findUnique({
    where: { id: organizationId },
    select: ISSUER_SELECT,
  });
  return toInvoiceIssuer(row);
}
