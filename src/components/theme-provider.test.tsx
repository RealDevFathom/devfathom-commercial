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

function studioTokens(selector: ':root' | "[data-theme='dark']") {
  const css = readFileSync('src/app/globals.css', 'utf8');
  const pattern = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`,
    'g'
  );
  const blocks = [...css.matchAll(pattern)];
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
    const tokens = studioTokens("[data-theme='dark']");

    for (const foreground of ['text-muted', 'text-faint']) {
      for (const background of ['surface-page', 'surface-card', 'surface-raised', 'secondary']) {
        expect(
          contrast(tokens[foreground], tokens[background]),
          `${foreground} on ${background}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps small section labels at WCAG AA contrast independently of tenant accents', () => {
    const css = readFileSync('src/app/globals.css', 'utf8');

    expect(css).toMatch(/\.eyebrow-accent\s*\{[^}]*color:\s*var\(--text-muted\)/);

    for (const selector of [':root', "[data-theme='dark']"] as const) {
      const tokens = studioTokens(selector);

      for (const background of [
        'surface-page',
        'surface-card',
        'surface-sunken',
        'surface-raised',
      ]) {
        expect(
          contrast(tokens['text-muted'], tokens[background]),
          `${selector} text-muted on ${background}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
