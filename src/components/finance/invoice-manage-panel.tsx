'use client';

import { InvoiceAdjustments } from '@/components/finance/invoice-adjustments';
import { invoiceTotals, invoiceTotalsError } from '@/lib/finance/invoice-totals';
import { MAX_MONEY, multiplyMoney } from '@/lib/finance/money';

import { memo, useCallback, useMemo, useState } from 'react';
import {
  Pencil,
  Plus,
  Trash2,
  Loader2,
  ChevronDown,
  Mail,
  Printer,
  CheckCircle2,
  FileText,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { moneyLabel } from '@/lib/finance/currency';

type LineItem = { description: string; quantity: number; rate: number; amount: number };

// getInvoices ships every scalar field (items/tax/notes/dueDate) plus relations and
// the computed amountPaid/balance. Money fields cross the wire as Decimal → coerced
// with Number(), matching the other finance views.
type ManageInvoice = {
  id: string;
  invoiceNumber: string;
  status: string;
  currency: string;
  total: unknown;
  tax: unknown;
  discount: unknown;
  dueDate: Date | string;
  notes: string | null;
  items: unknown;
  client: { name: string };
  project: { name: string } | null;
};

/**
 * IMP-FIN-01: edit an unsettled invoice (line items / tax / due date / notes) and
 * email it to the client. Only DRAFT and SENT invoices are editable — a settled or
 * void invoice is omitted. Self-contained, mounted in the Finance → Invoices tab.
 */
export function InvoiceManagePanel() {
  const { data: invoices, isLoading } = trpc.finance.getInvoices.useQuery();

  const editable = useMemo(
    () => (invoices ?? []).filter((inv) => inv.status === 'DRAFT' || inv.status === 'SENT'),
    [invoices]
  );

  return (
    <Card className="border-border/60">
      <CardContent className="p-0">
        <div className="flex items-center gap-2.5 border-b border-border/60 px-6 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
            <Pencil className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Edit &amp; send invoices</h3>
            <p className="text-xs text-muted-foreground">
              Adjust line items, email the invoice to the client, or print a PDF.
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-3 p-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : editable.length === 0 ? (
          <div className="py-14 text-center">
            <FileText className="mx-auto h-10 w-10 text-muted-foreground/20" />
            <p className="mt-3 text-sm text-muted-foreground">No editable invoices</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Draft and sent invoices can be edited here.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {editable.map((inv) => (
              <InvoiceManageRow key={inv.id} inv={inv as ManageInvoice} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const InvoiceManageRow = memo(function InvoiceManageRow({ inv }: { inv: ManageInvoice }) {
  const utils = trpc.useUtils();
  const [expanded, setExpanded] = useState(false);
  const isDraft = inv.status === 'DRAFT';

  const invalidate = useCallback(() => {
    utils.finance.getInvoices.invalidate();
    utils.finance.getFinancialSummary.invalidate();
  }, [utils]);

  // Email send + feedback.
  const [emailMsg, setEmailMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const sendEmail = trpc.finance.sendInvoiceEmail.useMutation({
    onSuccess: (r) => {
      invalidate();
      setEmailMsg({ ok: true, text: `Sent to ${r.sentTo}.` });
    },
    onError: (e) => setEmailMsg({ ok: false, text: e.message }),
  });

  return (
    <div className={cn('bg-card transition-colors', expanded && 'bg-secondary/20')}>
      <div className="flex items-center gap-3 px-6 py-3.5">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-180'
            )}
          />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-sm font-semibold text-foreground">{inv.invoiceNumber}</p>
            <p className="truncate text-xs text-muted-foreground">
              {inv.client.name}
              {inv.project ? ` · ${inv.project.name}` : ''}
            </p>
          </div>
        </button>
        <span
          className={cn(
            'hidden shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium sm:inline-flex',
            isDraft ? 'bg-muted text-muted-foreground' : 'bg-blue-500/10 text-blue-500'
          )}
        >
          {isDraft ? 'Draft' : 'Sent'}
        </span>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
          {moneyLabel(Number(inv.total), inv.currency)}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <a
            href={`/finance/invoices/${inv.id}/print`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open print / PDF view"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Printer className="h-4 w-4" />
          </a>
          <button
            onClick={() => sendEmail.mutate({ id: inv.id })}
            disabled={sendEmail.isPending}
            title="Email this invoice to the client"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            {sendEmail.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Mail className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {emailMsg && (
        <p
          className={cn(
            'flex items-center gap-1.5 px-6 pb-2.5 text-xs',
            emailMsg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'
          )}
        >
          {emailMsg.ok && <CheckCircle2 className="h-3.5 w-3.5" />}
          {emailMsg.text}
        </p>
      )}

      {expanded && (
        <InvoiceEditForm
          inv={inv}
          onSaved={() => {
            invalidate();
            setExpanded(false);
          }}
        />
      )}
    </div>
  );
});

function InvoiceEditForm({ inv, onSaved }: { inv: ManageInvoice; onSaved: () => void }) {
  const initialItems = useMemo<{ description: string; quantity: number; rate: number }[]>(() => {
    const raw = (Array.isArray(inv.items) ? inv.items : []) as unknown as LineItem[];
    return raw.length
      ? raw.map((it) => ({
          description: it.description ?? '',
          quantity: Number(it.quantity) || 0,
          rate: Number(it.rate) || 0,
        }))
      : [{ description: '', quantity: 1, rate: 0 }];
  }, [inv.items]);

  const [items, setItems] = useState(initialItems);
  const [tax, setTax] = useState(String(Number(inv.tax) || 0));
  const [discount, setDiscount] = useState(String(Number(inv.discount) || 0));
  const [dueDate, setDueDate] = useState(format(new Date(inv.dueDate), 'yyyy-MM-dd'));
  const [notes, setNotes] = useState(inv.notes ?? '');

  const updateInvoice = trpc.finance.updateInvoice.useMutation({ onSuccess: onSaved });

  const addItem = () => setItems((cur) => [...cur, { description: '', quantity: 1, rate: 0 }]);
  const removeItem = (i: number) => setItems((cur) => cur.filter((_, idx) => idx !== i));
  const updateItem = (
    i: number,
    field: 'description' | 'quantity' | 'rate',
    value: string | number
  ) => setItems((cur) => cur.map((it, idx) => (idx === i ? { ...it, [field]: value } : it)));

  const amounts = items.map((item) => multiplyMoney(item.quantity, item.rate));
  const totals = invoiceTotals(amounts, Number(tax), Number(discount));
  const { subtotal, total, tax: taxNum, discount: discountNum } = totals;
  const adjustmentError =
    Number(tax) < 0 ||
    Number(discount) < 0 ||
    Number(tax) > MAX_MONEY ||
    Number(discount) > MAX_MONEY
      ? 'Tax and discount must be between 0 and 9,999,999,999.99'
      : invoiceTotalsError(totals);

  const hasValidItems =
    items.length > 0 &&
    items.every((it) => it.description.trim() && it.quantity > 0 && it.rate > 0);
  const canSave = hasValidItems && !adjustmentError && !!dueDate && !updateInvoice.isPending;

  const submit = () => {
    if (!canSave) return;
    updateInvoice.mutate({
      id: inv.id,
      items: items.map((it) => ({
        description: it.description.trim(),
        quantity: it.quantity,
        rate: it.rate,
      })),
      tax: taxNum,
      discount: discountNum,
      dueDate: new Date(dueDate),
      notes: notes.trim() || undefined,
    });
  };

  return (
    <div className="space-y-4 border-t border-border/60 px-6 py-4">
      {/* Line items */}
      <div>
        <label className="mb-2 block text-xs font-medium text-foreground">Line items</label>
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className="grid grid-cols-12 items-center gap-2">
              <input
                value={item.description}
                onChange={(e) => updateItem(i, 'description', e.target.value)}
                placeholder="Description"
                className="col-span-12 sm:col-span-5 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
              <input
                type="number"
                min="0"
                step="1"
                value={item.quantity}
                onChange={(e) => updateItem(i, 'quantity', parseFloat(e.target.value) || 0)}
                placeholder="Qty"
                className="col-span-3 sm:col-span-2 rounded-lg border border-border bg-background px-3 py-1.5 text-center text-sm text-foreground focus:border-primary focus:outline-none"
              />
              <input
                type="number"
                step="0.01"
                min="0"
                value={item.rate || ''}
                onChange={(e) => updateItem(i, 'rate', parseFloat(e.target.value) || 0)}
                placeholder="Rate"
                className="col-span-4 sm:col-span-2 rounded-lg border border-border bg-background px-3 py-1.5 text-right text-sm text-foreground focus:border-primary focus:outline-none"
              />
              <span className="col-span-3 sm:col-span-2 text-right text-sm font-medium tabular-nums text-foreground">
                {moneyLabel(amounts[i], inv.currency)}
              </span>
              <button
                onClick={() => removeItem(i)}
                disabled={items.length === 1}
                className="col-span-2 sm:col-span-1 flex justify-center text-muted-foreground transition-colors hover:text-red-500 disabled:opacity-30"
                title="Remove line"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={addItem}
          className="mt-2 flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          <Plus className="h-3 w-3" /> Add line item
        </button>
      </div>

      <InvoiceAdjustments
        tax={tax}
        discount={discount}
        currency={inv.currency}
        onTaxChange={setTax}
        onDiscountChange={setDiscount}
        error={adjustmentError}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-foreground">Due date *</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </div>

      {/* Notes */}
      <div>
        <label className="mb-1 block text-xs font-medium text-foreground">Notes</label>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Payment terms, notes..."
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {/* Totals preview */}
      <div className="flex justify-end border-t border-border/60 pt-3">
        <div className="w-full max-w-[220px] space-y-1 text-sm">
          <div className="flex justify-between text-muted-foreground">
            <span>Subtotal</span>
            <span className="tabular-nums">{moneyLabel(subtotal, inv.currency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>Discount</span>
            <span className="tabular-nums">{moneyLabel(-discountNum, inv.currency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>Tax</span>
            <span className="tabular-nums">{moneyLabel(taxNum, inv.currency)}</span>
          </div>
          <div className="flex justify-between border-t border-border/60 pt-1 font-semibold text-foreground">
            <span>Total</span>
            <span className="tabular-nums">{moneyLabel(total, inv.currency)}</span>
          </div>
        </div>
      </div>

      {updateInvoice.error && <p className="text-xs text-red-500">{updateInvoice.error.message}</p>}

      <div className="flex justify-end gap-2">
        <button
          onClick={submit}
          disabled={!canSave}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-40"
        >
          {updateInvoice.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...
            </>
          ) : (
            'Save changes'
          )}
        </button>
      </div>
    </div>
  );
}
