import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DailyWorkPackLoading } from './daily-work-pack';

/**
 * DEV-601 (work-pack half): in dark mode the Daily work pack read as dense, low-contrast grey
 * and its disabled Refresh control (the shared Button's `opacity-50`) all but disappeared.
 * Readable copy uses contrast-checked text tokens, never `--text-faint` or an opacity-dimmed
 * token (DEVFATHOM-STUDIO.md §3), and the disabled control stays at full opacity.
 */
const repo = resolve(__dirname, '../../../../..');
const css = readFileSync(resolve(repo, 'src/app/globals.css'), 'utf8');
const component = readFileSync(resolve(__dirname, 'daily-work-pack.tsx'), 'utf8');

/** Top-level `selector { … }` bodies in file order, so later blocks override earlier ones. */
function blocks(selector: string) {
  const bodies: string[] = [];
  const head = `\n${selector} {`;
  for (let at = css.indexOf(head); at !== -1; at = css.indexOf(head, at + head.length)) {
    const start = at + head.length;
    bodies.push(css.slice(start, css.indexOf('\n}', start)));
  }
  return bodies;
}

/** The cascade a page sees: every `:root` block, then (dark) every `[data-theme='dark']` block. */
function theme(dark: boolean) {
  const tokens = new Map<string, string>();
  for (const body of [...blocks(':root'), ...(dark ? blocks("[data-theme='dark']") : [])])
    for (const [, name, value] of body.matchAll(/--([\w-]+):\s*([^;]+);/g))
      tokens.set(name!, value!.trim());
  const hex = (name: string, depth = 0): string => {
    const value = tokens.get(name);
    if (!value || depth > 8) throw new Error(`--${name} does not resolve`);
    const reference = value.match(/^var\(--([\w-]+)\)$/);
    if (reference) return hex(reference[1]!, depth + 1);
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--${name} is not a hex colour`);
    return value;
  };
  return hex;
}

function luminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

/** `bg-x/10` over a surface: the tint StatusPill puts behind its own label. */
function tint(color: string, over: string, alpha: number) {
  return `#${[1, 3, 5]
    .map((offset) =>
      Math.round(
        parseInt(color.slice(offset, offset + 2), 16) * alpha +
          parseInt(over.slice(offset, offset + 2), 16) * (1 - alpha)
      )
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

describe('Daily work pack contrast (DEV-601)', () => {
  it('renders readable copy only in contrast-checked text tokens', () => {
    expect(component).not.toContain('text-text-faint');
    expect(component).not.toContain('text-muted-foreground');
    // No opacity-dimmed text, e.g. `text-text-muted/60` (§3).
    expect(component).not.toMatch(/\btext-[\w-]+\/\d+/);
    const tokens = new Set(component.match(/\btext-text-[\w-]+/g));
    expect([...tokens].sort()).toEqual(['text-text-body', 'text-text-muted', 'text-text-strong']);
  });

  it.each([
    ['light', false],
    ['dark', true],
  ])('holds 4.5:1 for every work-pack text token on its surfaces (%s)', (_, dark) => {
    const hex = theme(dark);
    // Card body, the note's sunken panel, raised controls and the neutral pill's muted fill.
    const surfaces = ['surface-card', 'surface-sunken', 'surface-raised', 'muted'];
    for (const text of ['text-strong', 'text-body', 'text-muted'])
      for (const surface of surfaces)
        expect(contrast(hex(text), hex(surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(
          4.5
        );
    for (const tone of ['warning', 'destructive', 'primary'])
      expect(
        contrast(hex(tone), tint(hex(tone), hex('surface-card'), 0.1)),
        `${tone} pill`
      ).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the disabled Refresh control discernible at full opacity', () => {
    const markup = renderToStaticMarkup(<DailyWorkPackLoading />);
    const button = markup.match(/<button[^>]*>/)![0];
    expect(button).toMatch(/\bdisabled\b/);
    expect(button).toContain('disabled:opacity-100');
    expect(button).not.toContain('disabled:opacity-50');
    expect(button).toContain('disabled:text-text-muted');
    expect(button).toContain('disabled:bg-surface-sunken');
    const dark = theme(true);
    expect(contrast(dark('text-muted'), dark('surface-sunken'))).toBeGreaterThanOrEqual(4.5);
  });
});
