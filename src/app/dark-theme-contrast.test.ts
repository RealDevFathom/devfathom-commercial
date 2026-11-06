/**
 * Dark-theme contrast contract (QA UI batches 3 and 4). Source-level checks on
 * the canonical Studio dark tokens and the unlayered control-contrast rules, so
 * borders, links, muted copy, primary controls and focus rings stay legible on
 * the dark card without a browser build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const globals = readFileSync(join(__dirname, 'globals.css'), 'utf8');
const studioGlobals = globals.slice(globals.indexOf('DEVFATHOM STUDIO'));
const darkBlock = studioGlobals.match(/\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';

function token(name: string): string {
  const match = darkBlock.match(new RegExp(`\\n\\s*--${name}:\\s*([^;]+);`));
  expect(match, `dark theme must define --${name}`).not.toBeNull();
  const value = match![1]!.trim();
  const alias = value.match(/^var\(--([a-z-]+)\)$/);
  return alias ? token(alias[1]!) : value;
}

function channels(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  expect(value, `${hex} must be a 6-digit hex`).toMatch(/^[0-9a-f]{6}$/i);
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** `fg` painted at `alpha` over `bg`, as `opacity` or a `/NN` modifier does. */
function over(fg: string, alpha: number, bg: string): string {
  const top = channels(fg);
  const base = channels(bg);
  return `#${top
    .map((channel, index) =>
      Math.round(channel * alpha + base[index]! * (1 - alpha))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

describe('dark theme borders', () => {
  const card = () => token('surface-card');

  it('keeps input boundaries at 3:1 on the card (WCAG 1.4.11)', () => {
    expect(contrast(token('input'), card())).toBeGreaterThanOrEqual(3);
    expect(contrast(token('border-strong'), card())).toBeGreaterThanOrEqual(3);
  });

  it('keeps card hairlines visibly separate from the card and the page', () => {
    for (const name of ['border-subtle', 'border-default', 'border']) {
      expect(contrast(token(name), card()), name).toBeGreaterThanOrEqual(1.7);
      expect(contrast(token(name), token('surface-page')), name).toBeGreaterThanOrEqual(1.7);
    }
    // Still a hierarchy, not three copies of one value.
    expect(luminance(token('border-subtle'))).toBeLessThan(luminance(token('border-default')));
    expect(luminance(token('border-default'))).toBeLessThan(luminance(token('border-strong')));
  });
});

describe('dark theme text', () => {
  const surfaces = ['surface-card', 'surface-raised', 'surface-page', 'muted', 'secondary'];

  it('holds muted, faint and link text well above AA on every dark surface', () => {
    for (const surface of surfaces) {
      expect(contrast(token('text-muted'), token(surface)), surface).toBeGreaterThanOrEqual(7);
      expect(contrast(token('muted-foreground'), token(surface)), surface).toBeGreaterThanOrEqual(
        7
      );
      expect(contrast(token('text-faint'), token(surface)), surface).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token('text-link'), token(surface)), surface).toBeGreaterThanOrEqual(7);
    }
  });

  it('keeps muted copy quieter than body copy', () => {
    expect(luminance(token('text-muted'))).toBeLessThan(luminance(token('text-body')));
    expect(luminance(token('text-faint'))).toBeLessThan(luminance(token('text-muted')));
  });

  it('re-points --primary to the link token for every text-role use in dark', () => {
    const rule = globals.match(
      /\[data-theme='dark'\]\s*:is\(([^)]*)\)\s*\{\s*--primary:\s*var\(--text-link\);/
    );
    expect(rule, 'dark text-primary remap is missing').not.toBeNull();
    for (const utility of [
      '.text-primary',
      '.hover\\:text-primary',
      '.group-hover\\:text-primary',
      '.data-checked\\:text-primary',
    ]) {
      expect(rule![1]).toContain(utility);
    }
  });

  it('keeps a hovered text-primary link readable in dark', () => {
    expect(globals).toMatch(
      /\[data-theme='dark'\]\s+\.hover\\:text-primary-hover\s*\{\s*--primary-hover:\s*var\(--text-body\);/
    );
    expect(contrast(token('text-body'), token('surface-card'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('dark theme primary controls', () => {
  const edgeRule = () =>
    globals.match(
      /\[data-theme='dark'\]\s*:is\(([^{]*?)\)\.bg-primary:not\(\s*:focus-visible\s*\)\s*\{([^}]*)\}/
    );

  it('edges primary-filled buttons, links and the active navigation pill', () => {
    const rule = edgeRule();
    expect(rule, 'dark primary edge rule is missing').not.toBeNull();
    for (const target of ['button', 'a', "[role='button']", "[data-slot='button']"]) {
      expect(rule![1]).toContain(target);
    }
    expect(rule![1]).toContain("[aria-current='page'] > span");
    expect(rule![2]).toContain('outline: 1px solid var(--primary-edge);');
  });

  it('keeps the edge at 3:1 against the card even when the control is disabled', () => {
    const edge = token('primary-edge');
    const card = token('surface-card');
    expect(contrast(edge, card)).toBeGreaterThanOrEqual(3);
    // `disabled:opacity-50` halves the whole control, edge included.
    expect(contrast(over(edge, 0.5, card), card)).toBeGreaterThanOrEqual(3);
    // The default saved tenant brand is the light-theme ink.
    expect(contrast(edge, '#111110')).toBeGreaterThanOrEqual(3);
  });

  it('brightens the edge on hover for enabled, unfocused primary controls', () => {
    expect(globals).toMatch(
      /\.bg-primary:hover:not\(\s*:disabled,\s*\[aria-disabled='true'\],\s*\[data-disabled\],\s*:focus-visible\s*\)\s*\{\s*outline-color:\s*var\(--text-strong\);/
    );
  });

  it('declares the dark rules unlayered so `outline-none` utilities cannot drop them', () => {
    const start = globals.indexOf('DARK THEME CONTROL CONTRAST');
    expect(start).toBeGreaterThan(globals.lastIndexOf('@layer'));
  });
});

describe('input-group focus ring', () => {
  it('draws the focus token on the rounded group and not the square inner input', () => {
    expect(globals).toMatch(
      /\[data-slot='input-group'\]\s*:is\(\[data-slot='command-input'\],\s*\[data-slot='input-group-control'\]\):focus-visible\s*\{\s*outline:\s*none;/
    );
    expect(globals).toMatch(
      /\[data-slot='input-group'\]:has\(\s*:is\(\[data-slot='command-input'\],\s*\[data-slot='input-group-control'\]\):focus-visible\s*\)\s*\{\s*outline:\s*2px solid var\(--ring\);\s*outline-offset:\s*0;/
    );
  });

  it('keeps a system focus colour on the group in forced-colors mode', () => {
    const forced = globals.slice(globals.indexOf('@media (forced-colors: active)'));
    expect(forced).toMatch(
      /\[data-slot='input-group'\]:has\([\s\S]*?\)\s*\{\s*outline-color:\s*Highlight;/
    );
  });
});
