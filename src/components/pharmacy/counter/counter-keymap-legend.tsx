'use client';

import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import {
  COUNTER_ACTION_LABELS,
  COUNTER_ACTIONS,
  COUNTER_KEYMAP_PRESETS,
  formatBinding,
  type CounterKeymapPresetKey,
  type ResolvedCounterKeymap,
} from '@/lib/pharmacy/counter-keymap';

export type CounterKeymapLegendProps = {
  keymap: ResolvedCounterKeymap;
  /**
   * Managers and owners choose the preset. A cashier sees only the chords in
   * force, without the picker or its placeholder presets.
   */
  canChoosePreset?: boolean;
  saving?: boolean;
  disabled?: boolean;
  onPresetChange: (preset: CounterKeymapPresetKey) => void;
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
  canChoosePreset = true,
  saving = false,
  disabled = false,
  onPresetChange,
}: CounterKeymapLegendProps) {
  const overridden = new Set(keymap.overriddenActions);
  return (
    <div className="space-y-2">
      {canChoosePreset ? (
        <div className="space-y-1.5">
          <Label htmlFor="counter-keymap-preset">Keymap</Label>
          <select
            id="counter-keymap-preset"
            value={keymap.preset.key}
            disabled={disabled || saving}
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
              <StatusPill status="unconfirmed" tone="warning" label="Placeholder" />
              <span>
                These chords are a proposal, to confirm in Phase 0
                {keymap.preset.phaseZeroDecision ? ` (${keymap.preset.phaseZeroDecision})` : ''}.
                They may change once the incumbent scorecard is complete.
              </span>
            </p>
          ) : null}
          {saving ? (
            <p className="text-sm text-text-muted" role="status">
              Saving keymap…
            </p>
          ) : null}
        </div>
      ) : null}

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
              <kbd className="rounded-[3px] border border-border-subtle bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-text-strong">
                {formatBinding(keymap.bindings[action])}
              </kbd>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
