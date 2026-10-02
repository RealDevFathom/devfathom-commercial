import { describe, expect, it } from 'vitest';

import {
  canMessageCustomer,
  consentKeyword,
  normalizeWhatsAppNumber,
  parseOrderMessage,
} from './messages';

describe('parseOrderMessage', () => {
  it.each([
    ['Panadol 2 packs', { medicine: 'panadol', quantity: 2 }],
    ['Please send 3 packets of Brufen', { medicine: 'brufen', quantity: 3 }],
    ['Brufen 400mg x3', { medicine: 'brufen 400mg', quantity: 3 }],
    ['Panadol 500 mg 2 boxes', { medicine: 'panadol 500 mg', quantity: 2 }],
    ['two packs of ORS', { medicine: 'ors', quantity: 2 }],
    ['panadol ke 3 dabbe chahiye', { medicine: 'panadol', quantity: 3 }],
    // Urdu script with Extended Arabic-Indic digits.
    ['مجھے پیناڈول کے ۲ پیکٹ چاہیے', { medicine: 'پیناڈول', quantity: 2 }],
    // Urdu number word; "بھیج دیں" is a verb phrase, not a quantity.
    ['دو پیکٹ پیناڈول بھیج دیں', { medicine: 'پیناڈول', quantity: 2 }],
    // "بھیج دو" (send) must not be read as "two".
    ['پیناڈول تین ڈبے بھیج دو', { medicine: 'پیناڈول', quantity: 3 }],
    ['Arinac ٤ pack', { medicine: 'arinac', quantity: 4 }],
  ])('parses %j', (text, expected) => {
    expect(parseOrderMessage(text)).toEqual(expected);
  });

  it.each([
    ['Panadol chahiye', 'no quantity'],
    ['2 packs', 'no medicine'],
    ['Panadol 2 strips', 'strips are not remote-orderable'],
    ['پیناڈول کی ۲ گولیاں', 'tablets are not remote-orderable'],
    ['Panadol 0 packs', 'zero quantity'],
    ['Panadol 150 packs', 'over the storefront maximum'],
    ['Panadol 2 and Brufen 3', 'two quantities are ambiguous'],
    ['', 'empty'],
  ])('returns null for %j (%s)', (text) => {
    expect(parseOrderMessage(text)).toBeNull();
  });
});

describe('consentKeyword', () => {
  it.each([
    ['STOP', 'STOP'],
    ['  stop. ', 'STOP'],
    ['Unsubscribe', 'STOP'],
    ['بند کریں', 'STOP'],
    ['band karo', 'STOP'],
    ['START', 'START'],
    ['شروع', 'START'],
    ['stop my order of panadol', null],
    ['Panadol 2 packs', null],
  ])('%j -> %s', (text, expected) => {
    expect(consentKeyword(text)).toBe(expected);
  });
});

describe('normalizeWhatsAppNumber', () => {
  it.each([
    ['0300-1234567', '923001234567'],
    ['+92 300 1234567', '923001234567'],
    ['0092 300 1234567', '923001234567'],
    ['3001234567', '923001234567'],
    ['۰۳۰۰۱۲۳۴۵۶۷', '923001234567'],
    ['923001234567', '923001234567'],
  ])('%j -> %s', (raw, expected) => {
    expect(normalizeWhatsAppNumber(raw)).toBe(expected);
  });

  it('rejects missing or impossible numbers', () => {
    expect(normalizeWhatsAppNumber(null)).toBeNull();
    expect(normalizeWhatsAppNumber('12')).toBeNull();
    expect(normalizeWhatsAppNumber('abc')).toBeNull();
  });
});

describe('canMessageCustomer (consent gate)', () => {
  it('allows only active customers who explicitly opted in', () => {
    expect(canMessageCustomer({ active: true, whatsappOptIn: true })).toBe(true);
    expect(canMessageCustomer({ active: true, whatsappOptIn: null })).toBe(false);
    expect(canMessageCustomer({ active: true, whatsappOptIn: false })).toBe(false);
    expect(canMessageCustomer({ active: false, whatsappOptIn: true })).toBe(false);
    expect(canMessageCustomer(null)).toBe(false);
  });
});
