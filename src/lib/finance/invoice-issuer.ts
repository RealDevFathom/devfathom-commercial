type InvoiceIssuerDatabase = {
  organization: {
    findUnique(args: {
      where: { id: string };
      select: {
        legalName: true;
        invoiceAddress: true;
        invoiceTaxId: true;
      };
    }): Promise<{
      legalName: string;
      invoiceAddress: string | null;
      invoiceTaxId: string | null;
    } | null>;
  };
};

export type InvoiceIssuer = {
  name: string;
  address: string | null;
  taxId: string | null;
};

/** The authenticated tenant is always the seller on its client invoices. */
export async function readInvoiceIssuer(
  db: InvoiceIssuerDatabase,
  organizationId: string
): Promise<InvoiceIssuer | null> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { legalName: true, invoiceAddress: true, invoiceTaxId: true },
  });

  return organization
    ? {
        name: organization.legalName,
        address: organization.invoiceAddress,
        taxId: organization.invoiceTaxId,
      }
    : null;
}
