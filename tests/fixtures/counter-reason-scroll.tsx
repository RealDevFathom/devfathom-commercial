import { tenderAttemptStorageKey } from '@/components/pharmacy/counter/tender-attempt-storage';
import { createRoot } from 'react-dom/client';
import { PharmacyCounterConsole } from '@/components/pharmacy/counter/counter-console';

// Same bounded, overflow-hidden ancestor geometry as the Counter lane in AppShell.
// Session and query data are isolated synthetic fixtures, not an authenticated route.
createRoot(document.getElementById('root')!).render(
  <div className="studio-viewport h-dvh overflow-hidden">
    <div className="studio-shell flex h-full min-w-0 flex-col overflow-hidden">
      <div className="flex h-16 shrink-0 items-center px-4">Synthetic workspace</div>
      <main className="studio-canvas relative min-h-0 flex-1 overflow-hidden">
        <div className="h-full max-w-none overflow-hidden">
          <PharmacyCounterConsole
            initialSaleId="synthetic-sale"
            initialBranchId="synthetic-branch"
          />
        </div>
      </main>
    </div>
  </div>
);

// Exercise the real storage-recovery listener with this fixture's synthetic scope.
const key = tenderAttemptStorageKey({
  organizationId: 'synthetic-org',
  accountId: 'synthetic-user',
  branchId: 'synthetic-branch',
});
window.addEventListener('fixture:recovery', () => {
  localStorage.setItem(key, '{');
  window.dispatchEvent(new StorageEvent('storage', { key }));
});
window.addEventListener('fixture:restore-storage', () => {
  localStorage.removeItem(key);
  window.dispatchEvent(new StorageEvent('storage', { key }));
});
