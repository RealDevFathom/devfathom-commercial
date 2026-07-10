'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'theme';
const DEFAULT_THEME = 'light';
const THEMES = ['light', 'dark'] as const;

export type Theme = (typeof THEMES)[number];

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: Theme;
  themes: readonly Theme[];
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Start from the server's light default, then reconcile after hydration. The
  // root layout's beforeInteractive script applies a saved theme before paint.
  const [theme, setCurrentTheme] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    const syncStoredTheme = () => {
      const nextTheme = readStoredTheme();
      setCurrentTheme(nextTheme);
      applyTheme(nextTheme);
    };

    syncStoredTheme();
    window.addEventListener('storage', syncStoredTheme);
    return () => window.removeEventListener('storage', syncStoredTheme);
  }, []);

  const setTheme = useCallback((nextTheme: Theme) => {
    if (!THEMES.includes(nextTheme)) return;
    setCurrentTheme(nextTheme);
    applyTheme(nextTheme);
    try {
      localStorage.setItem(STORAGE_KEY, nextTheme);
    } catch {
      // The selected theme remains applied for this session if storage is unavailable.
    }
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme: theme, themes: THEMES, setTheme }),
    [setTheme, theme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider.');
  }
  return context;
}
