import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * DEV-325 (#340) and DEV-329 (#334): sign-in placeholders, the "or password"
 * divider and the platform command-form help text rendered in `--text-faint`
 * (#a3a39e on #ffffff, 2.53:1). Readable text on these forms uses
 * `--text-muted`, the token DEVFATHOM-STUDIO.md §3 contrast-checks for text.
 */
const root = resolve(__dirname, '../..');
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');

const AUTH_FORMS = [
  'src/app/login/login-form.tsx',
  'src/app/login/shared-login-form.tsx',
  'src/app/forgot-password/forgot-password-form.tsx',
  'src/app/reset-password/[token]/reset-password-form.tsx',
  'src/app/invite/[token]/accept-invite-form.tsx',
  'src/app/platform/(auth)/login/platform-login-form.tsx',
];

function hex(name: string, block: string): string {
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!match) throw new Error(`--${name} not found`);
  return match[1];
}

function luminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

describe('sign-in and platform form text contrast', () => {
  it.each(AUTH_FORMS)('%s renders placeholders in the contrast-checked muted token', (path) => {
    const text = source(path);
    expect(text).not.toContain('placeholder:text-text-faint');
    expect(text).toContain('placeholder:text-text-muted');
  });

  it('keeps visible sign-in labels and the divider off the faint token', () => {
    for (const path of ['src/app/login/login-form.tsx', 'src/app/login/shared-login-form.tsx']) {
      const faintText = source(path)
        .split('\n')
        .filter((line) => line.includes('text-text-faint') && !/<[A-Z]\w*\s/.test(line));
      expect(faintText, path).toEqual([]);
    }
  });

  it('renders platform command-form help in the muted token', () => {
    const form = source('src/components/platform/platform-command-form.tsx');
    expect(form).toMatch(/\{field\.help \? \(\s*<span className="[^"]*text-text-muted[^"]*">/);
    expect(form).not.toContain('text-text-faint');
  });

  it('holds 4.5:1 for the muted token on Studio card and sunken surfaces in both themes', () => {
    const css = source('src/app/globals.css');
    const light = css.slice(css.indexOf('DEVFATHOM STUDIO'));
    const lightRoot = light.slice(
      light.indexOf(':root {'),
      light.indexOf('}', light.indexOf(':root {'))
    );
    const darkStart = light.indexOf("[data-theme='dark']");
    const dark = light.slice(darkStart, light.indexOf('}', darkStart));

    for (const block of [lightRoot, dark]) {
      const muted = hex('text-muted', block);
      for (const surface of ['surface-card', 'surface-sunken']) {
        expect(contrast(muted, hex(surface, block))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
