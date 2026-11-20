'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import {
  batchNumberLabel,
  EXPIRY_NOT_RECORDED,
  batchPhrase,
} from '@/lib/pharmacy/unrecorded-batch';
import {
  MAX_SHELF_LABELS_PER_PRINT,
  printShelfLabels,
  SHELF_LABEL_FORMATS,
  shelfLabelTotal,
  type ShelfLabelFormat,
  type ShelfLabelRow,
} from '@/lib/pharmacy/shelf-label';

/**
 * DEV-90 — choose how many shelf and price stickers to print per lot, and the
 * paper. Every price, expiry and lot code is the server's; only the count and
 * the paper are the operator's.
 */

const selectClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

const rupees = (minor: number) => `Rs ${formatMinor(minor)}`;

function countFrom(text: string): number | null {
  if (!/^\d{1,4}$/.test(text.trim())) return null;
  return Number(text.trim());
}

export function ShelfLabelPrintPanel({
  title,
  rows,
}: {
  title: string;
  rows: readonly ShelfLabelRow[];
}) {
  const [format, setFormat] = useState<ShelfLabelFormat>('38x25');
  const [counts, setCounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      rows.map((row) => [
        row.inventoryLotId,
        row.unavailableReason ? '0' : String(row.defaultCount),
      ])
    )
  );
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const selection = rows.map((row) => ({
    row,
    count: countFrom(counts[row.inventoryLotId] ?? '') ?? 0,
  }));
  const invalid = rows.some((row) => countFrom(counts[row.inventoryLotId] ?? '') === null);
  const total = shelfLabelTotal(selection);
  const tooMany = total > MAX_SHELF_LABELS_PER_PRINT;

  async function print() {
    setMessage(null);
    try {
      await printShelfLabels(selection, format);
      setMessage({
        tone: 'success',
        text: `${total} label${total === 1 ? '' : 's'} sent to the print dialog.`,
      });
    } catch (error) {
      setMessage({
        tone: 'danger',
        text: error instanceof Error ? error.message : 'The labels could not be printed.',
      });
    }
  }

  if (rows.length === 0) {
    return (
      <SectionCard title={title}>
        <p className="rounded-[var(--radius-sm)] bg-surface-sunken p-5 text-sm text-text-muted">
          No lot with stock on hand in this branch matches. Search for another medicine, or open a
          posted goods receipt.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title={title}
      actions={
        <span className="font-mono text-xs text-text-muted tabular-nums">
          {total} label{total === 1 ? '' : 's'}
        </span>
      }
    >
      <div className="max-w-full overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Medicine</TableHead>
              <TableHead>Batch · expiry</TableHead>
              <TableHead className="text-right">MRP / pack</TableHead>
              <TableHead className="text-right">MRP / strip</TableHead>
              <TableHead>Lot code</TableHead>
              <TableHead className="text-right">Labels</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const value = counts[row.inventoryLotId] ?? '';
              const bad = countFrom(value) === null;
              const id = `shelf-label-count-${row.inventoryLotId}`;
              return (
                <TableRow key={row.inventoryLotId}>
                  <TableCell>
                    <div className="font-medium text-text-strong">{row.name}</div>
                    <div className="text-xs text-text-muted">{row.strength ?? '—'}</div>
                    {row.unavailableReason ? (
                      <div className="mt-1 space-y-1">
                        <StatusPill status="blocked" label="Not for sale" />
                        <p className="text-xs text-text-muted">{row.unavailableReason}</p>
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {batchNumberLabel(row.batchNumber)}
                    <div className="text-text-muted">
                      {row.expiry === null ? EXPIRY_NOT_RECORDED : `EXP ${row.expiry}`}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {rupees(row.packMrpMinor)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.stripMrpMinor === null ? '—' : rupees(row.stripMrpMinor)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.code}</TableCell>
                  <TableCell className="text-right">
                    <label className="sr-only" htmlFor={id}>
                      Labels for {row.name} {batchPhrase(row.batchNumber, 'batch')}
                    </label>
                    <Input
                      id={id}
                      className="ml-auto min-h-11 w-20 text-right tabular-nums"
                      inputMode="numeric"
                      value={value}
                      disabled={Boolean(row.unavailableReason)}
                      aria-invalid={bad || undefined}
                      onChange={(event) =>
                        setCounts((current) => ({
                          ...current,
                          [row.inventoryLotId]: event.target.value,
                        }))
                      }
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-5">
        <label className="min-w-64 text-sm font-medium text-text-strong">
          Label size
          <select
            className={selectClass}
            value={format}
            onChange={(event) => setFormat(event.target.value as ShelfLabelFormat)}
          >
            {SHELF_LABEL_FORMATS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          size="touch"
          className="px-4"
          disabled={invalid || total < 1 || tooMany}
          onClick={print}
        >
          Print {total} label{total === 1 ? '' : 's'}
        </Button>
      </div>
      <p className="mt-2 text-xs text-text-muted" role={invalid || tooMany ? 'alert' : undefined}>
        {invalid
          ? 'Each label count must be a whole number.'
          : tooMany
            ? `Print at most ${MAX_SHELF_LABELS_PER_PRINT} labels at a time; lower some counts.`
            : 'Each label shows the medicine, strength, MRP per pack and strip, expiry, and a lot code the counter scans to sell that batch.'}
      </p>
      {message ? (
        <p
          className={`mt-2 text-sm ${message.tone === 'danger' ? 'text-destructive' : 'text-success'}`}
          role={message.tone === 'danger' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      ) : null}
    </SectionCard>
  );
}
