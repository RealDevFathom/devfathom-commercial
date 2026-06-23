import type { Metadata } from 'next';
import { InvoicePrintView } from './print-invoice';

export const metadata: Metadata = {
  title: 'Invoice',
};

// IMP-FIN-01: print/PDF view for a single invoice. Server page resolves the route
// param (Next 16 — params is a Promise) and hands the id to a client view that
// fetches the invoice via tRPC and offers a browser print-to-PDF.
export default async function InvoicePrintPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return <InvoicePrintView invoiceId={id} />;
}
