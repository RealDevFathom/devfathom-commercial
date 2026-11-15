import { z } from '@/lib/zod-csp';

const draftSchema = z
  .object({
    counts: z.record(z.string(), z.string()),
    note: z.string().max(1000),
  })
  .strict();

export type DayCloseDraft = z.infer<typeof draftSchema>;

export const DAY_CLOSE_DRAFT_WARNING =
  'Draft recovery is unavailable. Leaving this page may discard your count and variance note.';

export function dayCloseDraftKey(
  organizationId: string,
  accountId: string,
  branchId: string,
  date: string
) {
  return `devfathom.pharmacy.day-close.v1:${JSON.stringify([organizationId, accountId, branchId, date])}`;
}

export function readDayCloseDraft(key: string): { draft: DayCloseDraft; warning: string } {
  try {
    const raw = window.sessionStorage.getItem(key);
    return {
      draft: raw === null ? { counts: {}, note: '' } : draftSchema.parse(JSON.parse(raw)),
      warning: '',
    };
  } catch {
    return { draft: { counts: {}, note: '' }, warning: DAY_CLOSE_DRAFT_WARNING };
  }
}

export function saveDayCloseDraft(key: string, draft: DayCloseDraft): string {
  try {
    const raw = JSON.stringify(draft);
    window.sessionStorage.setItem(key, raw);
    if (window.sessionStorage.getItem(key) !== raw) return DAY_CLOSE_DRAFT_WARNING;
    return '';
  } catch {
    return DAY_CLOSE_DRAFT_WARNING;
  }
}

export function clearDayCloseDraft(key: string) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // A recorded server close remains authoritative if browser storage is blocked.
  }
}
