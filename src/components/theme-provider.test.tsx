import { readFileSync } from 'node:fs';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider, useTheme } from './theme-provider';

function luminance(hex: string) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function tint(foreground: string, background: string, opacity: number) {
  const channels = [foreground, background].map((hex) =>
    hex
      .slice(1)
      .match(/.{2}/g)!
      .map((channel) => Number.parseInt(channel, 16))
  );

  return `#${channels[0]
    .map((channel, index) =>
      Math.round(channel * opacity + channels[1][index] * (1 - opacity))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

function studioTokens(theme: 'light' | 'dark') {
  const css = readFileSync('src/app/globals.css', 'utf8');
  const selector = theme === 'dark' ? "\\[data-theme='dark'\\]" : ':root';
  const blocks = [...css.matchAll(new RegExp(`${selector}\\s*\\{([^}]+)\\}`, 'g'))];
  const declarations = blocks.at(-1)?.[1] ?? '';

  return Object.fromEntries(
    [...declarations.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map((match) => [match[1], match[2]])
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.colorScheme = '';
  });

  it('exposes the information token to Tailwind utilities', () => {
    const css = readFileSync('src/app/globals.css', 'utf8');

    expect(css).toMatch(/--color-info:\s*var\(--info\);/);
  });

  it('applies theme tokens atomically while CSS transitions are disabled', () => {
    const originalSetAttribute = document.documentElement.setAttribute.bind(
      document.documentElement
    );
    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    const setAttribute = vi.spyOn(document.documentElement, 'setAttribute');
    setAttribute.mockImplementation((name, value) => {
      expect(document.head.querySelector('[data-theme-transition-guard]')).not.toBeNull();
      originalSetAttribute(name, value);
    });

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    const getComputedStyle = vi.spyOn(window, 'getComputedStyle');
    getComputedStyle.mockImplementation((element) => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
      expect(document.head.querySelector('[data-theme-transition-guard]')).not.toBeNull();
      return originalGetComputedStyle(element);
    });
    act(() => result.current.setTheme('dark'));

    expect(getComputedStyle).toHaveBeenCalledWith(document.documentElement);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.head.querySelector('[data-theme-transition-guard]')).toBeNull();
  });

  it('keeps dark secondary text at WCAG AA contrast on Studio surfaces', () => {
    const tokens = studioTokens('dark');

    for (const foreground of ['text-muted', 'text-faint']) {
      for (const background of ['surface-page', 'surface-card', 'surface-raised', 'secondary']) {
        expect(
          contrast(tokens[foreground], tokens[background]),
          `${foreground} on ${background}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(['light', 'dark'] as const)(
    'keeps %s info status text at WCAG AA contrast on Studio surfaces',
    (theme) => {
      const tokens = studioTokens(theme);

      for (const surface of ['surface-page', 'surface-card', 'surface-raised', 'secondary']) {
        const infoTint = tint(tokens.info, tokens[surface], 0.1);

        expect(contrast(tokens.info, infoTint), `info on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  );
});
