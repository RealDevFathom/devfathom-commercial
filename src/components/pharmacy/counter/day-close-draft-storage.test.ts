import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllDayCloseDrafts,
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
    expect(readDayCloseDraft({ ...scope, branchId: 'other' })).toBeNull();
    expect(readDayCloseDraft({ ...scope, businessDate: '2026-11-05' })).toBeNull();
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

  it('isolates drafts across organization and user (a shared counter browser)', () => {
    writeDayCloseDraft(scope, { counts: { d: '10.00' }, note: 'owner note' });
    expect(readDayCloseDraft({ ...scope, userId: 'manager' })).toBeNull();
    expect(readDayCloseDraft({ ...scope, organizationId: 'other-org' })).toBeNull();
    expect(readDayCloseDraft(scope)).toEqual({ counts: { d: '10.00' }, note: 'owner note' });
  });

  it('clears every user’s drafts, and nothing else, on demand', () => {
    writeDayCloseDraft(scope, { counts: { d: '10.00' }, note: '' });
    writeDayCloseDraft({ ...scope, userId: 'manager', branchId: 'a' }, { counts: {}, note: 'x' });
    window.sessionStorage.setItem('unrelated', 'kept');
    clearAllDayCloseDrafts();
    expect(readDayCloseDraft(scope)).toBeNull();
    expect(readDayCloseDraft({ ...scope, userId: 'manager', branchId: 'a' })).toBeNull();
    expect(window.sessionStorage.getItem('unrelated')).toBe('kept');
  });
});
