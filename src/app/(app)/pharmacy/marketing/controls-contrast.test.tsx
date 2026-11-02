import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { actionButton, inputControl, nativeControl } from './controls';

/**
 * DEV-601: in dark mode the "Get a generic AI draft" controls and the disabled
 * "Save draft" form were barely visible. Readable text holds 4.5:1, control
 * boundaries 3:1 (WCAG 1.4.3 / 1.4.11, DEVFATHOM-STUDIO.md §3 and §9), measured
 * from the Studio tokens in globals.css for both themes.
 */
const css = readFileSync(resolve(__dirname, '../../../globals.css'), 'utf8');
const studio = css.slice(css.indexOf('DEVFATHOM STUDIO'));
const block = (selector: string) => {
  const start = studio.indexOf(selector);
  return studio.slice(start, studio.indexOf('}', start));
};
const themes = { light: block(':root {'), dark: block("[data-theme='dark']") };

function hex(name: string, theme: string): string {
  const match = theme.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!match) throw new Error(`--${name} not found`);
  return match[1]!;
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

const surfaces = ['surface-card', 'surface-raised', 'surface-sunken'];
const marketingSources = readdirSync(__dirname)
  .filter((file) => /\.tsx?$/.test(file) && !file.includes('.test.'))
  .map((file) => [file, readFileSync(join(__dirname, file), 'utf8')] as const);

describe('marketing controls stay readable in both themes (DEV-601)', () => {
  it.each(Object.entries(themes))(
    '%s: control boundaries hold 3:1 and control text 4.5:1',
    (_, theme) => {
      const muted = hex('text-muted', theme);
      // The outline of every enabled and disabled control, against the card it sits on and
      // the raised or sunken fill inside it.
      for (const surface of surfaces)
        expect(contrast(muted, hex(surface, theme)), surface).toBeGreaterThanOrEqual(3);
      // A disabled control's value and label text: muted on the sunken fill.
      expect(contrast(muted, hex('surface-sunken', theme))).toBeGreaterThanOrEqual(4.5);
      // Enabled values and the AI draft copy.
      for (const text of ['text-strong', 'text-body'])
        expect(contrast(hex(text, theme), hex('surface-card', theme))).toBeGreaterThanOrEqual(4.5);
      // Why the outline is not a border token: none reaches 3:1 on a dark card.
      expect(
        contrast(hex('border-strong', themes.dark), hex('surface-card', themes.dark))
      ).toBeLessThan(3);
    }
  );

  it('uses the contrast-checked boundary and keeps disabled controls at full opacity', () => {
    for (const recipe of [nativeControl, inputControl])
      expect(recipe).toMatch(/(^| )border-text-muted( |$)/);
    for (const recipe of [nativeControl, inputControl, actionButton]) {
      expect(recipe).toContain('disabled:opacity-100');
      expect(recipe).toContain('disabled:text-text-muted');
      expect(recipe).toContain('disabled:bg-surface-sunken');
    }
    expect(actionButton).toContain('disabled:border-text-muted');
  });

  it('overrides the shared fade-to-50% and the low-contrast input border when rendered', () => {
    render(
      <>
        <label>
          Campaign name
          <Input className={inputControl} disabled />
        </label>
        <Button className={actionButton} disabled>
          Save draft
        </Button>
      </>
    );
    const input = screen.getByLabelText('Campaign name');
    const button = screen.getByRole('button', { name: 'Save draft' });
    for (const element of [input, button]) {
      expect(element.className).not.toContain('disabled:opacity-50');
      expect(element.className).toContain('disabled:opacity-100');
    }
    expect(input.className).not.toMatch(/(^| )border-input( |$)/);
    expect(input.className).not.toContain('dark:disabled:bg-input/80');
    expect(input).toBeDisabled();
    expect(button).toBeDisabled();
  });

  it.each(marketingSources)(
    '%s keeps readable text off faint and opacity-dimmed tokens',
    (_, source) => {
      expect(source).not.toContain('text-text-faint');
      expect(source).not.toMatch(/text-(text-[a-z]+|muted-foreground|foreground)\/\d+/);
      expect(source).not.toMatch(/(^|[\s'"])border-input([\s'"]|$)/);
    }
  );
});
