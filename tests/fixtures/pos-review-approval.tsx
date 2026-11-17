import { createRoot, type Root } from 'react-dom/client';
import { OrderPad } from '@/components/restaurant/pos/order-pad';
import { PosOfflineRuntime } from '@/lib/restaurant/pos-offline-runtime';
import {
  createIndexedDbDriver,
  POS_STORE_DATABASE_NAME,
  posScopeKey,
} from '@/lib/restaurant/pos-client-store';
import type { PosDraftInput } from '@/lib/restaurant/pos-command-queue';

// No replacement JSX, hook, queue, storage driver, or lock implementation.
// The runner supplies synthetic HTTP responses and drives a second runtime tab.
const scope = {
  organizationId: 'synthetic-organization',
  branchId: 'synthetic-branch',
  deviceId: 'synthetic-device',
};
const local = new PosOfflineRuntime(scope, createIndexedDbDriver());
const ready = local.hydrate();
let root: Root | undefined;
let releaseLock: (() => void) | undefined;
let held: Promise<unknown> | undefined;
let update: Promise<unknown> | undefined;

const fixture = {
  lockName: `${POS_STORE_DATABASE_NAME}:${posScopeKey(scope)}`,
  lockHeld: false,
  async seed(input: PosDraftInput) {
    await ready;
    const result = await local.enqueue(input);
    if (!result.ok) throw new Error(result.reason);
  },
  async cache(catalog: unknown) {
    await ready;
    await local.cacheCatalog(catalog, '2026-11-17T00:00:00Z');
  },
  async read() {
    await ready;
    await local.refresh();
    return local.snapshot();
  },
  mount() {
    root = createRoot(document.getElementById('root')!);
    root.render(<OrderPad />);
  },
  holdLock() {
    held = navigator.locks.request(fixture.lockName, async () => {
      fixture.lockHeld = true;
      await new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      fixture.lockHeld = false;
    });
  },
  startUpdate(catalog: unknown) {
    update = fixture.cache(catalog);
  },
  async releaseLock() {
    releaseLock?.();
    await held;
    await update;
  },
  close() {
    root?.unmount();
    local.close();
  },
};

declare global {
  interface Window {
    posReviewFixture: typeof fixture;
  }
}
window.posReviewFixture = fixture;
window.addEventListener('pagehide', () => fixture.close());
