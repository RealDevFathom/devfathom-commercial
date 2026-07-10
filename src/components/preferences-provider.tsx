'use client';

import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';

/* ============================================================
   PreferencesProvider — the five configurable surface toggles
   ("The Sounding" design revamp, spec §6).

   These are the *non-theme* surface attributes. `data-theme`
   (light|dark) is owned by ThemeProvider; this provider owns the
   remaining five, each mirrored to a `data-*` attribute on
   <html> that globals.css reacts to (density/type/accent) or
   that components read (layout/icons).

   localStorage (key `devfathom-prefs`) is the source of truth.
   An inline <head> script in layout.tsx applies the attributes
   pre-paint to avoid FOUC. Here we read that same store via
   useSyncExternalStore so SSR + hydration use defaults (no
   mismatch) and the client reconciles to the persisted values
   right after hydration — and stays in sync across tabs.
   ============================================================ */

export type Density = 'default' | 'compact';
export type TypeScale = 'default' | 'lg';
export type Accent = 'quiet' | 'bold';
export type Layout = 'rail' | 'top';
export type Icons = 'numeric' | 'architectural';

export interface Preferences {
  density: Density;
  type: TypeScale;
  accent: Accent;
  layout: Layout;
  icons: Icons;
}

export const DEFAULT_PREFERENCES: Preferences = {
  density: 'default',
  type: 'default',
  accent: 'quiet',
  layout: 'rail',
  icons: 'numeric',
};

/** localStorage key shared with the inline FOUC script in layout.tsx. */
export const PREFERENCES_STORAGE_KEY = 'devfathom-prefs';

export interface PreferencesContextValue extends Preferences {
  /** Update a single preference: store + localStorage + <html> attribute. */
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  /** Bulk update several preferences at once. */
  setPreferences: (partial: Partial<Preferences>) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

// Allow-list so a tampered/legacy/forward-compat localStorage blob can never
// push a bogus value onto an <html> attribute.
const ALLOWED: { [K in keyof Preferences]: readonly Preferences[K][] } = {
  density: ['default', 'compact'],
  type: ['default', 'lg'],
  accent: ['quiet', 'bold'],
  layout: ['rail', 'top'],
  icons: ['numeric', 'architectural'],
};

const PREFERENCE_KEYS = Object.keys(ALLOWED) as (keyof Preferences)[];

/** Keep only known keys whose value is in the allow-list. */
function sanitize(raw: unknown): Partial<Preferences> {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const out: Partial<Preferences> = {};
  for (const key of PREFERENCE_KEYS) {
    const value = source[key];
    const allowed = ALLOWED[key] as readonly string[];
    if (typeof value === 'string' && allowed.includes(value)) {
      (out as Record<string, string>)[key] = value;
    }
  }
  return out;
}

function applyAttribute<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute(`data-${key}`, value);
}

/* --- external store (localStorage-backed) -------------------- */

function readFromStorage(): Preferences {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    return { ...DEFAULT_PREFERENCES, ...sanitize(raw ? JSON.parse(raw) : null) };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

// Cached snapshot — useSyncExternalStore requires a referentially-stable value
// between changes. Lazily hydrated from localStorage on the first client read.
let snapshot: Preferences = DEFAULT_PREFERENCES;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function getSnapshot(): Preferences {
  if (!hydrated) {
    snapshot = readFromStorage();
    hydrated = true;
  }
  return snapshot;
}

// SSR + the initial hydration render use defaults so server and client markup
// match; React then reconciles to getSnapshot() after hydration.
function getServerSnapshot(): Preferences {
  return DEFAULT_PREFERENCES;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Keep other tabs in sync.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PREFERENCES_STORAGE_KEY) return;
    snapshot = readFromStorage();
    hydrated = true;
    for (const key of PREFERENCE_KEYS) applyAttribute(key, snapshot[key]);
    emit();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function commit(next: Preferences) {
  snapshot = next;
  hydrated = true;
  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota — attributes + in-memory store still apply.
  }
  for (const key of PREFERENCE_KEYS) applyAttribute(key, next[key]);
  emit();
}

function setPreferenceImpl<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  commit({ ...getSnapshot(), [key]: value });
}

function setPreferencesImpl(partial: Partial<Preferences>) {
  commit({ ...getSnapshot(), ...sanitize(partial) });
}

/* --- provider + hook ----------------------------------------- */

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const value = useMemo<PreferencesContextValue>(
    () => ({ ...prefs, setPreference: setPreferenceImpl, setPreferences: setPreferencesImpl }),
    [prefs]
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) {
    throw new Error('usePreferences must be used within a <PreferencesProvider>');
  }
  return ctx;
}
