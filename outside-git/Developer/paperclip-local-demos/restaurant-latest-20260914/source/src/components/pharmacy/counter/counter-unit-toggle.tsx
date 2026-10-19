'use client';

import { useId } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { SaleLinePreview, SaleUnitKind, SaleUnitOption } from '@/lib/pharmacy/counter-pricing';

export type CounterUnitToggleProps = {
  options: readonly SaleUnitOption[];
  selected: SaleUnitKind | null;
  quantity: string;
  quantityInvalid?: boolean;
  preview: SaleLinePreview | null;
  disabled?: boolean;
  onSelect: (kind: SaleUnitKind) => void;
  onQuantityChange: (quantity: string) => void;
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
  selected,
  quantity,
  quantityInvalid = false,
  preview,
  disabled = false,
  onSelect,
  onQuantityChange,
  chordFor,
}: CounterUnitToggleProps) {
  const quantityId = useId();

  if (options.length === 0) {
    return (
      <p className="text-sm text-text-muted" role="status">
        No sale unit is available for this medicine. Its pack hierarchy does not match the received
        lot, so no price can be derived.
      </p>
    );
  }

  return (
    <div className="space-y-4">
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
              key={option.packLevelId}
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
              className={`flex min-h-11 min-w-0 flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 ${
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
                className={`font-mono text-[0.625rem] tracking-wide ${
                  active ? 'opacity-90' : 'text-text-muted'
                }`}
              >
                {option.canonicalUnitsPerSaleUnit} units{chord ? ` · ${chord}` : ''}
              </span>
            </button>
          );
        })}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={quantityId}>Quantity</Label>
        <Input
          id={quantityId}
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={quantity}
          disabled={disabled}
          aria-describedby={
            quantityInvalid ? `${quantityId}-error` : preview ? `${quantityId}-preview` : undefined
          }
          aria-invalid={quantityInvalid || (preview ? !preview.sufficient : undefined)}
          onChange={(event) => onQuantityChange(event.target.value)}
          className="h-11 w-32"
        />
        {quantityInvalid ? (
          <p id={`${quantityId}-error`} role="status" className="text-sm text-destructive">
            Enter a whole number greater than zero within the safe quantity range for this sale
            unit.
          </p>
        ) : null}
      </div>

      {preview && !quantityInvalid ? (
        <dl
          id={`${quantityId}-preview`}
          aria-live="polite"
          className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-surface-sunken p-3 text-sm sm:grid-cols-4"
        >
          <div>
            <dt className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
              Canonical units
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
          <div>
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
          <div className="col-span-2 sm:col-span-4">
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
