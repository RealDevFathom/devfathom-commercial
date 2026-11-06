'use client';

import { useTranslations } from 'next-intl';
import { useId } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { SaleLinePreview, SaleUnitKind, SaleUnitOption } from '@/lib/pharmacy/counter-pricing';

export type CounterUnitToggleProps = {
  options: readonly SaleUnitOption[];
  selected: SaleUnitKind | null;
  quantity: number;
  preview: SaleLinePreview | null;
  disabled?: boolean;
  /** Compact inline next-line composition, with the same pricing and keyboard controls. */
  inline?: boolean;
  onSelect: (kind: SaleUnitKind) => void;
  onQuantityChange: (quantity: number) => void;
  /** Rendered beside each unit so the operator sees the chord, not a tooltip. */
  chordFor?: (kind: SaleUnitKind) => string | null;
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
  preview,
  disabled = false,
  inline = false,
  onSelect,
  onQuantityChange,
  chordFor,
}: CounterUnitToggleProps) {
  const ct = useTranslations('CounterText');
  const quantityId = useId();

  if (options.length === 0) {
    return (
      <p className="text-sm text-text-muted" role="status">
        {ct('noSaleUnitIsAvailableForThisMedicineIts')}
      </p>
    );
  }

  return (
    <div className={inline ? 'grid items-end gap-3 sm:grid-cols-[auto_auto_1fr]' : 'space-y-2'}>
      <div className="space-y-1">
        {inline ? (
          <span className="block text-xs font-semibold text-text-strong">{ct('saleUnit')}</span>
        ) : null}
        <div
          role="radiogroup"
          aria-label={ct('saleUnit')}
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
                className={`flex min-h-11 min-w-0 flex-col items-start gap-0.5 rounded-md border px-2 py-1 text-start focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 ${
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border-subtle bg-surface-card text-text-strong hover:bg-surface-sunken'
                }`}
              >
                <span className="text-sm font-semibold">
                  {ct(`saleUnitLabels.${option.kind}`)}
                  {option.levelLabel && option.levelLabel !== option.kind ? (
                    <span className="ms-1 font-normal opacity-80">({option.levelLabel})</span>
                  ) : null}
                </span>
                <span
                  className={`font-mono text-[0.625rem] tracking-wide ${active ? 'text-primary-foreground' : 'text-text-muted'}`}
                >
                  {option.canonicalUnitsPerSaleUnit} {ct('units')}
                  {chord ? ` · ${chord}` : ''}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={quantityId}>{ct('quantity')}</Label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={ct('decreaseQuantity')}
            disabled={disabled || quantity <= 1}
            onClick={() => onQuantityChange(Math.max(1, quantity - 1))}
            className="inline-flex size-11 items-center justify-center rounded-md border border-border-subtle bg-surface-card text-sm text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            −
          </button>
          <Input
            id={quantityId}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={quantity}
            disabled={disabled}
            aria-describedby={preview ? `${quantityId}-preview` : undefined}
            aria-invalid={preview ? !preview.sufficient : undefined}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              onQuantityChange(Number.isSafeInteger(next) && next > 0 ? next : 1);
            }}
            className="h-11 w-16 text-center tabular-nums"
          />
          <button
            type="button"
            aria-label={ct('increaseQuantity')}
            disabled={disabled}
            onClick={() => onQuantityChange(quantity + 1)}
            className="inline-flex size-11 items-center justify-center rounded-md border border-border-subtle bg-surface-card text-sm text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            +
          </button>
        </div>
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
              {inline ? ct('units2') : ct('canonicalUnits')}
            </dt>
            <dd className="font-mono tabular-nums text-text-strong">{preview.canonicalUnits}</dd>
          </div>
          <div>
            <dt className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
              {ct('unitPrice')}
            </dt>
            <dd className="font-mono tabular-nums text-text-strong">
              {formatMinor(preview.unitPriceMinor)}
            </dd>
          </div>
          <div className={inline ? 'sr-only' : undefined}>
            <dt className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
              {ct('proRataCeiling')}
            </dt>
            <dd className="font-mono tabular-nums text-text-muted">
              {formatMinor(preview.proRataCeilingMinor)}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
              {ct('lineTotal')}
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
                label={ct('coveredValue0UnitsOnHand', { value0: preview.availableUnits })}
              />
            ) : (
              <span role="alert" className="flex flex-wrap items-center gap-2">
                <StatusPill
                  status="short"
                  tone="warning"
                  label={ct('shortByValue0Units', { value0: preview.shortfallUnits })}
                />
                <span className="text-sm text-text-body">
                  {ct('only')}
                  {preview.availableUnits} {ct('safeUnitsAreOnHandReduceTheQuantityOr')}
                </span>
              </span>
            )}
          </div>
        </dl>
      ) : null}
    </div>
  );
}
