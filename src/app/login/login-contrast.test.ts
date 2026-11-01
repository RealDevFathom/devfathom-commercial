import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * QA: the sign-in helper text and the PHARMACY tag must clear WCAG AA (4.5:1)
 * in light and dark themes. Reads the effective (last-declared) Studio tokens.
 */
const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

function lastBlock(selector: string): string {
  // Escape every regular-expression metacharacter, backslash included.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- fixed token names in a test
  const pattern = new RegExp(`(^|\\n)${escaped} \\{([^}]*)\\}`, 'g');
  const blocks = [...css.matchAll(pattern)].map((match) => match[2]!);
  expect(blocks.length).toBeGreaterThan(0);
  return blocks.at(-1)!;
}

function token(block: string, name: string): string {
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- fixed token names in a test
  const value = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  expect(value, `--${name}`).toBeDefined();
  return value!;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

describe('sign-in contrast (WCAG AA 4.5:1)', () => {
  it.each([
    ['light', ':root'],
    ['dark', "[data-theme='dark']"],
  ])('helper text and the mobile PHARMACY tag clear AA on the %s page', (_theme, selector) => {
    const block = lastBlock(selector);
    const ratio = contrast(token(block, 'text-body'), token(block, 'surface-page'));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['light', ':root'],
    ['dark', "[data-theme='dark']"],
  ])('the hero PHARMACY tag clears AA on the ink hero in %s', (_theme, selector) => {
    const ratio = contrast(token(lastBlock(selector), 'text-on-accent'), '#111110');
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('uses those tokens for the helper text and both PHARMACY tags', () => {
    expect(source('src/app/login/page.tsx')).toMatch(/text-xs leading-6 text-text-body/);
    expect(source('src/components/auth/auth-shell.tsx')).toMatch(
      /tracking-\[0\.18em\] text-text-body/
    );
    expect(source('src/app/login/login-hero.tsx')).toMatch(
      /tracking-\[0\.16em\] text-text-on-accent">\s*\{copy\.tag\}/
    );
  });
});
