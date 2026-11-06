import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearDayCloseDraft,
  dayCloseDraftStorageKey,
  readDayCloseDraft,
  writeDayCloseDraft,
} from './day-close-draft-storage';

const scope = {
  organizationId: 'org',
  userId: 'owner',
  branchId: 'b',
  businessDate: '2026-11-06',
};

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe('day-close draft storage', () => {
  it('keys drafts by org, user, branch and business date', () => {
    expect(dayCloseDraftStorageKey(scope)).toBe(
      'devfathom.pharmacy.day-close.draft:org:owner:b:2026-11-06'
    );
  });

  it('round-trips counted cash and variance note', () => {
    writeDayCloseDraft(scope, { counts: { d: '12.34' }, note: 'short' });
    expect(readDayCloseDraft(scope)).toEqual({ counts: { d: '12.34' }, note: 'short' });
  });

  it('isolates drafts across branch or day', () => {
    writeDayCloseDraft(scope, { counts: { d: '12.34' }, note: '' });
    expect(
      readDayCloseDraft({ ...scope, branchId: 'other' })
    ).toBeNull();
    expect(
      readDayCloseDraft({ ...scope, businessDate: '2026-11-05' })
    ).toBeNull();
  });

  it('rejects corrupt or oversized payloads', () => {
    window.sessionStorage.setItem(dayCloseDraftStorageKey(scope), '{not-json');
    expect(readDayCloseDraft(scope)).toBeNull();
    window.sessionStorage.setItem(
      dayCloseDraftStorageKey(scope),
      JSON.stringify({ counts: { d: 12 }, note: 'x' })
    );
    expect(readDayCloseDraft(scope)).toBeNull();
  });

  it('clears a saved draft', () => {
    writeDayCloseDraft(scope, { counts: { d: '1.00' }, note: '' });
    clearDayCloseDraft(scope);
    expect(readDayCloseDraft(scope)).toBeNull();
  });
});
