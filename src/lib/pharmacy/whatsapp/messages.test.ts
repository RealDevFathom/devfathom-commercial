import { describe, expect, it } from 'vitest';

import { consentKeyword } from './messages';

describe('consent keywords', () => {
  it.each(['STOP REFILL', 'stop refill', ' Stop  Refill! ', 'STOP REFILLS'])(
    '%j is the refill-only opt-out, not the customer-wide STOP',
    (text) => {
      expect(consentKeyword(text)).toBe('STOP_REFILL');
    }
  );

  it.each([
    ['STOP', 'STOP'],
    ['stop all', 'STOP'],
    ['بند کریں', 'STOP'],
    ['START', 'START'],
    ['stop refill please', null],
    ['Panadol 2 packs', null],
  ])('%j -> %s', (text, keyword) => {
    expect(consentKeyword(text)).toBe(keyword);
  });
});
