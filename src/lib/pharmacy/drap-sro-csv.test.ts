import { describe, expect, it } from 'vitest';

import { CsvDrapNoticeSource, DrapSroCsvError, parseDrapSroCsv } from './drap-sro-csv';

const header = 'SRO No.,DRAP Registration Number,Presentation,Pack,MRP (PKR),Effective Date';

describe('DEV-693 SRO CSV schedule parser', () => {
  it('copies the official MRP exactly and gives each row its own reference', async () => {
    const csv = `﻿${header}\r\n"SRO 1092(I)/2023",012345,"Tablet 500 mg",box,"1,250.5",22/08/2023\r\nSRO 1092(I)/2023,067890,,,Rs. 99,2023-08-22\r\n`;
    const source = new CsvDrapNoticeSource(csv);
    expect(source.adapter).toBe('FILE');
    await expect(source.read()).resolves.toEqual([
      {
        kind: 'PRICE',
        sourceReference: 'SRO 1092(I)/2023 / 012345 / Tablet 500 mg / BOX',
        drapRegistrationNumber: '012345',
        presentation: 'Tablet 500 mg',
        packLevel: 'BOX',
        notifiedPriceMinor: 125050,
        effectiveDate: new Date('2023-08-22T00:00:00.000Z'),
      },
      {
        kind: 'PRICE',
        sourceReference: 'SRO 1092(I)/2023 / 067890',
        drapRegistrationNumber: '067890',
        notifiedPriceMinor: 9900,
        effectiveDate: new Date('2023-08-22T00:00:00.000Z'),
      },
    ]);
  });

  it.each([
    ['a missing MRP column', 'SRO,Registration No,Effective Date\nS,1,2023-08-22', 'MRP'],
    ['an MRP that is not an amount', `${header}\nS,1,,,approx 300,2023-08-22`, 'Row 2'],
    ['an MRP with three decimals', `${header}\nS,1,,,3.005,2023-08-22`, 'Row 2'],
    ['an impossible date', `${header}\nS,1,,,300,31/02/2023`, 'Row 2'],
    ['an unknown pack', `${header}\nS,1,,CARTON,300,2023-08-22`, 'Row 2'],
    ['a blank registration number', `${header}\nS,,,,300,2023-08-22`, 'Row 2'],
    ['a medicine listed twice', `${header}\nS,1,,,300,2023-08-22\nS,1,,,310,2023-08-22`, 'Row 3'],
    ['an unclosed quote', `${header}\n"S,1,,,300,2023-08-22`, 'quoted'],
    ['no rows', header, 'no price rows'],
  ])('rejects %s', (_label, csv, message) => {
    expect(() => parseDrapSroCsv(csv)).toThrow(DrapSroCsvError);
    expect(() => parseDrapSroCsv(csv)).toThrow(message);
  });

  it('caps one upload at 100 rows', () => {
    const rows = Array.from({ length: 101 }, (_, i) => `S,${i},,,300,2023-08-22`);
    expect(() => parseDrapSroCsv([header, ...rows].join('\n'))).toThrow('at most 100');
  });
});
