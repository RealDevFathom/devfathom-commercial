'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import {
  COUNTER_ACTION_LABELS,
  COUNTER_ACTIONS,
  COUNTER_KEYMAP_PRESETS,
  formatBinding,
  bindingSignature,
  type CounterAction,
  type CounterBinding,
  type CounterKeymapPresetKey,
  type ResolvedCounterKeymap,
} from '@/lib/pharmacy/counter-keymap';

export type CounterKeymapLegendProps = {
  keymap: ResolvedCounterKeymap;
  saving?: boolean;
  disabled?: boolean;
  error?: string | null;
  onPresetChange: (preset: CounterKeymapPresetKey) => void;
  onBindingsChange?: (overrides: Record<string, CounterBinding>) => void;
};

/**
 * POS-01 — the workflow map, on screen.
 *
 * A keyboard-first counter has to be learnable without a manual, so the chords
 * are visible rather than hidden behind a help key. An unconfirmed preset says
 * so in place: the Legacy Speed map is a Phase 0 proposal, and a cashier who
 * memorises it should know it may change.
 */
export function CounterKeymapLegend({
  keymap,
  saving = false,
  disabled = false,
  error = null,
  onPresetChange,
  onBindingsChange,
}: CounterKeymapLegendProps) {
  const overridden = new Set(keymap.overriddenActions);
  const [editing, setEditing] = useState<CounterAction | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  function capture(action: CounterAction, event: React.KeyboardEvent<HTMLButtonElement>) {
    if (editing !== action) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      setEditing(null);
      setCaptureError(null);
      return;
    }
    if (!/^F([2-9]|10)$/.test(event.key) || event.metaKey || event.ctrlKey || event.altKey) {
      setCaptureError('Choose F2 to F10, with Shift if needed.');
      return;
    }
    const binding: CounterBinding = { key: event.key, ...(event.shiftKey ? { shift: true } : {}) };
    const conflict = COUNTER_ACTIONS.find(
      (other) =>
        other !== action && bindingSignature(keymap.bindings[other]) === bindingSignature(binding)
    );
    if (conflict) {
      setCaptureError(
        `${formatBinding(binding)} is already used for “${COUNTER_ACTION_LABELS[conflict]}”. Choose another key.`
      );
      return;
    }
    const overrides: Record<string, CounterBinding> = {};
    for (const other of COUNTER_ACTIONS) {
      const next = other === action ? binding : keymap.bindings[other];
      if (bindingSignature(next) !== bindingSignature(keymap.preset.bindings[other]))
        overrides[other] = next;
    }
    onBindingsChange?.(overrides);
    setEditing(null);
    setCaptureError(null);
  }
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor="counter-keymap-preset">Keymap</Label>
        <select
          id="counter-keymap-preset"
          value={keymap.preset.key}
          disabled={disabled}
          title={disabled ? 'Finish the payment first' : undefined}
          onChange={(event) => onPresetChange(event.target.value as CounterKeymapPresetKey)}
          className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          {Object.values(COUNTER_KEYMAP_PRESETS).map((preset) => (
            <option key={preset.key} value={preset.key}>
              {preset.label}
            </option>
          ))}
        </select>
        <p className="text-sm text-text-muted">{keymap.preset.description}</p>
        {!keymap.preset.confirmed ? (
          <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-warning">
            <StatusPill status="unconfirmed" tone="warning" label="Under review" />
            <span>This keyboard layout is under review and may change.</span>
          </p>
        ) : null}
        {saving ? (
          <p className="text-sm text-text-muted" role="status">
            Saving keymap…
          </p>
        ) : null}
        {error ? (
          <p className="text-sm text-warning" role="alert">
            {error}
          </p>
        ) : null}
        {captureError ? (
          <p role="alert" className="text-sm text-warning">
            {captureError}
          </p>
        ) : null}
        {onBindingsChange && overridden.size > 0 ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={disabled}
            onClick={() => {
              setEditing(null);
              setCaptureError(null);
              onBindingsChange({});
            }}
          >
            Reset to preset
          </Button>
        ) : null}
      </div>

      <dl className="grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-2">
        {COUNTER_ACTIONS.map((action) => (
          <div key={action} className="flex flex-wrap items-center justify-between gap-2 py-0.5">
            <dt className="min-w-0 text-xs text-text-body">{COUNTER_ACTION_LABELS[action]}</dt>
            <dd className="flex shrink-0 items-center gap-1.5">
              {overridden.has(action) ? (
                <StatusPill status="custom" tone="info" label="Custom" />
              ) : null}
              <kbd className="rounded-[3px] border border-border-subtle bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-text-strong">
                {formatBinding(keymap.bindings[action])}
              </kbd>
              {onBindingsChange ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={disabled}
                  aria-label={`${editing === action ? 'Press the new key for' : 'Change'} ${COUNTER_ACTION_LABELS[action]}`}
                  onClick={() => {
                    setEditing(action);
                    setCaptureError(null);
                  }}
                  onKeyDown={(event) => capture(action, event)}
                >
                  {editing === action ? 'Press the new key' : 'Change'}
                </Button>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
