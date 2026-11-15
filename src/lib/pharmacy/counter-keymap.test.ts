import { describe, expect, it } from 'vitest';

import {
  bindingSignature,
  COUNTER_ACTIONS,
  COUNTER_KEYMAP_PRESETS,
  COUNTER_QUANTITY_FIELD_ATTRIBUTE,
  COUNTER_SCAN_FIELD_ATTRIBUTE,
  formatBinding,
  matchCounterAction,
  PharmacyCounterKeymapError,
  resolveCounterKeymap,
  shouldHandleCounterKey,
} from './counter-keymap';

describe('counter keymap presets (POS-01)', () => {
  it('binds every counter action in every shipped preset', () => {
    for (const preset of Object.values(COUNTER_KEYMAP_PRESETS)) {
      for (const action of COUNTER_ACTIONS) {
        expect(preset.bindings[action], `${preset.key}/${action}`).toBeDefined();
        expect(preset.bindings[action].key.length).toBeGreaterThan(0);
      }
    }
  });

  it('gives every action a distinct chord within a preset', () => {
    for (const preset of Object.values(COUNTER_KEYMAP_PRESETS)) {
      const signatures = COUNTER_ACTIONS.map((action) => bindingSignature(preset.bindings[action]));
      expect(new Set(signatures).size, preset.key).toBe(COUNTER_ACTIONS.length);
    }
  });

  it('never binds a key the browser reserves for help, fullscreen or dev tools', () => {
    for (const preset of Object.values(COUNTER_KEYMAP_PRESETS)) {
      for (const action of COUNTER_ACTIONS) {
        expect(['F1', 'F11', 'F12'], `${preset.key}/${action}`).not.toContain(
          preset.bindings[action].key
        );
      }
    }
  });

  it('marks Legacy Speed as an unconfirmed Phase 0 placeholder', () => {
    expect(COUNTER_KEYMAP_PRESETS.legacySpeed.confirmed).toBe(false);
    expect(COUNTER_KEYMAP_PRESETS.legacySpeed.phaseZeroDecision).toBe('D01');
    expect(COUNTER_KEYMAP_PRESETS.legacySpeed.description).toMatch(/confirm in Phase 0/i);
    // The shipped default must NOT wear the caveat, or the caveat means nothing.
    expect(COUNTER_KEYMAP_PRESETS.devfathom.confirmed).toBe(true);
  });
});

describe('resolveCounterKeymap', () => {
  it('returns the preset unchanged when there are no overrides', () => {
    const resolved = resolveCounterKeymap({ preset: 'devfathom' });
    expect(resolved.preset.key).toBe('devfathom');
    expect(resolved.overriddenActions).toEqual([]);
    expect(resolved.bindings.openTender).toEqual({ key: 'F9' });
  });

  it('applies an override and reports which action moved', () => {
    const resolved = resolveCounterKeymap({
      preset: 'devfathom',
      overrides: { openTender: { key: 'F12', ctrl: true } },
    });
    expect(resolved.bindings.openTender).toEqual({ key: 'F12', ctrl: true });
    expect(resolved.overriddenActions).toEqual(['openTender']);
    // Untouched actions keep the preset chord.
    expect(resolved.bindings.focusSearch).toEqual({ key: 'F2' });
  });

  it('does not report an override that restates the preset chord', () => {
    const resolved = resolveCounterKeymap({
      preset: 'devfathom',
      overrides: { focusSearch: { key: 'F2' } },
    });
    expect(resolved.overriddenActions).toEqual([]);
  });

  it('refuses the whole map when an override shadows another action', () => {
    // F9 already belongs to openTender. Silently letting addToCart win would
    // leave the cashier with no way to take payment.
    expect(() =>
      resolveCounterKeymap({ preset: 'devfathom', overrides: { addToCart: { key: 'F9' } } })
    ).toThrowError(PharmacyCounterKeymapError);
    try {
      resolveCounterKeymap({ preset: 'devfathom', overrides: { addToCart: { key: 'F9' } } });
    } catch (error) {
      expect((error as PharmacyCounterKeymapError).reason).toBe('DUPLICATE_BINDING');
    }
  });

  it('treats a modifier difference as a distinct chord', () => {
    const resolved = resolveCounterKeymap({
      preset: 'devfathom',
      overrides: { addToCart: { key: 'F9', shift: true } },
    });
    expect(resolved.bindings.addToCart).toEqual({ key: 'F9', shift: true });
    expect(resolved.bindings.openTender).toEqual({ key: 'F9' });
  });

  it('rejects an unknown action', () => {
    try {
      resolveCounterKeymap({ preset: 'devfathom', overrides: { teleport: { key: 'F9' } } });
      expect.unreachable('an unknown action must be refused');
    } catch (error) {
      expect((error as PharmacyCounterKeymapError).reason).toBe('UNKNOWN_ACTION');
    }
  });

  it('rejects a malformed chord', () => {
    for (const binding of [{ key: '' }, { key: '   ' }, { key: 'x'.repeat(17) }]) {
      try {
        resolveCounterKeymap({ preset: 'devfathom', overrides: { addToCart: binding } });
        expect.unreachable(`a malformed chord must be refused: ${JSON.stringify(binding)}`);
      } catch (error) {
        expect((error as PharmacyCounterKeymapError).reason).toBe('INVALID_BINDING');
      }
    }
  });

  it('normalizes falsy modifiers away so signatures compare equal', () => {
    const resolved = resolveCounterKeymap({
      preset: 'devfathom',
      overrides: { addToCart: { key: 'F6', ctrl: false, alt: false, shift: false } },
    });
    expect(resolved.bindings.addToCart).toEqual({ key: 'F6' });
    expect(resolved.overriddenActions).toEqual([]);
  });
});

describe('matchCounterAction', () => {
  const { bindings } = resolveCounterKeymap({ preset: 'devfathom' });

  it('resolves a plain F-key to its workflow', () => {
    expect(matchCounterAction(bindings, { key: 'F2' })).toBe('focusSearch');
    expect(matchCounterAction(bindings, { key: 'F6' })).toBe('addToCart');
    expect(matchCounterAction(bindings, { key: 'F9' })).toBe('openTender');
  });

  it('keeps a shifted chord distinct from its unshifted twin', () => {
    expect(matchCounterAction(bindings, { key: 'F2', shiftKey: true })).toBe(
      'focusPrescriptionPanel'
    );
    expect(matchCounterAction(bindings, { key: 'F4', shiftKey: true })).toBe('voidSale');
    // F4 alone must never void a bill.
    expect(matchCounterAction(bindings, { key: 'F4' })).toBe('selectStripUnit');
  });

  it('refuses a chord carrying a modifier the binding did not ask for', () => {
    expect(matchCounterAction(bindings, { key: 'F2', altKey: true })).toBeNull();
    expect(matchCounterAction(bindings, { key: 'F2', ctrlKey: true })).toBeNull();
    expect(matchCounterAction(bindings, { key: 'F9', metaKey: true })).toBeNull();
  });

  it('accepts Command as Control so one map serves both platforms', () => {
    const legacy = resolveCounterKeymap({ preset: 'legacySpeed' });
    expect(matchCounterAction(legacy.bindings, { key: 'Enter', ctrlKey: true })).toBe('addToCart');
    expect(matchCounterAction(legacy.bindings, { key: 'Enter', metaKey: true })).toBe('addToCart');
    expect(matchCounterAction(legacy.bindings, { key: 'Enter' })).toBeNull();
  });

  it('sells loose on F5 in every preset', () => {
    for (const preset of ['devfathom', 'legacySpeed'] as const) {
      const keymap = resolveCounterKeymap({ preset });
      expect(matchCounterAction(keymap.bindings, { key: 'F5' })).toBe('selectLooseUnit');
    }
  });

  it('returns null for an unbound key', () => {
    expect(matchCounterAction(bindings, { key: 'a' })).toBeNull();
    expect(matchCounterAction(bindings, { key: 'Escape' })).toBeNull();
  });
});

describe('shouldHandleCounterKey', () => {
  it('lets named keys through and leaves printable typing to the field', () => {
    expect(shouldHandleCounterKey({ key: 'F2' })).toBe(true);
    expect(shouldHandleCounterKey({ key: 'Enter' })).toBe(true);
    expect(shouldHandleCounterKey({ key: 'a' })).toBe(false);
    expect(shouldHandleCounterKey({ key: '5' })).toBe(false);
  });

  it('does not fire F-keys from an input, textarea, or select, or while a dialog is open', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    document.body.append(input, textarea, select);
    expect(shouldHandleCounterKey({ key: 'F9', target: input })).toBe(false);
    expect(shouldHandleCounterKey({ key: 'F2', target: textarea })).toBe(false);
    expect(shouldHandleCounterKey({ key: 'F6', target: select })).toBe(false);
    input.focus();
    expect(shouldHandleCounterKey({ key: 'F9', target: document.body })).toBe(false);
    input.blur();
    expect(shouldHandleCounterKey({ key: 'F9' }, true)).toBe(false);
    input.remove();
    textarea.remove();
    select.remove();
  });

  it('keeps F-keys live in the marked scan field (POS-01), but never while a dialog is open', () => {
    const scan = document.createElement('input');
    scan.setAttribute(COUNTER_SCAN_FIELD_ATTRIBUTE, '');
    const other = document.createElement('input');
    document.body.append(scan, other);
    const tender = { key: 'F9' };
    const voidBill = { key: 'F4', shiftKey: true };

    // The scan field as the event target, then also as the focused element.
    expect(shouldHandleCounterKey({ ...tender, target: scan })).toBe(true);
    expect(shouldHandleCounterKey({ ...voidBill, target: scan })).toBe(true);
    scan.focus();
    expect(shouldHandleCounterKey({ ...tender, target: scan })).toBe(true);
    expect(shouldHandleCounterKey({ ...voidBill, target: scan })).toBe(true);

    // A dialog silences them even there, so a void or tender step cannot be skipped.
    expect(shouldHandleCounterKey({ ...tender, target: scan }, true)).toBe(false);
    expect(shouldHandleCounterKey({ ...voidBill, target: scan }, true)).toBe(false);

    // Only F-keys leave the field: typing, Enter and the editing keys stay with it.
    expect(shouldHandleCounterKey({ key: 'a', target: scan })).toBe(false);
    expect(shouldHandleCounterKey({ key: '5', target: scan })).toBe(false);
    expect(shouldHandleCounterKey({ key: 'Enter', ctrlKey: true, target: scan })).toBe(false);
    expect(shouldHandleCounterKey({ key: 'Backspace', target: scan })).toBe(false);

    // An unmarked input still keeps them, as the target or as the focused element.
    expect(shouldHandleCounterKey({ ...tender, target: other })).toBe(false);
    expect(shouldHandleCounterKey({ ...voidBill, target: other })).toBe(false);
    other.focus();
    expect(shouldHandleCounterKey({ ...tender, target: document.body })).toBe(false);
    expect(shouldHandleCounterKey({ ...voidBill, target: document.body })).toBe(false);
    other.blur();
    scan.remove();
    other.remove();
  });

  it('keeps F-keys live in the marked quantity field (DEV-633), but never while a dialog is open', () => {
    const quantity = document.createElement('input');
    quantity.setAttribute(COUNTER_QUANTITY_FIELD_ATTRIBUTE, '');
    document.body.append(quantity);
    quantity.focus();

    expect(shouldHandleCounterKey({ key: 'F6', target: quantity })).toBe(true);
    expect(shouldHandleCounterKey({ key: 'F9', target: quantity })).toBe(true);
    expect(shouldHandleCounterKey({ key: 'F6', target: quantity }, true)).toBe(false);

    // Digits, Enter and the editing keys stay with the field.
    expect(shouldHandleCounterKey({ key: '2', target: quantity })).toBe(false);
    expect(shouldHandleCounterKey({ key: 'Enter', target: quantity })).toBe(false);
    expect(shouldHandleCounterKey({ key: 'Enter', ctrlKey: true, target: quantity })).toBe(false);
    expect(shouldHandleCounterKey({ key: 'Backspace', target: quantity })).toBe(false);
    quantity.blur();
    quantity.remove();
  });
});

describe('formatBinding', () => {
  it('renders modifiers in a stable order', () => {
    expect(formatBinding({ key: 'F2' })).toBe('F2');
    expect(formatBinding({ key: 'F2', shift: true })).toBe('Shift+F2');
    expect(formatBinding({ key: 'Enter', ctrl: true })).toBe('Ctrl+Enter');
    expect(formatBinding({ key: 'K', ctrl: true, alt: true, shift: true })).toBe(
      'Ctrl+Alt+Shift+K'
    );
  });
});
