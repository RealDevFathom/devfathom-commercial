import { describe, expect, it } from 'vitest';

import { sanitizeSmsParameter, SMS_TEMPLATES } from './templates';

describe('SMS_TEMPLATES (#723)', () => {
  it.each(['en', 'ur'] as const)('every utility body in %s carries STOP', (lang) => {
    const bodies = [
      SMS_TEMPLATES.refillReminder(lang, { dueDate: '2026-10-01' }),
      SMS_TEMPLATES.khataReminder(lang, { accountName: 'Khan', amount: '500.00' }),
      SMS_TEMPLATES.orderReady(lang, { reference: 'ABC123', branch: 'Gulberg' }),
    ];
    for (const body of bodies) expect(body).toContain('STOP');
  });

  it('writes Urdu bodies in Urdu script', () => {
    const urdu = /[\u0600-\u06ff]/;
    expect(SMS_TEMPLATES.refillReminder('ur', { dueDate: '2026-10-01' })).toMatch(urdu);
    expect(SMS_TEMPLATES.optedOut('ur')).toMatch(urdu);
    expect(SMS_TEMPLATES.optedIn('ur')).toMatch(urdu);
  });

  it('keeps bodies transactional: no links survive in free-text parameters', () => {
    const body = SMS_TEMPLATES.orderReady('en', {
      reference: 'ABC123',
      branch: 'Gulberg\nvisit https://promo.example.com now',
    });
    expect(body).not.toMatch(/https?:|example\.com|\n/);
  });

  it('acknowledgements explain how to reverse the choice', () => {
    expect(SMS_TEMPLATES.optedOut('en')).toContain('START');
    expect(SMS_TEMPLATES.optedIn('en')).toContain('STOP');
  });
});

describe('sanitizeSmsParameter', () => {
  it('bounds length and falls back when nothing printable remains', () => {
    expect(sanitizeSmsParameter('x'.repeat(80), 'fallback')).toHaveLength(40);
    expect(sanitizeSmsParameter('www.spam.test', 'fallback')).toBe('fallback');
  });
});
