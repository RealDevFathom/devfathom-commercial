'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

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

type ThemeStore = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => Theme;
  setTheme: (theme: Theme) => void;
  restore: () => void;
};

const ThemeContext = createContext<ThemeStore | undefined>(undefined);
const getServerSnapshot = (): Theme => DEFAULT_THEME;
const subscribeWithoutProvider = () => () => {};

function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function applyTheme(theme: Theme) {
  const transitionGuard = document.createElement('style');
  transitionGuard.dataset.themeTransitionGuard = '';
  transitionGuard.textContent = '*,*::before,*::after{transition:none!important}';
  document.head.appendChild(transitionGuard);

  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;

  // Commit the new token values while transitions are disabled so foregrounds
  // and surfaces cannot expose cross-theme intermediate colors.
  window.getComputedStyle(root).getPropertyValue('--surface-page');
  transitionGuard.remove();
}

function createThemeStore(): ThemeStore {
  let theme: Theme = DEFAULT_THEME;
  const listeners = new Set<() => void>();
  const update = (nextTheme: Theme) => {
    const changed = theme !== nextTheme;
    theme = nextTheme;
    applyTheme(nextTheme);
    if (changed) for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => theme,
    restore: () => update(readStoredTheme()),
    setTheme: (nextTheme) => {
      if (!THEMES.includes(nextTheme)) return;
      update(nextTheme);
      try {
        localStorage.setItem(STORAGE_KEY, nextTheme);
      } catch {
        // The selected theme remains applied if storage is unavailable.
      }
    },
  };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // A stable, provider-local store avoids changing context above pending server
  // boundaries. Consumers reconcile independently when their HTML hydrates.
  const [store] = useState(createThemeStore);
  useEffect(() => {
    store.restore();
    window.addEventListener('storage', store.restore);
    return () => window.removeEventListener('storage', store.restore);
  }, [store]);
  return <ThemeContext.Provider value={store}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const store = useContext(ThemeContext);
  const theme = useSyncExternalStore(
    store?.subscribe ?? subscribeWithoutProvider,
    store?.getSnapshot ?? getServerSnapshot,
    getServerSnapshot
  );
  const value = useMemo(
    () => store && { theme, resolvedTheme: theme, themes: THEMES, setTheme: store.setTheme },
    [store, theme]
  );
  if (!value) {
    throw new Error('useTheme must be used within ThemeProvider.');
  }
  return value;
}
