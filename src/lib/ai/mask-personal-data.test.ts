import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';

import {
  isPersonalDataKey,
  maskPersonalDataInPrompt,
  maskPersonalJson,
  maskPersonalText,
} from './mask-personal-data';

describe('maskPersonalText', () => {
  it.each([
    ['Call 0300-1234567 today', 'Call [phone] today'],
    ['Call 03001234567 today', 'Call [phone] today'],
    ['Call 0321 7654321', 'Call [phone]'],
    ['Call +92 300 1234567', 'Call [phone]'],
    ['Call +923001234567.', 'Call [phone].'],
    ['Call 0092 300 1234567', 'Call [phone]'],
    ['Office 021-34567890', 'Office [phone]'],
    ['UK +44 20 7946 0958 and US +1 (415) 555-0132', 'UK [phone] and US [phone]'],
    ['Mail ali.khan+rx@example.com.pk now', 'Mail [email] now'],
    ['CNIC 35202-1234567-1 on file', 'CNIC [cnic] on file'],
    ['Card 4111 1111 1111 1111 used', 'Card [card] used'],
    ['Card 4111-1111-1111-1111 used', 'Card [card] used'],
    ['Card 5500000000000004 used', 'Card [card] used'],
    ['Amex 3782 822463 10005', 'Amex [card]'],
    ['IBAN PK36SCBL0000001123456702', 'IBAN [iban]'],
    ['IBAN PK36 SCBL 0000 0011 2345 6702.', 'IBAN [iban].'],
  ])('masks %j', (input, expected) => {
    expect(maskPersonalText(input)).toBe(expected);
  });

  it.each([
    'Sales today were PKR 1,234,567.89 across 312 invoices.',
    'Revenue 12345678 vs 23456789 last week (+15.5%).',
    'Barcode 8964000123456 and GTIN 08964000123456 in stock: 42 units.',
    'Batch B-2026-11-02 expires 2027-03-31 at 09:45.',
    'Invoice INV-0012345678 total Rs. 4,500; order #001234567890.',
    'Card-like but not Luhn: 4111111111111112.',
    'Growth was +12,500 rupees; margin 0.3412.',
    'Amount 1234 5678 9012 3456 is not a card here.',
    'Year 2026, quarter 3, ratio 1.25, count 1000000.',
  ])('leaves ordinary figures alone: %j', (input) => {
    expect(maskPersonalText(input)).toBe(input);
  });
});

describe('personal-data keys', () => {
  it.each([
    'phone',
    'mobile',
    'email',
    'cnic',
    'address',
    'customerName',
    'patientName',
    'customerPhone',
    'patient_mobile',
    'billingAddress',
    'addressLine1',
    'contactEmail',
    'whatsappNumber',
  ])('%s is personal data', (key) => {
    expect(isPersonalDataKey(key)).toBe(true);
  });

  it.each(['productName', 'name', 'brandName', 'branchName', 'total', 'emailEnabled', 'addressId'])(
    '%s is not',
    (key) => {
      expect(isPersonalDataKey(key)).toBe(false);
    }
  );

  it('redacts values under personal-data keys and keeps figures elsewhere', () => {
    expect(
      maskPersonalJson({
        customers: [
          {
            customerName: 'Ayesha Malik',
            phone: 3001234567,
            address: { street: '12 Mall Road', city: 'Lahore' },
            totalMinor: 125000,
            visits: 7,
            note: 'prefers WhatsApp on 0300-7654321',
            emailVerified: true,
            email: null,
          },
        ],
        productName: 'Panadol 500mg',
        revenue: '1,234,567.00',
      })
    ).toEqual({
      customers: [
        {
          customerName: '[redacted]',
          phone: '[redacted]',
          address: '[redacted]',
          totalMinor: 125000,
          visits: 7,
          note: 'prefers WhatsApp on [phone]',
          emailVerified: true,
          email: null,
        },
      ],
      productName: 'Panadol 500mg',
      revenue: '1,234,567.00',
    });
  });
});

describe('maskPersonalDataInPrompt', () => {
  it('masks every text the model reads, including tool inputs and results, and keeps files', () => {
    const image = new Uint8Array([1, 2, 3]);
    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'Owner contact: owner@pharmacy.pk' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Find the customer on 0300-1234567. Sales were 1,250,000.' },
          { type: 'file', data: image, mediaType: 'image/png' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Look up 0300-1234567.' },
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'findCustomer',
            input: { phone: '0300-1234567', limit: 5 },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'findCustomer',
            output: {
              type: 'json',
              value: { customerName: 'Ayesha Malik', cnic: '35202-1234567-1', spendMinor: 98500 },
            },
          },
          {
            type: 'tool-result',
            toolCallId: 'c2',
            toolName: 'notes',
            output: { type: 'text', value: '{"patientName":"Bilal","visits":3}' },
          },
        ],
      },
    ];
    const masked = maskPersonalDataInPrompt(prompt);
    expect(masked[0]).toEqual({ role: 'system', content: 'Owner contact: [email]' });
    expect(masked[1].content).toEqual([
      { type: 'text', text: 'Find the customer on [phone]. Sales were 1,250,000.' },
      { type: 'file', data: image, mediaType: 'image/png' },
    ]);
    expect(masked[2].content).toEqual([
      { type: 'reasoning', text: 'Look up [phone].' },
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'findCustomer',
        input: { phone: '[redacted]', limit: 5 },
      },
    ]);
    expect(masked[3].content).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'findCustomer',
        output: {
          type: 'json',
          value: { customerName: '[redacted]', cnic: '[redacted]', spendMinor: 98500 },
        },
      },
      {
        type: 'tool-result',
        toolCallId: 'c2',
        toolName: 'notes',
        output: { type: 'text', value: '{"patientName":"[redacted]","visits":3}' },
      },
    ]);
    // The caller's prompt is not mutated.
    expect(prompt[0]).toEqual({ role: 'system', content: 'Owner contact: owner@pharmacy.pk' });
  });

  it('keeps JSON text byte for byte when there is nothing to mask', () => {
    const value = '{ "total": 1250000,  "units": 42 }';
    const [message] = maskPersonalDataInPrompt([
      { role: 'user', content: [{ type: 'text', text: value }] },
    ]);
    expect(message.content).toEqual([{ type: 'text', text: value }]);
  });
});
