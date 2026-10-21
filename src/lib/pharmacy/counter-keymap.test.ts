import { describe, expect, it } from 'vitest';

import {
  bindingSignature,
  COUNTER_ACTIONS,
  COUNTER_KEYMAP_PRESETS,
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
