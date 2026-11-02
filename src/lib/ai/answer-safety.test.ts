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

  describe('tablet counts need dosing context in every language', () => {
    it.each([
      'Panadol ki 40 goliyan stock mein hain.',
      'Brufen ki 120 golian bik gayin.',
      'Aaj do goli wapas aayin.',
      'آج 40 گولیاں بکیں۔',
      'پیناڈول کی 200 گولیاں اسٹاک میں ہیں',
      'آج ۴۰ گولیاں بکیں',
      'Calpol ke 12 chamach wale packs aaye.',
      'Panadol 500mg: 40 tablets left.',
    ])('passes %s', (text) => {
      expect(detectDosingInstruction(text)).toBe(false);
    });

    it.each([
      'Ek goli lein.',
      'Bachay ko aadha chamach pilayen.',
      'Do goli din mein teen baar.',
      'Har 6 ghante ek goli.',
      'ایک گولی لیں۔',
      'ہر ۶ گھنٹے ایک گولی',
    ])('flags %s', (text) => {
      expect(detectDosingInstruction(text)).toBe(true);
    });
  });

  describe('operations sentences', () => {
    it.each([
      'Panadol 500mg tablets ran out after lunch.',
      'We restocked syrup every 6 hours during the rush.',
      'Brufen 400mg sold 30 packs twice a day during the flu week.',
      'We received 200 tablets every morning from the supplier.',
      'Calpol syrup stock runs out every 6 hours on Fridays.',
      'Insulin units expiring after lunch were moved to the cold shelf.',
      'Panadol sells 3 times a day more than Brufen.',
      'Antibiotics were ordered twice daily last week.',
      'Panadol ki bikri din mein do baar check hoti hai.',
      'Syrup ka maal har 6 ghante khatam ho raha hai.',
      'شربت کا اسٹاک ہر 6 گھنٹے ختم ہو جاتا ہے',
      '40 goliyan raat ko bikin, subah shaam stock check hua.',
      'Please take stock twice a day.',
      'Take a break every 2 hours during the rush.',
      'Use the dashboard twice daily.',
      'Give the staff a break every 4 hours.',
      'The cashier takes payments every evening.',
      'Expiring medicines are checked before lunch.',
      'We sold 2 tablets every 6 hours to the ward.',
      'Order deliveries arrive twice daily with 40 tablets each.',
      'Take Excel exports twice a day.',
      'Open a tab every morning.',
      'Sales were Rs 12,000 after lunch.',
    ])('passes %s', (text) => {
      expect(detectDosingInstruction(text)).toBe(false);
    });
  });

  describe('real dosing advice', () => {
    it.each([
      'He should take Brufen 400mg three times daily.',
      'Panadol 500mg: 1 tablet 3 times daily.',
      'Two tablets every six hours.',
      'Take Panadol every six hours.',
      'Give it twice daily.',
      'One capsule twice daily.',
      'Three tablets a day.',
      'Brufen 400mg three times a day.',
      '500mg every 6 hours.',
      'Calpol 5 ml every 4-6 hours.',
      'Take Augmentin every 12 hours.',
      'Panadol 500mg, 1 tablet 3 times daily; 40 in stock.',
      'Insulin 10 units twice daily.',
      'Brufen: 2 tablets per dose.',
      'Give 10 mg per kg.',
      'The child needs 15mg/kg/day.',
      'One tablet 3x daily.',
      'Tablets should be taken twice daily.',
      'Apply the cream twice daily.',
      'Panadol din mein do baar lein.',
      'Ek goli din mein do baar.',
      'Calpol har 6 ghante pilayen.',
      'Do chamach rozana teen baar.',
      'Dawai har chhe ghante baad.',
      'Panadol ki goli din mai teen dafa khayen.',
      'پیناڈول دن میں دو بار لیں',
      'دوا دن میں تین بار',
      'شربت ہر 8 گھنٹے پلائیں',
      'Take every 6 hours.',
      'Calpol is in stock, 5 ml every 6 hours.',
      'Calpol stock: 2 teaspoons three times a day.',
      'Stock is fine; patients should take Panadol 500mg twice daily.',
    ])('flags %s', (text) => {
      expect(detectDosingInstruction(text)).toBe(true);
    });
  });
});
