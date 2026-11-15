'use client';

import { useId, type Ref } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { SaleLinePreview, SaleUnitKind, SaleUnitOption } from '@/lib/pharmacy/counter-pricing';

export type CounterUnitToggleProps = {
  options: readonly SaleUnitOption[];
  /** Safe stock available in the selected branch, supplied by the catalog row. */
  onHandUnits: number;
  selected: SaleUnitKind | null;
  quantity: string;
  preview: SaleLinePreview | null;
  disabled?: boolean;
  /** Compact inline next-line composition, with the same pricing and keyboard controls. */
  inline?: boolean;
  onSelect: (kind: SaleUnitKind) => void;
  onQuantityChange: (quantity: string) => void;
  /** Enter in the quantity field adds the line, as the add shortcut does. */
  onSubmit?: () => void;
  /** Lets the console move focus here when Enter finds no quantity yet. */
  quantityRef?: Ref<HTMLInputElement>;
  /** Rendered beside each unit so the operator sees the chord, not a tooltip. */
  chordFor?: (kind: SaleUnitKind) => string | null;
};

const KIND_LABEL: Record<SaleUnitKind, string> = {
  PACK: 'Pack',
  STRIP: 'Strip',
  UNIT: 'Unit',
};

/**
 * POS-03 — the pack/strip/unit toggle with an exact quantity and price preview.
 *
 * A real radio group, not a set of buttons: arrow keys move between units, the
 * selected unit is announced, and the whole control is reachable without a
 * pointer (POS-01). The console additionally binds F3/F4/F5 straight to
 * `onSelect`, so a cashier never has to tab here at all.
 *
 * The preview is passed in rather than computed: it comes from
 * `previewSaleLine`, the same derivation the server applies, so this component
 * can never quote a price the sale would refuse.
 */
export function CounterUnitToggle({
  options,
  onHandUnits,
  selected,
  quantity,
  preview,
  disabled = false,
  inline = false,
  onSelect,
  onQuantityChange,
  onSubmit,
  quantityRef,
  chordFor,
}: CounterUnitToggleProps) {
  const quantityId = useId();
  const parsedQuantity = Number(quantity);
  const validQuantity =
    /^\d+$/.test(quantity) && Number.isSafeInteger(parsedQuantity) && parsedQuantity > 0;
  const quantityMessage = validQuantity
    ? null
    : !quantity || parsedQuantity === 0
      ? 'Enter a quantity'
      : 'Enter a whole number';

  if (options.length === 0) {
    return (
      <p className="text-sm text-text-muted" role="status">
        {onHandUnits === 0
          ? 'Out of stock at this branch. Capture as unfulfilled demand or receive stock before selling.'
          : 'No sale unit is available for this medicine. Its pack hierarchy does not match the received lot, so no price can be derived.'}
      </p>
    );
  }

  return (
    <div className={inline ? 'grid items-end gap-3 sm:grid-cols-[auto_auto_1fr]' : 'space-y-2'}>
      <div className="space-y-1">
        {inline ? (
          <span className="block text-xs font-semibold text-text-strong">Sale unit</span>
        ) : null}
        <div
          role="radiogroup"
          aria-label="Sale unit"
          aria-disabled={disabled || undefined}
          className="flex flex-wrap gap-2"
        >
          {options.map((option) => {
            const active = option.kind === selected;
            const chord = chordFor?.(option.kind) ?? null;
            return (
              <button
                key={`${option.kind}:${option.packLevelId}`}
                type="button"
                role="radio"
                aria-checked={active}
                // Only the selected unit is in the tab order; arrow keys move
                // within the group. This is the standard radio-group pattern and
                // keeps one Tab stop per control on a keyboard-only counter.
                tabIndex={active || (selected === null && option === options[0]) ? 0 : -1}
                disabled={disabled}
                onClick={() => onSelect(option.kind)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                  event.preventDefault();
                  const index = options.findIndex((entry) => entry.kind === option.kind);
                  const next =
                    event.key === 'ArrowRight'
                      ? options[(index + 1) % options.length]!
                      : options[(index - 1 + options.length) % options.length]!;
                  onSelect(next.kind);
                }}
                className={`flex min-h-11 min-w-0 flex-col items-start gap-0.5 rounded-md border px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 ${
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border-subtle bg-surface-card text-text-strong hover:bg-surface-sunken'
                }`}
              >
                <span className="text-sm font-semibold">
                  {KIND_LABEL[option.kind]}
                  {option.levelLabel && option.levelLabel !== option.kind ? (
                    <span className="ml-1 font-normal opacity-80">({option.levelLabel})</span>
                  ) : null}
                </span>
                <span
                  className={`font-mono text-[0.625rem] tracking-wide ${active ? 'text-primary-foreground' : 'text-text-muted'}`}
                >
                  {option.canonicalUnitsPerSaleUnit} units{chord ? ` · ${chord}` : ''}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={quantityId}>Quantity</Label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Decrease quantity"
            disabled={disabled || !validQuantity || parsedQuantity <= 1}
            onClick={() => onQuantityChange(String(Math.max(1, parsedQuantity - 1)))}
            className="inline-flex size-11 items-center justify-center rounded-md border border-border-subtle bg-surface-card text-sm text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            −
          </button>
          <Input
            id={quantityId}
            ref={quantityRef}
            // F-keys (F6 adds, F9 pays) reach the counter from here; see counter-keymap.
            data-counter-quantity=""
            type="text"
            pattern="[0-9]*"
            inputMode="numeric"
            value={quantity}
            disabled={disabled}
            aria-describedby={
              quantityMessage
                ? `${quantityId}-message`
                : preview
                  ? `${quantityId}-preview`
                  : undefined
            }
            aria-invalid={
              (quantity !== '' && !validQuantity) || (preview ? !preview.sufficient : undefined)
            }
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => onQuantityChange(event.target.value)}
            onKeyDown={(event) => {
              if (!onSubmit || event.key !== 'Enter' || event.altKey || event.shiftKey) return;
              event.preventDefault();
              onSubmit();
            }}
            className="h-11 w-16 text-center tabular-nums"
          />
          <button
            type="button"
            aria-label="Increase quantity"
            disabled={disabled}
            onClick={() => onQuantityChange(String(validQuantity ? parsedQuantity + 1 : 1))}
            className="inline-flex size-11 items-center justify-center rounded-md border border-border-subtle bg-surface-card text-sm text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            +
          </button>
        </div>
        {quantityMessage ? (
          <p id={`${quantityId}-message`} className="text-sm text-text-muted">
            {quantityMessage}
          </p>
        ) : null}
      </div>

      {preview ? (
        <dl
          id={`${quantityId}-preview`}
          aria-live="polite"
          className={
            inline
              ? 'grid grid-cols-3 gap-x-3 gap-y-2 text-xs'
              : 'grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4'
          }
        >
          <div>
            <dt className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
              {inline ? 'Units' : 'Canonical units'}
            </dt>
            <dd className="font-mono tabular-nums text-text-strong">{preview.canonicalUnits}</dd>
          </div>
          <div>
            <dt className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
              Unit price
            </dt>
            <dd className="font-mono tabular-nums text-text-strong">
              {formatMinor(preview.unitPriceMinor)}
            </dd>
          </div>
          <div className={inline ? 'sr-only' : undefined}>
            <dt className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
              Pro-rata ceiling
            </dt>
            <dd className="font-mono tabular-nums text-text-muted">
              {formatMinor(preview.proRataCeilingMinor)}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
              Line total
            </dt>
            <dd className="font-mono tabular-nums text-text-strong">
              {formatMinor(preview.grossMinor)}
            </dd>
          </div>
          <div className={inline ? 'col-span-3' : 'col-span-2 sm:col-span-4'}>
            {preview.sufficient ? (
              <StatusPill
                status="in-stock"
                tone="success"
                label={`Covered · ${preview.availableUnits} units on hand`}
              />
            ) : (
              <span role="alert" className="flex flex-wrap items-center gap-2">
                <StatusPill
                  status="short"
                  tone="warning"
                  label={`Short by ${preview.shortfallUnits} units`}
                />
                <span className="text-sm text-text-body">
                  Only {preview.availableUnits} safe units are on hand. Reduce the quantity or
                  capture the shortfall as unfulfilled demand.
                </span>
              </span>
            )}
          </div>
        </dl>
      ) : null}
    </div>
  );
}
