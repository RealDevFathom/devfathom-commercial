'use client';

import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import {
  COUNTER_ACTION_LABELS,
  COUNTER_ACTIONS,
  COUNTER_KEYMAP_PRESETS,
  formatBinding,
  resolveCounterKeymap,
  type CounterKeymapPresetKey,
  type ResolvedCounterKeymap,
} from '@/lib/pharmacy/counter-keymap';

export type CounterKeymapLegendProps = {
  keymap: ResolvedCounterKeymap;
  /** Owner/admin preview only; staff see confirmed presets. */
  allowUnconfirmed?: boolean;
  saving?: boolean;
  disabled?: boolean;
  error?: string | null;
  onPresetChange: (preset: CounterKeymapPresetKey) => void;
};

/**
 * POS-01 — the workflow map, on screen.
 *
 * A keyboard-first counter has to be learnable without a manual, so the chords
 * are visible rather than hidden behind a help key. Unconfirmed presets are
 * available only in owner/admin preview, with their caveat intact.
 */
export function CounterKeymapLegend({
  keymap: suppliedKeymap,
  allowUnconfirmed = false,
  saving = false,
  disabled = false,
  error = null,
  onPresetChange,
}: CounterKeymapLegendProps) {
  const keymap =
    suppliedKeymap.preset.confirmed || allowUnconfirmed
      ? suppliedKeymap
      : resolveCounterKeymap({ preset: 'devfathom' });
  const overridden = new Set(keymap.overriddenActions);
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor="counter-keymap-preset">Keymap</Label>
        <select
          id="counter-keymap-preset"
          value={keymap.preset.key}
          disabled={disabled || saving}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'counter-keymap-error' : undefined}
          onChange={(event) => onPresetChange(event.target.value as CounterKeymapPresetKey)}
          className="h-11 w-full rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          {Object.values(COUNTER_KEYMAP_PRESETS)
            .filter((preset) => preset.confirmed || allowUnconfirmed)
            .map((preset) => (
              <option key={preset.key} value={preset.key}>
                {preset.label}
              </option>
            ))}
        </select>
        <p className="text-sm text-text-muted">{keymap.preset.description}</p>
        {!keymap.preset.confirmed ? (
          <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-warning">
            <StatusPill status="unconfirmed" tone="warning" label="Placeholder" />
            <span>
              These chords are a proposal, to confirm in Phase 0
              {keymap.preset.phaseZeroDecision ? ` (${keymap.preset.phaseZeroDecision})` : ''}. They
              may change once the incumbent scorecard is complete.
            </span>
          </p>
        ) : null}
        {saving ? (
          <p className="text-sm text-text-muted" role="status">
            Saving keymap…
          </p>
        ) : null}
        {error ? (
          <p id="counter-keymap-error" className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <dl className="grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-2">
        {COUNTER_ACTIONS.map((action) => (
          <div key={action} className="flex items-center justify-between gap-2 py-0.5">
            <dt className="min-w-0 truncate text-xs text-text-body">
              {COUNTER_ACTION_LABELS[action]}
            </dt>
            <dd className="flex shrink-0 items-center gap-1.5">
              {overridden.has(action) ? (
                <StatusPill status="custom" tone="info" label="Custom" />
              ) : null}
              <kbd className="rounded-xs border border-border-subtle bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-text-strong">
                {formatBinding(keymap.bindings[action])}
              </kbd>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
