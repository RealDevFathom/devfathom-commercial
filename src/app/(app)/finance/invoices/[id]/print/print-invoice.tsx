'use client';

import { Loader2, Printer, ArrowLeft, FileText } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { format } from 'date-fns';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { moneyLabel } from '@/lib/finance/currency';

// Line items are stored as Json on the invoice; this is their persisted shape.
type LineItem = { description: string; quantity: number; rate: number; amount: number };

const statusLabel: Record<string, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  PAID: 'Paid',
  OVERDUE: 'Overdue',
  CANCELLED: 'Cancelled',
};

/**
 * IMP-FIN-01: clean, print-styled single-invoice view. The "PDF" is the browser's
 * own print-to-PDF (window.print()) — no PDF library. A print stylesheet hides the
 * surrounding app shell so only the invoice paper prints.
 */
export function InvoicePrintView({ invoiceId }: { invoiceId: string }) {
  const { data: invoice, isLoading } = trpc.finance.getInvoiceById.useQuery({ id: invoiceId });

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <FileText className="h-10 w-10 text-muted-foreground/20" />
        <p className="mt-3 text-sm text-muted-foreground">Invoice not found.</p>
        <Link
          href="/finance"
          className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Finance
        </Link>
      </div>
    );
  }

  const items = (Array.isArray(invoice.items) ? invoice.items : []) as unknown as LineItem[];
  const currency = invoice.currency;
  const subtotal = Number(invoice.subtotal);
  const tax = Number(invoice.tax);
  const total = Number(invoice.total);
  const amountPaid = Number(invoice.amountPaid);
  const balance = Number(invoice.balance);
  const primaryContact = invoice.client.contacts?.[0];
  const issuer = invoice.issuer;

  return (
    <>
      {/* Print stylesheet: hide everything except the invoice paper, and reset its
          positioning so it prints flush at the top-left of the page. Scoped via the
          #invoice-print id so the app shell (sidebar/topbar) never appears on paper. */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #invoice-print, #invoice-print * { visibility: visible !important; }
          #invoice-print {
            position: absolute !important;
            inset: 0 !important;
            margin: 0 !important;
            padding: 24px !important;
            box-shadow: none !important;
            border: none !important;
          }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="mx-auto max-w-3xl space-y-4 animate-fade-in">
        {/* Toolbar — not printed */}
        <div className="no-print flex items-center justify-between">
          <Link
            href="/finance"
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Finance
          </Link>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-all hover:bg-primary-hover active:scale-[0.98]"
          >
            <Printer className="h-3.5 w-3.5" /> Print / Save as PDF
          </button>
        </div>

        {/* The invoice paper */}
        <div
          id="invoice-print"
          className="rounded-2xl border border-border/60 bg-white p-8 text-slate-900 shadow-sm sm:p-10"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-6 border-b border-slate-200 pb-6">
            <div data-testid="invoice-issuer" className="min-w-0 break-words">
              {issuer.logoUrl && (
                <Image
                  src={issuer.logoUrl}
                  alt=""
                  width={160}
                  height={48}
                  unoptimized
                  className="mb-3 h-12 w-auto max-w-[160px] object-contain"
                />
              )}
              <p className="font-display text-2xl font-bold tracking-tight text-[#0C2E2C]">
                {issuer.displayName}
              </p>
              {issuer.legalName !== issuer.displayName && (
                <p className="mt-1 text-xs text-slate-500">{issuer.legalName}</p>
              )}
              {issuer.address && (
                <p data-testid="invoice-issuer-address" className="mt-1 text-xs text-slate-600">
                  {issuer.address}
                </p>
              )}
              {issuer.taxId && (
                <p data-testid="invoice-issuer-tax-id" className="mt-1 text-xs text-slate-600">
                  Tax ID: {issuer.taxId}
                </p>
              )}
              {issuer.supportEmail && (
                <p className="mt-1 text-xs text-slate-500">{issuer.supportEmail}</p>
              )}
            </div>
            <div className="text-right">
              <p className="font-display text-xl font-bold tracking-tight text-slate-900">
                INVOICE
              </p>
              <p className="mt-1 font-mono text-sm text-slate-700">{invoice.invoiceNumber}</p>
              <span
                className={cn(
                  'mt-2 inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium',
                  invoice.status === 'PAID'
                    ? 'bg-emerald-100 text-emerald-700'
                    : invoice.status === 'OVERDUE'
                      ? 'bg-red-100 text-red-700'
                      : invoice.status === 'SENT'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-slate-100 text-slate-600'
                )}
              >
                {statusLabel[invoice.status] ?? invoice.status}
              </span>
            </div>
          </div>

          {/* Bill to + meta */}
          <div className="grid grid-cols-1 gap-6 py-6 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Bill to
              </p>
              <p className="mt-1.5 text-sm font-semibold text-slate-900">{invoice.client.name}</p>
              {primaryContact && (
                <p className="text-xs text-slate-500">
                  {primaryContact.name}
                  {primaryContact.email ? ` · ${primaryContact.email}` : ''}
                </p>
              )}
              {invoice.project && (
                <p className="mt-1 text-xs text-slate-500">Project: {invoice.project.name}</p>
              )}
            </div>
            <div className="sm:text-right">
              <div className="space-y-1 text-xs text-slate-600">
                <p>
                  <span className="text-slate-400">Issued: </span>
                  {format(new Date(invoice.createdAt), 'MMM d, yyyy')}
                </p>
                <p>
                  <span className="text-slate-400">Due: </span>
                  {format(new Date(invoice.dueDate), 'MMM d, yyyy')}
                </p>
                <p>
                  <span className="text-slate-400">Currency: </span>
                  {currency}
                </p>
              </div>
            </div>
          </div>

          {/* Line items */}
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                <th className="py-2 pr-2 font-semibold">Description</th>
                <th className="py-2 px-2 text-center font-semibold">Qty</th>
                <th className="py-2 px-2 text-right font-semibold">Rate</th>
                <th className="py-2 pl-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-2.5 pr-2 text-slate-800">{it.description}</td>
                  <td className="py-2.5 px-2 text-center tabular-nums text-slate-600">
                    {Number(it.quantity)}
                  </td>
                  <td className="py-2.5 px-2 text-right tabular-nums text-slate-600">
                    {moneyLabel(Number(it.rate), currency)}
                  </td>
                  <td className="py-2.5 pl-2 text-right font-medium tabular-nums text-slate-900">
                    {moneyLabel(Number(it.amount), currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals */}
          <div className="mt-6 flex justify-end">
            <div className="w-full max-w-xs space-y-1.5 text-sm">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal</span>
                <span className="tabular-nums">{moneyLabel(subtotal, currency)}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>Tax</span>
                <span className="tabular-nums">{moneyLabel(tax, currency)}</span>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-900">
                <span>Total</span>
                <span className="tabular-nums">{moneyLabel(total, currency)}</span>
              </div>
              {amountPaid > 0 && (
                <>
                  <div className="flex justify-between text-slate-600">
                    <span>Amount paid</span>
                    <span className="tabular-nums">{moneyLabel(amountPaid, currency)}</span>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-900">
                    <span>Balance due</span>
                    <span className="tabular-nums">{moneyLabel(balance, currency)}</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Notes */}
          {invoice.notes && (
            <div className="mt-8 border-t border-slate-200 pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Notes
              </p>
              <p className="mt-1.5 whitespace-pre-wrap text-xs text-slate-600">{invoice.notes}</p>
            </div>
          )}

          <p className="mt-8 text-center text-[11px] text-slate-400">
            Thank you for your business.
          </p>
        </div>
      </div>
    </>
  );
}
