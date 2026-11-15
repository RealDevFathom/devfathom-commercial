import { describe, expect, it } from 'vitest';

import {
  lintWhatsAppMessage,
  STATIC_MEDICINE_TERMS,
  WHATSAPP_LINTER_VERSION,
  whatsAppLintMessage,
} from './compliance-linter';

const catalogNames = ['zyrtecin', 'glowmax cream', 'panadol extra'];

describe('lintWhatsAppMessage', () => {
  it('passes generic utility and marketing copy', () => {
    for (const purpose of ['UTILITY', 'MARKETING'] as const)
      expect(
        lintWhatsAppMessage({
          purpose,
          template: 'Your balance of Rs 1,200 is due on 2026-11-20. Reply STOP to opt out.',
          variables: ['Khan Family', '1,200.00', '2026-11-20'],
          catalogNames,
        })
      ).toEqual({ outcome: 'PASS', reasons: [], linterVersion: WHATSAPP_LINTER_VERSION });
  });

  it.each([
    ['catalogue brand', 'Zyrtecin is in stock', 'CATALOG_MEDICINE_NAME', 'EXACT'],
    ['catalogue misspelling', 'Zyrtecen is in stock', 'CATALOG_MEDICINE_NAME', 'MISSPELLING'],
    ['digit substitution', 'Zyrt3cin is in stock', 'CATALOG_MEDICINE_NAME', 'EXACT'],
    ['repeated letters', 'Zyrteciiin is in stock', 'CATALOG_MEDICINE_NAME', 'EXACT'],
    ['catalogue phrase', 'Try Glowmax Cream today', 'CATALOG_MEDICINE_NAME', 'EXACT'],
    ['Urdu transliteration', 'زائرٹیسن دستیاب ہے', 'CATALOG_MEDICINE_NAME', 'TRANSLITERATION'],
    ['static salt', 'Paracetamol available', 'STATIC_MEDICINE_TERM', 'EXACT'],
    ['static misspelling', 'Amoxycillin available', 'STATIC_MEDICINE_TERM', 'MISSPELLING'],
    ['first-letter misspelling', 'Banadol in stock', 'STATIC_MEDICINE_TERM', 'MISSPELLING'],
    ['two-deletion misspelling', 'Paracetol in stock', 'STATIC_MEDICINE_TERM', 'MISSPELLING'],
    ['static category', 'All antibiotics in stock', 'STATIC_MEDICINE_TERM', 'EXACT'],
    ['Roman Urdu category', 'Apni dawai le jayen', 'STATIC_MEDICINE_TERM', 'EXACT'],
    ['Urdu-script category', 'آپ کی دوائی تیار ہے', 'STATIC_MEDICINE_TERM', 'EXACT'],
    ['Urdu-script static brand', 'پیناڈول دستیاب ہے', 'STATIC_MEDICINE_TERM', 'EXACT'],
    [
      'Urdu transliteration of a static salt',
      'بروفن دستیاب ہے',
      'STATIC_MEDICINE_TERM',
      'TRANSLITERATION',
    ],
  ])('blocks a %s in the template', (_label, template, code, match) => {
    const result = lintWhatsAppMessage({ purpose: 'MARKETING', template, catalogNames });
    expect(result.outcome).toBe('BLOCK');
    expect(result.reasons[0]).toMatchObject({ code, match, source: 'TEMPLATE', outcome: 'BLOCK' });
  });

  it('blocks an exact catalogue name that contains digits', () => {
    expect(
      lintWhatsAppMessage({
        purpose: 'MARKETING',
        template: 'CoQ10 in stock. Reply STOP.',
        catalogNames: ['CoQ10'],
      }).outcome
    ).toBe('BLOCK');
  });

  it('blocks a drug name in a send-time variable and reports its position, not its value', () => {
    const result = lintWhatsAppMessage({
      purpose: 'UTILITY',
      template: 'Hello {{1}}, your order is ready.',
      variables: ['Ali', 'Panadol Extra'],
      catalogNames,
    });
    expect(result.outcome).toBe('BLOCK');
    expect(result.reasons).toEqual([
      {
        code: 'CATALOG_MEDICINE_NAME',
        outcome: 'BLOCK',
        source: 'VARIABLE',
        index: 1,
        term: 'panadol extra',
        match: 'EXACT',
      },
    ]);
    expect(whatsAppLintMessage(result)).not.toMatch(/panadol/i);
  });

  it('warns on promotional wording in a utility message but not in marketing', () => {
    const template = 'Your order is ready. Get 20% off on your next visit!';
    expect(lintWhatsAppMessage({ purpose: 'UTILITY', template })).toMatchObject({
      outcome: 'WARN',
      reasons: [{ code: 'PROMOTIONAL_IN_UTILITY', outcome: 'WARN', source: 'TEMPLATE' }],
    });
    expect(lintWhatsAppMessage({ purpose: 'MARKETING', template }).outcome).toBe('PASS');
    expect(
      lintWhatsAppMessage({ purpose: 'UTILITY', template: 'Aaj mufte nahi, special riayat!' })
        .outcome
    ).toBe('WARN');
  });

  it('warns on health claims', () => {
    expect(
      lintWhatsAppMessage({ purpose: 'MARKETING', template: 'Guaranteed results. Reply STOP.' })
    ).toMatchObject({ outcome: 'WARN', reasons: [{ code: 'HEALTH_CLAIM' }] });
  });

  it('lets an optional intent classification add warnings but never clear a block', () => {
    expect(
      lintWhatsAppMessage({
        purpose: 'UTILITY',
        template: 'Your order is ready.',
        intent: { category: 'MARKETING', promotional: true },
      }).reasons.map((r) => r.code)
    ).toEqual(['INTENT_MISMATCH', 'PROMOTIONAL_IN_UTILITY']);
    expect(
      lintWhatsAppMessage({
        purpose: 'MARKETING',
        template: 'Zyrtecin is in stock',
        catalogNames,
        intent: { category: 'MARKETING' },
      }).outcome
    ).toBe('BLOCK');
  });

  it('does not treat ordinary words near a term as misspellings', () => {
    for (const template of [
      'Join our meditation morning',
      'Eid dawat at the store',
      'Visit our store today',
    ])
      expect(lintWhatsAppMessage({ purpose: 'MARKETING', template, catalogNames }).outcome).toBe(
        'PASS'
      );
  });

  it('accepts configurable fuzzy thresholds', () => {
    const template = 'Zyrtecen is in stock';
    expect(
      lintWhatsAppMessage({
        purpose: 'MARKETING',
        template,
        catalogNames,
        options: { misspellingMinLength: 20 },
      }).outcome
    ).toBe('PASS');
  });

  it('keeps every static term blocked', () => {
    for (const term of STATIC_MEDICINE_TERMS)
      expect(lintWhatsAppMessage({ purpose: 'UTILITY', template: term }).outcome).toBe('BLOCK');
  });
});
