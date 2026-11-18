/**
 * #721 — the Tally XML import preset.
 *
 * The acceptance criterion is "the public Tally sample XML imports with zero
 * unmapped required fields". The fixture follows Tally's documented "All
 * Masters" export shape (ENVELOPE → TALLYMESSAGE → UNIT / GROUP / STOCKITEM with
 * BATCHALLOCATIONS.LIST and EXPIRYPERIOD / LEDGER), including Tally's
 * control-character prefixes on reserved names.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATION_TARGET_KEYS } from './mapping-targets';
import { profileTable, UnrecognisedSourceError, type ProfileResult } from './profiler';
import {
  decodeTallyXmlBytes,
  flattenTallyXml,
  normalizeTallyDate,
  parseXml,
  TALLY_COLUMN_MAP,
  TALLY_HEADERS,
  TALLY_REQUIRED_FIELDS,
  tallyXmlProfiler,
  TallyXmlError,
  unmappedTallyRequiredFields,
} from './tally-xml-profiler';

const FIXTURE_DIR = join(process.cwd(), 'src/lib/pharmacy/migration/fixtures');
const SAMPLE = readFileSync(join(FIXTURE_DIR, 'tally-masters-sample.xml'), 'utf8');

function envelope(messages: string): string {
  return `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>${messages}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

/** A fixed "now", so fixture expiries never drift into the past. */
const AS_OF = new Date('2026-11-18T06:00:00Z');

function profile(xml: string): ProfileResult {
  return profileTable(tallyXmlProfiler, flattenTallyXml(xml).table, {
    quantityUnit: 'UNITS',
    asOf: AS_OF,
  });
}

function bucketsOf(result: ProfileResult): string[] {
  return result.exceptions.map((exception) => exception.bucket).sort();
}

describe('Tally sample XML — acceptance', () => {
  it('maps every required field, with zero unmapped', () => {
    const { table } = flattenTallyXml(SAMPLE);
    const columnMap = tallyXmlProfiler.resolveColumns(table);

    expect(columnMap).not.toBeNull();
    expect(unmappedTallyRequiredFields(columnMap!)).toEqual([]);
    for (const field of TALLY_REQUIRED_FIELDS) expect(columnMap![field]).toBeDefined();
  });

  it('imports stock batches and party balances with no exceptions', () => {
    const result = profile(SAMPLE);

    expect(result.rows).toHaveLength(6);
    expect(result.exceptions).toEqual([]);
  });

  it('counts what it read and records what it deliberately skipped', () => {
    const flattened = flattenTallyXml(SAMPLE);

    expect(flattened.counts).toEqual({
      units: 2,
      groups: 1,
      stockItems: 2,
      batches: 3,
      ledgers: 3,
    });
    expect(flattened.skipped).toEqual([
      { master: 'LEDGER', name: 'Cash', reason: 'NOT_A_PARTY_LEDGER' },
      { master: 'VOUCHERTYPE', name: 'Sales', reason: 'NOT_IMPORTED_MASTER' },
    ]);
    expect(flattened.warnings).toEqual([]);
  });

  it('reads one row per batch allocation with units, expiry, MRP and cost', () => {
    const [first, second, augmentin] = profile(SAMPLE).rows;

    expect(first).toMatchObject({
      sourceKey: 'STOCKITEM:Panadol 500mg Tab|BATCH:B2411|GODOWN:Main Location',
      targetModelKey: MIGRATION_TARGET_KEYS.PRODUCT,
      productName: 'Panadol 500mg Tab',
      packLabel: '1 Strip',
      packFactor: BigInt(1),
      batchNumber: 'B2411',
      // The latest MRP (from 1 Apr 2026), not the superseded one.
      mrpMinor: BigInt(2500),
      costMinor: BigInt(2125),
      quantityCanonical: BigInt(100),
    });
    expect(first!.expiryDate?.toISOString()).toBe('2027-03-01T00:00:00.000Z');
    expect(first!.rawPayload['Mfg Date']).toBe('2025-03-01');
    expect(first!.rawPayload['Stock Group']).toBe('Analgesics');
    expect(first!.rawPayload['Opening Value']).toBe('2125.00');

    expect(second).toMatchObject({ batchNumber: 'B2502', quantityCanonical: BigInt(50) });
    expect(second!.expiryDate?.toISOString()).toBe('2027-09-30T00:00:00.000Z');

    expect(augmentin).toMatchObject({
      productName: 'Augmentin 625mg Tab',
      packLabel: '1 Nos',
      mrpMinor: BigInt(14550),
      costMinor: BigInt(12000),
      quantityCanonical: BigInt(60),
    });
  });

  it('maps ledgers to suppliers and customers with positive amounts owed', () => {
    const parties = profile(SAMPLE).rows.slice(3);

    expect(parties.map((row) => [row.supplierName, row.customerName, row.balanceMinor])).toEqual([
      ['Muller & Phipps', null, BigInt(1250000)],
      ['IBL Healthcare', null, BigInt(430050)],
      [null, 'Al-Shifa Clinic', BigInt(275000)],
    ]);
    for (const row of parties) {
      expect(row.targetModelKey).toBe(MIGRATION_TARGET_KEYS.PARTY_BALANCE);
    }
    // The signed Tally figure survives as evidence.
    expect(parties[2]!.rawPayload['Tally Opening Balance']).toBe('-2750.00');
  });

  it('does not report two batches of one item as a duplicate product', () => {
    expect(bucketsOf(profile(SAMPLE))).not.toContain('DUPLICATE_PRODUCT');
  });
});

describe('Tally flattening never guesses', () => {
  const unit = `<TALLYMESSAGE><UNIT NAME="Nos"><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>0</DECIMALPLACES></UNIT></TALLYMESSAGE>`;

  it('stores an item without allocations as batch and expiry not recorded, with no exception', () => {
    const xml = envelope(
      `${unit}<TALLYMESSAGE><STOCKITEM NAME="Cotton Roll"><BASEUNITS>Nos</BASEUNITS>
        <OPENINGBALANCE> 10 Nos</OPENINGBALANCE><OPENINGRATE>40.00/Nos</OPENINGRATE>
        <MRPDETAILS.LIST><FROMDATE>20260101</FROMDATE><MRPRATEDETAILS.LIST>
        <STATENAME>Any</STATENAME><MRPRATE>55.00/Nos</MRPRATE></MRPRATEDETAILS.LIST></MRPDETAILS.LIST>
       </STOCKITEM></TALLYMESSAGE>`
    );
    const result = profile(xml);

    expect(result.rows[0]).toMatchObject({
      sourceKey: 'STOCKITEM:Cotton Roll',
      batchNumber: null,
      expiryDate: null,
      quantityCanonical: BigInt(10),
    });
    // DEV-927: missing batch and expiry are "not recorded", not blocking.
    expect(result.exceptions).toEqual([]);
  });

  it('treats Tally’s "Primary Batch" placeholder as batch not recorded', () => {
    const xml = envelope(
      `${unit}<TALLYMESSAGE><STOCKITEM NAME="Gauze"><BASEUNITS>Nos</BASEUNITS>
        <MRPDETAILS.LIST><FROMDATE>20260101</FROMDATE><MRPRATEDETAILS.LIST>
        <STATENAME>Any</STATENAME><MRPRATE>30.00/Nos</MRPRATE></MRPRATEDETAILS.LIST></MRPDETAILS.LIST>
        <BATCHALLOCATIONS.LIST><BATCHNAME>Primary Batch</BATCHNAME>
          <OPENINGBALANCE> 5 Nos</OPENINGBALANCE><OPENINGRATE>20.00/Nos</OPENINGRATE>
          <EXPIRYPERIOD>1-Jan-2028</EXPIRYPERIOD></BATCHALLOCATIONS.LIST>
       </STOCKITEM></TALLYMESSAGE>`
    );
    const result = profile(xml);

    expect(result.rows[0]!.batchNumber).toBeNull();
    expect(result.rows[0]!.rawPayload['Tally Batch Name']).toBe('Primary Batch');
    expect(result.exceptions).toEqual([]);
  });

  it('still refuses a batch whose known expiry has passed, as BLOCKING (DEV-927)', () => {
    const xml = envelope(
      `${unit}<TALLYMESSAGE><STOCKITEM NAME="Gauze"><BASEUNITS>Nos</BASEUNITS>
        <MRPDETAILS.LIST><FROMDATE>20260101</FROMDATE><MRPRATEDETAILS.LIST>
        <STATENAME>Any</STATENAME><MRPRATE>30.00/Nos</MRPRATE></MRPRATEDETAILS.LIST></MRPDETAILS.LIST>
        <BATCHALLOCATIONS.LIST><BATCHNAME>G1</BATCHNAME>
          <OPENINGBALANCE> 5 Nos</OPENINGBALANCE><OPENINGRATE>20.00/Nos</OPENINGRATE>
          <EXPIRYPERIOD>17-Nov-2026</EXPIRYPERIOD></BATCHALLOCATIONS.LIST>
        <BATCHALLOCATIONS.LIST><BATCHNAME>G2</BATCHNAME>
          <OPENINGBALANCE> 5 Nos</OPENINGBALANCE><OPENINGRATE>20.00/Nos</OPENINGRATE>
          <EXPIRYPERIOD>18-Nov-2026</EXPIRYPERIOD></BATCHALLOCATIONS.LIST>
       </STOCKITEM></TALLYMESSAGE>`
    );
    const result = profile(xml);

    expect(result.exceptions).toMatchObject([
      { rowIndex: 0, bucket: 'EXPIRED_STOCK', severity: 'BLOCKING' },
    ]);
  });

  it('passes a rate quoted per another unit through raw, so it is reported', () => {
    const xml = envelope(
      `${unit}<TALLYMESSAGE><STOCKITEM NAME="Syrup"><BASEUNITS>Nos</BASEUNITS>
        <MRPDETAILS.LIST><FROMDATE>20260101</FROMDATE><MRPRATEDETAILS.LIST>
        <STATENAME>Any</STATENAME><MRPRATE>600.00/Box</MRPRATE></MRPRATEDETAILS.LIST></MRPDETAILS.LIST>
        <BATCHALLOCATIONS.LIST><BATCHNAME>S1</BATCHNAME>
          <OPENINGBALANCE> 2 Box</OPENINGBALANCE>
          <EXPIRYPERIOD>1-Jan-2028</EXPIRYPERIOD></BATCHALLOCATIONS.LIST>
       </STOCKITEM></TALLYMESSAGE>`
    );
    const result = profile(xml);

    expect(result.rows[0]!.mrpMinor).toBeNull();
    expect(result.rows[0]!.quantityCanonical).toBeNull();
    expect(bucketsOf(result)).toEqual(['MISSING_MRP', 'UNIT_AMBIGUOUS']);
  });

  it('raises UNIT_AMBIGUOUS for a compound base unit instead of assuming one', () => {
    const xml = envelope(
      `<TALLYMESSAGE><UNIT NAME="Box of 10 Nos"><ISSIMPLEUNIT>No</ISSIMPLEUNIT>
        <BASEUNITS>Box</BASEUNITS><ADDITIONALUNITS>Nos</ADDITIONALUNITS></UNIT></TALLYMESSAGE>
       <TALLYMESSAGE><STOCKITEM NAME="Mask"><BASEUNITS>Box of 10 Nos</BASEUNITS>
        <MRPDETAILS.LIST><FROMDATE>20260101</FROMDATE><MRPRATEDETAILS.LIST>
        <STATENAME>Any</STATENAME><MRPRATE>100.00</MRPRATE></MRPRATEDETAILS.LIST></MRPDETAILS.LIST>
        <BATCHALLOCATIONS.LIST><BATCHNAME>M1</BATCHNAME><OPENINGBALANCE>4</OPENINGBALANCE>
          <EXPIRYPERIOD>1-Jan-2028</EXPIRYPERIOD></BATCHALLOCATIONS.LIST>
       </STOCKITEM></TALLYMESSAGE>`
    );
    const result = profile(xml);

    expect(result.rows[0]!.packLabel).toBe('Box of 10 Nos');
    expect(bucketsOf(result)).toContain('UNIT_AMBIGUOUS');
  });

  it('warns when the item opening differs from its batch total', () => {
    const xml = envelope(
      `${unit}<TALLYMESSAGE><STOCKITEM NAME="Pill"><BASEUNITS>Nos</BASEUNITS>
        <OPENINGBALANCE> 9 Nos</OPENINGBALANCE>
        <BATCHALLOCATIONS.LIST><BATCHNAME>P1</BATCHNAME><OPENINGBALANCE> 5 Nos</OPENINGBALANCE>
        </BATCHALLOCATIONS.LIST>
       </STOCKITEM></TALLYMESSAGE>`
    );

    expect(flattenTallyXml(xml).warnings).toEqual([
      { sourceKey: 'STOCKITEM:Pill', detail: 'Item opening 9 Nos differs from batch total 5.' },
    ]);
  });

  it('still reports two identical batches of one item as a duplicate', () => {
    const allocation = `<BATCHALLOCATIONS.LIST><BATCHNAME>X1</BATCHNAME>
      <OPENINGBALANCE> 1 Nos</OPENINGBALANCE><EXPIRYPERIOD>1-Jan-2028</EXPIRYPERIOD>
      </BATCHALLOCATIONS.LIST>`;
    const xml = envelope(
      `${unit}<TALLYMESSAGE><STOCKITEM NAME="Dup"><BASEUNITS>Nos</BASEUNITS>
        <MRPDETAILS.LIST><FROMDATE>20260101</FROMDATE><MRPRATEDETAILS.LIST>
        <STATENAME>Any</STATENAME><MRPRATE>10.00</MRPRATE></MRPRATEDETAILS.LIST></MRPDETAILS.LIST>
        ${allocation}${allocation}</STOCKITEM></TALLYMESSAGE>`
    );
    const result = profile(xml);

    // The second row keeps a distinct source key, but is still a duplicate.
    expect(result.rows.map((row) => row.sourceKey)).toEqual([
      'STOCKITEM:Dup|BATCH:X1',
      'STOCKITEM:Dup|BATCH:X1#2',
    ]);
    expect(bucketsOf(result)).toEqual(['DUPLICATE_PRODUCT']);
  });

  it('reads Dr/Cr suffixed balances and keeps an unreadable one raw with a warning', () => {
    const xml = envelope(
      `<TALLYMESSAGE><LEDGER NAME="Supplier Dr"><PARENT>Sundry Creditors</PARENT>
         <OPENINGBALANCE>500.00 Dr</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
       <TALLYMESSAGE><LEDGER NAME="Odd"><PARENT>Sundry Debtors</PARENT>
         <OPENINGBALANCE>about 10</OPENINGBALANCE></LEDGER></TALLYMESSAGE>`
    );
    const flattened = flattenTallyXml(xml);
    const result = profileTable(tallyXmlProfiler, flattened.table, { quantityUnit: 'UNITS' });

    // A supplier in debit is an advance: a negative amount owed to them.
    expect(result.rows[0]!.balanceMinor).toBe(BigInt(-50000));
    expect(result.rows[1]!.balanceMinor).toBeNull();
    expect(flattened.warnings).toEqual([
      {
        sourceKey: 'LEDGER:Odd',
        detail: 'Opening balance "about 10" is not an exact money amount.',
      },
    ]);
  });
});

describe('Tally XML reader safety', () => {
  it('refuses a DOCTYPE or ENTITY declaration (XXE / entity expansion)', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><ENVELOPE>&e;</ENVELOPE>`;
    expect(() => parseXml(xxe)).toThrow(TallyXmlError);
    try {
      parseXml(xxe);
    } catch (error) {
      expect((error as TallyXmlError).reason).toBe('DTD_FORBIDDEN');
    }
  });

  it('refuses an unknown entity rather than dropping it', () => {
    expect(() => parseXml('<ENVELOPE>&custom;</ENVELOPE>')).toThrow(/UNKNOWN_ENTITY/);
  });

  it('refuses malformed and mismatched markup', () => {
    expect(() => parseXml('<ENVELOPE><A></B></ENVELOPE>')).toThrow(/MALFORMED/);
    expect(() => parseXml('<ENVELOPE><A>')).toThrow(/MALFORMED/);
    expect(() => parseXml('<A/><B/>')).toThrow(/MALFORMED/);
    expect(() => parseXml('   ')).toThrow(/EMPTY/);
  });

  it('refuses excessive nesting', () => {
    const deep = '<A>'.repeat(200) + '</A>'.repeat(200);
    expect(() => parseXml(deep)).toThrow(/TOO_DEEP/);
  });

  it('refuses a document that is not a Tally envelope', () => {
    expect(() => flattenTallyXml('<html><body/></html>')).toThrow(/NOT_TALLY/);
  });

  it('decodes UTF-16LE with a BOM, as Tally commonly writes', () => {
    const text = '<ENVELOPE/>';
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let index = 0; index < text.length; index += 1) {
      bytes[2 + index * 2] = text.charCodeAt(index);
    }

    expect(decodeTallyXmlBytes(bytes)).toBe(text);
    expect(decodeTallyXmlBytes(new TextEncoder().encode(text))).toBe(text);
  });

  it('refuses bytes that are not valid text instead of decoding lossily', () => {
    expect(() => decodeTallyXmlBytes(new Uint8Array([0x3c, 0xc3, 0x28]))).toThrow(/UNDECODABLE/);
  });
});

describe('Tally profiler contract', () => {
  it('normalizes both Tally date forms and passes anything else through', () => {
    expect(normalizeTallyDate('20270301')).toBe('2027-03-01');
    expect(normalizeTallyDate('1-Mar-2027')).toBe('2027-03-01');
    expect(normalizeTallyDate('31-May-27')).toBe('2027-05-31');
    expect(normalizeTallyDate('sometime')).toBe('sometime');
  });

  it('refuses a table that is not a flattened Tally table', () => {
    const table = { headers: ['Item', 'Qty'], rows: [['A', '1']] };
    expect(tallyXmlProfiler.resolveColumns(table)).toBeNull();
    expect(() => profileTable(tallyXmlProfiler, table)).toThrow(UnrecognisedSourceError);
  });

  it('declares a fixed header for every mapped column', () => {
    for (const header of Object.keys(TALLY_COLUMN_MAP)) {
      expect(TALLY_HEADERS as readonly string[]).toContain(header);
    }
    expect(tallyXmlProfiler.kind).toBe('TALLY_XML');
    expect(tallyXmlProfiler.version).toBe('tally-xml/1');
  });
});
