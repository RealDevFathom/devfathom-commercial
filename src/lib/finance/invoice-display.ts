import { moneyLabel } from './currency';

export type InvoiceTotal = {
  currency: string;
  total: unknown;
};

/** Format an invoice total in the currency carried by that invoice. */
export function invoiceTotalLabel(invoice: InvoiceTotal): string {
  return moneyLabel(Number(invoice.total), invoice.currency);
}
