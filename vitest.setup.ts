import '@testing-library/jest-dom/vitest';

// Node 25 ships experimental WebStorage globals (localStorage, sessionStorage,
// Storage). Vitest's jsdom environment does not overwrite globals Node already
// defines, so tests would see Node's non-functional storage instead of jsdom's.
// Reinstall jsdom's Storage so window.localStorage and Storage.prototype spies
// behave as in a browser, without requiring --no-experimental-webstorage.
const jsdomWindow = (globalThis as { jsdom?: { window: typeof globalThis } }).jsdom?.window;

if (jsdomWindow && globalThis.localStorage !== jsdomWindow.localStorage) {
  for (const key of ['Storage', 'localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: true,
      get: () => jsdomWindow[key],
    });
  }
}
