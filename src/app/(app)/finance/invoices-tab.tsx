'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Plus, ChevronDown, X, Loader2 } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { moneyLabel } from '@/lib/finance/currency';
import { format } from 'date-fns';

type InvoiceStatus = 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED';

const INVOICE_STATUSES: InvoiceStatus[] = ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'];

const statusConfig: Record<string, { bg: string; label: string }> = {
  DRAFT: { bg: 'bg-muted text-muted-foreground', label: 'Draft' },
  SENT: { bg: 'bg-blue-500/10 text-blue-500', label: 'Sent' },
  PAID: { bg: 'bg-emerald-500/10 text-emerald-500', label: 'Paid' },
  OVERDUE: { bg: 'bg-red-500/10 text-red-500', label: 'Overdue' },
  CANCELLED: { bg: 'bg-muted text-muted-foreground line-through', label: 'Cancelled' },
};

type InvoiceRowData = {
  id: string;
  invoiceNumber: string;
  status: string;
  currency: string;
  total: unknown;
  dueDate: Date | string;
  client: { name: string };
  project: { name: string } | null;
};

export function InvoicesTab() {
  const utils = trpc.useUtils();
  const { data: invoices, isLoading } = trpc.finance.getInvoices.useQuery();
  const [showCreate, setShowCreate] = useState(false);

  const { mutate: mutateStatus } = trpc.finance.updateInvoiceStatus.useMutation({
    // Optimistically patch the list cache instead of refetching every invoice.
    onMutate: async ({ id, status }) => {
      await utils.finance.getInvoices.cancel();
      const previous = utils.finance.getInvoices.getData();
      utils.finance.getInvoices.setData(undefined, (old) =>
        old?.map((inv) => (inv.id === id ? { ...inv, status } : inv))
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        utils.finance.getInvoices.setData(undefined, ctx.previous);
      }
    },
    onSettled: () => {
      utils.finance.getFinancialSummary.invalidate();
    },
  });

  const handleUpdateStatus = useCallback(
    (id: string, status: InvoiceStatus) => mutateStatus({ id, status }),
    [mutateStatus]
  );

  // Virtualize against the app's scrollable <main> ancestor so the list can grow
  // without rendering every row (and without a nested scroll container that would
  // clip the per-row status menu).
  const listRef = useRef<HTMLDivElement>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useEffect(() => {
    const measure = () => {
      const scrollEl = listRef.current?.closest('main') as HTMLElement | null;
      scrollElRef.current = scrollEl;
      if (scrollEl && listRef.current) {
        setScrollMargin(
          listRef.current.getBoundingClientRect().top -
            scrollEl.getBoundingClientRect().top +
            scrollEl.scrollTop
        );
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [isLoading, showCreate, invoices?.length]);

  // React Compiler intentionally leaves TanStack Virtual in manual mode.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: invoices?.length ?? 0,
    getScrollElement: () => scrollElRef.current,
    estimateSize: () => 65,
    overscan: 8,
    scrollMargin,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{invoices?.length ?? 0} invoices</p>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
        >
          <Plus className="h-3.5 w-3.5" />
          New Invoice
        </button>
      </div>

      {showCreate && <CreateInvoiceForm onClose={() => setShowCreate(false)} />}

      <Card className="border-border/60">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : !invoices?.length ? (
            <div className="py-16 text-center">
              <FileText className="mx-auto h-10 w-10 text-muted-foreground/20" />
              <p className="mt-3 text-sm text-muted-foreground">No invoices yet</p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {/* Header */}
              <div className="grid grid-cols-12 gap-4 px-6 py-3 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                <div className="col-span-2">Invoice</div>
                <div className="col-span-3">Client</div>
                <div className="col-span-2">Project</div>
                <div className="col-span-1 text-right">Amount</div>
                <div className="col-span-2 text-center">Status</div>
                <div className="col-span-2 text-right">Due Date</div>
              </div>
              {/* Virtualized rows */}
              <div
                ref={listRef}
                className="relative"
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
              >
                {rowVirtualizer.getVirtualItems().map((vi) => {
                  const inv = invoices[vi.index];
                  return (
                    <div
                      key={inv.id}
                      data-index={vi.index}
                      ref={rowVirtualizer.measureElement}
                      className="absolute left-0 top-0 w-full"
                      style={{ transform: `translateY(${vi.start - scrollMargin}px)` }}
                    >
                      <InvoiceRow inv={inv} onUpdateStatus={handleUpdateStatus} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ============================================
   Invoice Row (memoized; owns its own status-menu open state)
   ============================================ */
const InvoiceRow = memo(function InvoiceRow({
  inv,
  onUpdateStatus,
}: {
  inv: InvoiceRowData;
  onUpdateStatus: (id: string, status: InvoiceStatus) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const config = statusConfig[inv.status] || statusConfig.DRAFT;

  // Anchor the menu to the button's viewport rect and render it in a portal, so it
  // escapes the virtualizer's per-row transform stacking contexts (which otherwise
  // let sibling rows paint over it) and the Card's `overflow-hidden`.
  const openMenu = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const MENU_HEIGHT = 160; // ~5 status rows
    const below = rect.bottom + 4;
    const openUp = below + MENU_HEIGHT > window.innerHeight;
    setMenuPos({
      top: openUp ? rect.top - MENU_HEIGHT - 4 : below,
      left: rect.left + rect.width / 2,
    });
    setMenuOpen(true);
  }, []);

  // The menu is viewport-fixed, so dismiss it when the page scrolls or resizes
  // rather than letting it detach from the button.
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menuOpen]);

  return (
    <div className="grid grid-cols-12 gap-4 items-center px-6 py-3.5 border-b border-border/60 bg-card hover:bg-secondary/30 transition-colors">
      <div className="col-span-2">
        <p className="text-sm font-semibold text-foreground font-mono">{inv.invoiceNumber}</p>
      </div>
      <div className="col-span-3">
        <p className="text-sm text-foreground truncate">{inv.client.name}</p>
      </div>
      <div className="col-span-2">
        <p className="text-sm text-muted-foreground truncate">{inv.project?.name || '—'}</p>
      </div>
      <div className="col-span-1 text-right">
        <p className="text-sm font-semibold text-foreground tabular-nums">
          {moneyLabel(Number(inv.total), inv.currency)}
        </p>
      </div>
      <div className="col-span-2 flex justify-center">
        <button
          ref={btnRef}
          onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium',
            config.bg
          )}
        >
          {config.label}
          <ChevronDown className="h-3 w-3" />
        </button>
        {menuOpen &&
          menuPos &&
          createPortal(
            <>
              <div className="fixed inset-0 z-[60]" onClick={() => setMenuOpen(false)} />
              <div
                className="fixed z-[61] w-32 -translate-x-1/2 rounded-xl border border-border bg-card py-1 shadow-xl shadow-black/10"
                style={{ top: menuPos.top, left: menuPos.left }}
              >
                {INVOICE_STATUSES.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      onUpdateStatus(inv.id, s);
                      setMenuOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-secondary',
                      inv.status === s && 'bg-secondary font-medium'
                    )}
                  >
                    <div
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        s === 'PAID'
                          ? 'bg-emerald-500'
                          : s === 'OVERDUE'
                            ? 'bg-red-500'
                            : s === 'SENT'
                              ? 'bg-blue-500'
                              : 'bg-muted-foreground'
                      )}
                    />
                    {statusConfig[s].label}
                  </button>
                ))}
              </div>
            </>,
            document.body
          )}
      </div>
      <div className="col-span-2 text-right">
        <p
          className={cn(
            'text-sm tabular-nums',
            inv.status === 'OVERDUE' ? 'text-red-500 font-medium' : 'text-muted-foreground'
          )}
        >
          {format(new Date(inv.dueDate), 'MMM d, yyyy')}
        </p>
      </div>
    </div>
  );
});

/* ============================================
   Create Invoice Form
   ============================================ */
export function CreateInvoiceForm({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const { data: clients } = trpc.clients.getAll.useQuery();
  const { data: projects } = trpc.projects.getAll.useQuery();

  const createInvoice = trpc.finance.createInvoice.useMutation({
    onSuccess: () => {
      utils.finance.getInvoices.invalidate();
      onClose();
    },
  });

  const [clientId, setClientId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState([{ description: '', quantity: 1, rate: 0 }]);

  const addItem = () => setItems([...items, { description: '', quantity: 1, rate: 0 }]);
  const removeItem = (i: number) => setItems(items.filter((_, idx) => idx !== i));
  const updateItem = (i: number, field: string, value: string | number) => {
    const updated = [...items];
    updated[i] = { ...updated[i], [field]: value };
    setItems(updated);
  };

  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.rate, 0);
  const total = subtotal;

  const handleSubmit = () => {
    if (!clientId || !dueDate || items.length === 0 || items.some((i) => !i.description)) return;
    createInvoice.mutate({
      clientId,
      projectId: projectId || undefined,
      items: items.map((i) => ({ ...i, amount: i.quantity * i.rate })),
      subtotal,
      tax: 0,
      total,
      dueDate: new Date(dueDate),
      notes: notes || undefined,
    });
  };

  return (
    <Card className="border-primary/20">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">New Invoice</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Client *</label>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              <option value="">Select...</option>
              {clients?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Project</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              <option value="">None</option>
              {projects?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Due Date *</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </div>
        </div>

        {/* Line items */}
        <div>
          <label className="block text-xs font-medium text-foreground mb-2">Line Items</label>
          <div className="space-y-2">
            {items.map((item, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center">
                <input
                  value={item.description}
                  onChange={(e) => updateItem(i, 'description', e.target.value)}
                  placeholder="Description"
                  className="col-span-5 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                />
                <input
                  type="number"
                  value={item.quantity}
                  onChange={(e) => updateItem(i, 'quantity', parseInt(e.target.value) || 0)}
                  placeholder="Qty"
                  className="col-span-2 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground text-center focus:border-primary focus:outline-none"
                />
                <input
                  type="number"
                  step="0.01"
                  value={item.rate || ''}
                  onChange={(e) => updateItem(i, 'rate', parseFloat(e.target.value) || 0)}
                  placeholder="Rate"
                  className="col-span-2 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground text-right focus:border-primary focus:outline-none"
                />
                <span className="col-span-2 text-sm font-medium text-foreground text-right tabular-nums">
                  ${(item.quantity * item.rate).toLocaleString()}
                </span>
                <button
                  onClick={() => removeItem(i)}
                  disabled={items.length === 1}
                  aria-label="Remove line item"
                  title={
                    items.length === 1
                      ? 'An invoice needs at least one line item'
                      : 'Remove line item'
                  }
                  className="col-span-1 flex justify-center text-muted-foreground hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-muted-foreground"
                >
                  <X className="h-3.5 w-3.5" />
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

        {/* Total */}
        <div className="flex justify-end border-t border-border/60 pt-3">
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="font-display text-xl font-bold text-foreground">
              ${total.toLocaleString()}
            </p>
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">Notes</label>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Payment terms, notes..."
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!clientId || !dueDate || items.length === 0 || createInvoice.isPending}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
          >
            {createInvoice.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Creating...
              </>
            ) : (
              'Create Invoice'
            )}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
