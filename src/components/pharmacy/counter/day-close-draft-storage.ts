/**
 * Draft day-close reconciliation fields survive a full route remount (DEV-754).
 * sessionStorage keeps the same-tab hard reload / navigate-away-and-back case
 * without writing cash counts to durable disk across sessions.
 *
 * Confirmed-checkbox is deliberately not stored: the operator must re-confirm
 * after remount before locking the day.
 */
export type DayCloseDraft = {
  counts: Record<string, string>;
  note: string;
};

export type DayCloseDraftScope = {
  organizationId: string;
  userId: string;
  branchId: string;
  businessDate: string;
};

const PREFIX = 'devfathom.pharmacy.day-close.draft:';

export function dayCloseDraftStorageKey(scope: DayCloseDraftScope): string {
  return `${PREFIX}${scope.organizationId}:${scope.userId}:${scope.branchId}:${scope.businessDate}`;
}

function isCounts(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([k, v]) => typeof k === 'string' && k.length > 0 && k.length <= 128 && typeof v === 'string' && v.length <= 32
  );
}

export function readDayCloseDraft(scope: DayCloseDraftScope): DayCloseDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(dayCloseDraftStorageKey(scope));
    if (!raw || raw.length > 8192) return null;
    const parsed = JSON.parse(raw) as { counts?: unknown; note?: unknown };
    if (!isCounts(parsed.counts) || typeof parsed.note !== 'string' || parsed.note.length > 1000) {
      return null;
    }
    return { counts: parsed.counts, note: parsed.note };
  } catch {
    return null;
  }
}

export function writeDayCloseDraft(scope: DayCloseDraftScope, draft: DayCloseDraft): void {
  if (typeof window === 'undefined') return;
  try {
    if (!isCounts(draft.counts) || typeof draft.note !== 'string' || draft.note.length > 1000) return;
    window.sessionStorage.setItem(dayCloseDraftStorageKey(scope), JSON.stringify(draft));
  } catch {
    /* private mode / quota — draft is best-effort */
  }
}

export function clearDayCloseDraft(scope: DayCloseDraftScope): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(dayCloseDraftStorageKey(scope));
  } catch {
    /* ignore */
  }
}
