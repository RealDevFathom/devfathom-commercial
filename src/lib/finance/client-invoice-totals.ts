import { sumByCurrency, type CurrencyAmount } from './currency';

type ClientInvoice = {
  status: string;
  currency: string;
  total: number | string | { toString(): string };
};

export function clientInvoiceTotals(invoices: ClientInvoice[]): {
  revenue: CurrencyAmount[];
  outstanding: CurrencyAmount[];
} {
  const revenue: CurrencyAmount[] = [];
  const outstanding: CurrencyAmount[] = [];

  for (const invoice of invoices) {
    const amount = { currency: invoice.currency, amount: Number(invoice.total) };
    if (invoice.status === 'PAID') revenue.push(amount);
    if (invoice.status === 'SENT' || invoice.status === 'OVERDUE') outstanding.push(amount);
  }

  return {
    revenue: sumByCurrency(revenue),
    outstanding: sumByCurrency(outstanding),
  };
}
