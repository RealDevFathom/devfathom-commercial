/**
 * PH-POS / POS-01 — the keyboard-first counter workflow map.
 *
 * Pure and DOM-free so the whole map can be enumerated by unit tests: the
 * counter console only asks this module "which action did that key press mean",
 * and every binding decision (presets, per-operator overrides, conflict
 * refusal) is made here rather than inside a React handler.
 *
 * FAIL CLOSED on conflicts. Two actions may never share a chord: a cashier who
 * silently loses "tender" because an override shadowed it is exactly the defect
 * a keyboard-only counter cannot afford, so `resolveCounterKeymap` refuses the
 * whole map instead of picking a winner.
 */

export class PharmacyCounterKeymapError extends Error {
  constructor(
    readonly reason: 'UNKNOWN_ACTION' | 'INVALID_BINDING' | 'DUPLICATE_BINDING' | 'UNKNOWN_PRESET'
  ) {
    super(reason);
  }
}

/** Every workflow the counter can reach without a mouse (POS-01). */
export const COUNTER_ACTIONS = [
  'focusSearch',
  'selectPackUnit',
  'selectStripUnit',
  'selectLooseUnit',
  'addToCart',
  'holdSale',
  'resumeSale',
  'openTender',
  'printReceipt',
  'focusPrescriptionPanel',
  'captureDemand',
  'voidSale',
] as const;

export type CounterAction = (typeof COUNTER_ACTIONS)[number];

export type CounterBinding = {
  /** Matched against `KeyboardEvent.key` exactly (for example `F2`, `Enter`). */
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
};

export type CounterKeymapPresetKey = 'devfathom' | 'legacySpeed';

export type CounterKeymapPreset = {
  key: CounterKeymapPresetKey;
  label: string;
  description: string;
  /**
   * False while the chords are still a proposal rather than a measured fact.
   * The counter renders the caveat instead of implying the map is settled.
   */
  confirmed: boolean;
  /** The PRD §12 open decision that confirms this preset, when unconfirmed. */
  phaseZeroDecision: string | null;
  bindings: Readonly<Record<CounterAction, CounterBinding>>;
};

/**
 * The DevFathom default. F2–F10 carry the linear bill workflow in the order a
 * counter actually performs it, and the three exception workflows sit on the
 * shifted row so a mis-keyed F-key can never void a bill.
 *
 * F1, F11 and F12 are deliberately unused: browsers reserve them for help,
 * fullscreen and developer tools, and a chord the browser eats is a chord the
 * cashier cannot rely on.
 */
const DEVFATHOM_BINDINGS: Record<CounterAction, CounterBinding> = {
  focusSearch: { key: 'F2' },
  selectPackUnit: { key: 'F3' },
  selectStripUnit: { key: 'F4' },
  selectLooseUnit: { key: 'F5' },
  addToCart: { key: 'F6' },
  holdSale: { key: 'F7' },
  resumeSale: { key: 'F8' },
  openTender: { key: 'F9' },
  printReceipt: { key: 'F10' },
  focusPrescriptionPanel: { key: 'F2', shift: true },
  captureDemand: { key: 'F3', shift: true },
  voidSale: { key: 'F4', shift: true },
};

/**
 * PLACEHOLDER — "Legacy Speed", for cashiers migrating from Abuzar, Candela or
 * MARS (POS-01).
 *
 * These chords are a documented PROPOSAL, not a measured incumbent map. The PRD
 * places the hands-on Abuzar/Candela/MARS scorecard in Phase 0 (§11) and gates
 * it on open decision D01, so the real bindings are "to confirm in Phase 0".
 * Until that scorecard lands, the preset is marked unconfirmed and the counter
 * says so on screen rather than teaching a cashier a chord we may change.
 *
 * Removal condition: replace these bindings with the scorecard's measured map
 * and set `confirmed: true` when D01 is accepted.
 */
const LEGACY_SPEED_BINDINGS: Record<CounterAction, CounterBinding> = {
  focusSearch: { key: 'F4' },
  // F5 sells loose in every preset, so a cashier switching presets keeps it.
  selectPackUnit: { key: 'F7' },
  selectStripUnit: { key: 'F6' },
  selectLooseUnit: { key: 'F5' },
  addToCart: { key: 'Enter', ctrl: true },
  holdSale: { key: 'F3' },
  resumeSale: { key: 'F8' },
  openTender: { key: 'F9' },
  printReceipt: { key: 'F10' },
  focusPrescriptionPanel: { key: 'F2' },
  captureDemand: { key: 'F6', shift: true },
  voidSale: { key: 'F5', shift: true },
};

export const COUNTER_KEYMAP_PRESETS: Readonly<Record<CounterKeymapPresetKey, CounterKeymapPreset>> =
  {
    devfathom: {
      key: 'devfathom',
      label: 'DevFathom counter',
      description: 'F2–F10 follow the bill in workflow order; exceptions sit on Shift+F2–F4.',
      confirmed: true,
      phaseZeroDecision: null,
      bindings: DEVFATHOM_BINDINGS,
    },
    legacySpeed: {
      key: 'legacySpeed',
      label: 'Legacy Speed',
      description:
        'Proposed muscle-memory map for Abuzar, Candela and MARS cashiers. To confirm in Phase 0 (D01).',
      confirmed: false,
      phaseZeroDecision: 'D01',
      bindings: LEGACY_SPEED_BINDINGS,
    },
  };

export const COUNTER_ACTION_LABELS: Readonly<Record<CounterAction, string>> = {
  focusSearch: 'Focus scan and search',
  selectPackUnit: 'Sell by pack',
  selectStripUnit: 'Sell by strip',
  selectLooseUnit: 'Sell by unit',
  addToCart: 'Add to cart',
  holdSale: 'Hold bill',
  resumeSale: 'Resume held bill',
  openTender: 'Open tender',
  printReceipt: 'Print receipt',
  focusPrescriptionPanel: 'Focus prescription panel',
  captureDemand: 'Capture unfulfilled demand',
  voidSale: 'Void bill',
};

function isCounterAction(value: string): value is CounterAction {
  return (COUNTER_ACTIONS as readonly string[]).includes(value);
}

/**
 * The canonical form of a chord. Modifier order is fixed here so two bindings
 * that differ only in how they were written still collide during validation.
 */
export function bindingSignature(binding: CounterBinding): string {
  return [
    binding.ctrl ? 'Ctrl' : '',
    binding.alt ? 'Alt' : '',
    binding.shift ? 'Shift' : '',
    binding.key,
  ]
    .filter(Boolean)
    .join('+');
}

/** The chord as an operator reads it in the legend. */
export function formatBinding(binding: CounterBinding): string {
  return bindingSignature(binding);
}

function assertValidBinding(binding: CounterBinding): void {
  if (typeof binding.key !== 'string' || binding.key.trim() === '' || binding.key.length > 16) {
    throw new PharmacyCounterKeymapError('INVALID_BINDING');
  }
  for (const modifier of [binding.ctrl, binding.alt, binding.shift]) {
    if (modifier !== undefined && typeof modifier !== 'boolean') {
      throw new PharmacyCounterKeymapError('INVALID_BINDING');
    }
  }
}

export type ResolvedCounterKeymap = {
  preset: CounterKeymapPreset;
  bindings: Readonly<Record<CounterAction, CounterBinding>>;
  /** The actions whose chord differs from the preset, for the legend. */
  overriddenActions: readonly CounterAction[];
};

/**
 * Merge per-operator overrides onto a preset (POS-01 "configurable shortcuts").
 *
 * An unknown action, a malformed chord, or two actions landing on the same
 * chord rejects the entire map. The caller then keeps the last good map rather
 * than running a counter with a silently missing workflow.
 */
export function resolveCounterKeymap(input: {
  preset: CounterKeymapPresetKey;
  overrides?: Readonly<Record<string, CounterBinding>>;
}): ResolvedCounterKeymap {
  const preset = COUNTER_KEYMAP_PRESETS[input.preset];
  if (!preset) throw new PharmacyCounterKeymapError('UNKNOWN_PRESET');

  const bindings: Record<CounterAction, CounterBinding> = { ...preset.bindings };
  const overriddenActions: CounterAction[] = [];

  for (const [action, binding] of Object.entries(input.overrides ?? {})) {
    if (!isCounterAction(action)) throw new PharmacyCounterKeymapError('UNKNOWN_ACTION');
    assertValidBinding(binding);
    bindings[action] = {
      key: binding.key,
      ...(binding.ctrl ? { ctrl: true } : {}),
      ...(binding.alt ? { alt: true } : {}),
      ...(binding.shift ? { shift: true } : {}),
    };
    if (bindingSignature(bindings[action]) !== bindingSignature(preset.bindings[action])) {
      overriddenActions.push(action);
    }
  }

  const seen = new Map<string, CounterAction>();
  for (const action of COUNTER_ACTIONS) {
    const signature = bindingSignature(bindings[action]);
    if (seen.has(signature)) throw new PharmacyCounterKeymapError('DUPLICATE_BINDING');
    seen.set(signature, action);
  }

  return { preset, bindings, overriddenActions };
}

export type CounterKeyEvent = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: EventTarget | null;
};

/**
 * The action a key press means, or `null`.
 *
 * `ctrl` matches either Control or Command so one map serves Windows counters
 * and a macOS demo machine. Every modifier the binding does not ask for must be
 * absent, so Shift+F2 never also fires the plain F2 action.
 */
export function matchCounterAction(
  bindings: Readonly<Record<CounterAction, CounterBinding>>,
  event: CounterKeyEvent
): CounterAction | null {
  const ctrl = Boolean(event.ctrlKey || event.metaKey);
  for (const action of COUNTER_ACTIONS) {
    const binding = bindings[action];
    if (binding.key !== event.key) continue;
    if (ctrl !== Boolean(binding.ctrl)) continue;
    if (Boolean(event.altKey) !== Boolean(binding.alt)) continue;
    if (Boolean(event.shiftKey) !== Boolean(binding.shift)) continue;
    return action;
  }
  return null;
}

/**
 * Marks the counter's scan field. Focus rests there for the whole bill (POS-01),
 * so F-keys stay live inside it; see `shouldHandleCounterKey`.
 */
export const COUNTER_SCAN_FIELD_ATTRIBUTE = 'data-counter-scan';

/** A field the operator is typing in owns the keyboard. F-keys wait. */
export function counterChordTargetIsField(target: EventTarget | null | undefined): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Whether `target` keeps `key` for itself. Every field does, except that the
 * scan field hands its F-keys to the counter. Quantity may hand off only an
 * explicitly matched unit-selection or add action. Enter remains field-owned.
 */
function fieldKeepsKey(
  target: EventTarget | null | undefined,
  key: string,
  quantityAction: boolean
): boolean {
  if (!counterChordTargetIsField(target)) return false;
  const scanField =
    target instanceof HTMLElement &&
    (target.hasAttribute(COUNTER_SCAN_FIELD_ATTRIBUTE) ||
      (quantityAction && target.hasAttribute('data-counter-quantity')));
  return !(scanField && /^F\d+$/.test(key));
}

/**
 * Whether a counter chord may run.
 *
 * Printable keys stay with the field. Named chords, including F-keys, also stay
 * with the field while focus is in an input, textarea, or select, and they stay
 * silent while a dialog is open so a void or tender step cannot be skipped.
 *
 * Quantity supports unit selection and add only (DEV-705); tender, hold and
 * destructive actions retain the original field guard. Dialogs silence all chords.
 */
export function shouldHandleCounterKey(
  event: CounterKeyEvent,
  dialogOpen = false,
  action: CounterAction | null = null
): boolean {
  const quantityAction =
    action === 'selectPackUnit' ||
    action === 'selectStripUnit' ||
    action === 'selectLooseUnit' ||
    action === 'addToCart';
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (
    dialogOpen ||
    fieldKeepsKey(active, event.key, quantityAction) ||
    fieldKeepsKey(event.target, event.key, quantityAction)
  ) {
    return false;
  }
  return event.key.length > 1;
}
