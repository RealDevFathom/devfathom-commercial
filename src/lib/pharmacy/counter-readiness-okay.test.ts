import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acknowledgedReadinessReasons,
  clearCounterReadinessOkay,
  counterReadinessOkayKey,
  readCounterReadinessOkay,
  subscribeCounterReadinessOkay,
  writeCounterReadinessOkay,
} from './counter-readiness-okay';

/** DEV-970: the counter's Okay is kept per person, branch and computer for the session. */
describe('counter readiness Okay', () => {
  const scope = {
    organizationId: 'org-a',
    accountId: 'account-a',
    branchId: 'branch-a',
    deviceId: 'counter-1',
  };
  const key = counterReadinessOkayKey(scope);

  beforeEach(() => {
    clearCounterReadinessOkay();
    window.sessionStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('keys on organisation, person, branch and computer', () => {
    const others = [
      { ...scope, organizationId: 'org-b' },
      { ...scope, accountId: 'account-b' },
      { ...scope, branchId: 'branch-b' },
      { ...scope, deviceId: 'counter-2' },
      { ...scope, deviceId: null },
    ].map(counterReadinessOkayKey);
    expect(new Set([key, ...others]).size).toBe(6);
  });

  it('keeps the acknowledged reasons sorted and once each, in sessionStorage', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCounterReadinessOkay(listener);
    writeCounterReadinessOkay(key, ['PROFILE_MISSING', 'LICENCE_INVALID', 'PROFILE_MISSING']);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(window.sessionStorage.getItem(key)).toBe('["LICENCE_INVALID","PROFILE_MISSING"]');
    expect(acknowledgedReadinessReasons(readCounterReadinessOkay(key))).toEqual([
      'LICENCE_INVALID',
      'PROFILE_MISSING',
    ]);
    writeCounterReadinessOkay(key, null);
    expect(readCounterReadinessOkay(key)).toBeNull();
  });

  it('reads anything unexpected as no Okay', () => {
    expect(acknowledgedReadinessReasons(null)).toBeNull();
    expect(acknowledgedReadinessReasons('not json')).toBeNull();
    expect(acknowledgedReadinessReasons('{"a":1}')).toBeNull();
    expect(acknowledgedReadinessReasons('[1]')).toBeNull();
  });

  it('holds the Okay for this page when storage refuses it, without throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(() => writeCounterReadinessOkay(key, ['PROFILE_MISSING'])).not.toThrow();
    expect(acknowledgedReadinessReasons(readCounterReadinessOkay(key))).toEqual([
      'PROFILE_MISSING',
    ]);
    expect(() => clearCounterReadinessOkay()).not.toThrow();
    expect(readCounterReadinessOkay(key)).toBeNull();
  });

  it('forgets every Okay on clear, and nothing else', () => {
    writeCounterReadinessOkay(key, ['PROFILE_MISSING']);
    writeCounterReadinessOkay(counterReadinessOkayKey({ ...scope, branchId: 'branch-b' }), [
      'LICENCE_INVALID',
    ]);
    window.sessionStorage.setItem('devfathom.pharmacy.day-close.v1:x', 'draft');
    clearCounterReadinessOkay();
    expect(readCounterReadinessOkay(key)).toBeNull();
    expect(window.sessionStorage.length).toBe(1);
    expect(window.sessionStorage.getItem('devfathom.pharmacy.day-close.v1:x')).toBe('draft');
  });
});
