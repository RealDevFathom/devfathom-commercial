import { describe, expect, it } from 'vitest';

import { detectDosingInstruction } from './answer-safety';

describe('detectDosingInstruction', () => {
  it.each([
    'Take 2 tablets twice a day after meals.',
    'Give 5 ml every 8 hours.',
    'Paracetamol 500mg, one tablet three times a day.',
    'The usual adult dose is 1 g.',
    'Dose for children: 15 mg/kg every 6 hours.',
    'Use 10 mg per kg of body weight.',
    'Augmentin 625mg BID for 5 days.',
    'Panadol 500mg 1-0-1 for three days.',
    'Syrup: 1 teaspoon at bedtime.',
    'Take one capsule on an empty stomach.',
    'Do not exceed 4 g in 24 hours.',
    'The maximum daily dose is 4000mg.',
    'Apply 2 drops in each eye q6h.',
    'Brufen ki ek goli din mein do baar lein.',
    'Do goli subah shaam khane ke baad.',
    'Syrup aik chamach raat ko sotay waqt.',
    'Har 8 ghante baad ek capsule.',
    'دن میں دو بار ایک گولی کھانے کے بعد لیں۔',
    'دو گولی صبح شام',
  ])('flags %s', (text) => {
    expect(detectDosingInstruction(text)).toBe(true);
  });

  it.each([
    'Panadol 500mg tablets: 120 in stock. Brufen 400mg: 30 in stock.',
    'Augmentin 625mg is low: 4 strips left; reorder suggested.',
    'Cash is counted twice a day at opening and closing.',
    'Panadol sells about 40 tablets a day at Gulberg.',
    'Sales were Rs 123,456 today across 3 shifts.',
    'Take a look at the expiry report for this week.',
    'I can’t give dosing advice. Please ask the pharmacist.',
    'Deliveries arrive every 4 hours from the warehouse.',
    'Aaj ki sales Rs 50,000 hain aur 12 stock signals khule hain.',
    'Meeting with the supplier after lunch on Tuesday.',
    'Score was 1-0-1 in the staff cricket match.',
    '',
  ])('passes %s', (text) => {
    expect(detectDosingInstruction(text)).toBe(false);
  });
});
