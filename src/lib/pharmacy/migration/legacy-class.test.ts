import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyLegacyControlledClass, applyLegacyControlledToMedicine } from './legacy-controlled';
import { ManualFileConnector } from '../reference-connectors';
import {
  LEGACY_WHITESPACE_RUN,
  isLegacyControlledClass,
  isLegacyControlledRow,
  legacyClassValue,
  legacyProductNameKey,
  normalizeLegacyText,
} from './legacy-class';
import { excelCsvProfiler } from './excel-csv-profiler';
import { profileTable } from './profiler';
import { parseDelimitedText } from './source-values';
import { counterAlertsFor, hasBlockingAlert } from '../counter-alerts';

const fixture = readFileSync(join(__dirname, 'fixtures', 'legacy-class-export.csv'), 'utf8');

describe('DEV-854 legacy NARCOTICS class', () => {
  it('matches NARCOTICS only, trimmed and case-insensitively', () => {
    for (const value of ['NARCOTICS', ' narcotics ', 'Narcotics', '\tNARCOTICS\n'])
      expect(isLegacyControlledClass(value)).toBe(true);
    // Close spellings found in the fixture are a different class and are not guessed.
    for (const value of ['NARCOTIC', 'NARCOTICS DRUGS', 'NARCOTICES', '', null, undefined])
      expect(isLegacyControlledClass(value)).toBe(false);
  });

  it('reads the class from its original header spelling', () => {
    expect(legacyClassValue({ classname: 'NARCOTICS' })).toBe('NARCOTICS');
    expect(legacyClassValue({ 'Class Name': 'narcotics' })).toBe('narcotics');
    expect(legacyClassValue({ CLASS: 'Example Distributors' })).toBe('Example Distributors');
    expect(legacyClassValue({ Category: 'NARCOTICS' })).toBeNull();
    expect(isLegacyControlledRow({ Category: 'NARCOTICS' })).toBe(false);
  });

  it('flags exactly the NARCOTICS rows of the fixture and imports prices as values', () => {
    const table = parseDelimitedText(fixture);
    // The suggested mapping takes MRP from SALEPRICE and purchase price from PURPRICE.
    expect(
      excelCsvProfiler.resolveColumns({ headers: ['Product', 'SALEPRICE', 'PURPRICE'], rows: [] })
    ).toEqual({ product: 0, mrp: 1, cost: 2 });
    // As the staging import does: the operator's column mapping drives the profile.
    const mapping = { product: 0, mrp: 3, cost: 4, quantity: 5 };
    const profiler = { ...excelCsvProfiler, resolveColumns: () => mapping };
    const result = profileTable(profiler, table, { quantityUnit: 'UNITS' });
    const controlled = result.rows
      .filter((row) => isLegacyControlledRow(row.rawPayload))
      .map((row) => row.productName);
    expect(controlled).toEqual([
      'Synthetic Opioid 50mg',
      'Synthetic Sedative 2mg',
      'Synthetic Cough Linctus',
    ]);
    const opioid = result.rows[0]!;
    expect(opioid.mrpMinor).toBe(BigInt(45000));
    expect(opioid.costMinor).toBe(BigInt(38050));
    // Nothing is held: a NARCOTICS row raises exactly the exceptions an ordinary row does
    // (this file has no batch or expiry columns), and its prices are not held either.
    const buckets = (rowIndex: number) =>
      result.exceptions.filter((e) => e.rowIndex === rowIndex).map((e) => e.bucket);
    expect(buckets(0)).toEqual(buckets(5));
    expect(buckets(0)).toEqual(['MISSING_BATCH', 'MISSING_EXPIRY']);
  });

  it('sets matching catalogue medicines controlled at import, leaving other rows alone', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ id: 'med_opioid' }]) };
    const result = await applyLegacyControlledClass(db as never, 'org_a', [
      { productName: ' Synthetic  Opioid 50mg ', rawPayload: { classname: ' narcotics ' } },
      { productName: 'Synthetic Paracetamol', rawPayload: { classname: 'Example Distributors' } },
      { productName: 'Synthetic Opioid Drops', rawPayload: { classname: 'NARCOTIC' } },
    ]);
    expect(result).toEqual({
      controlledRows: 1,
      medicineIds: ['med_opioid'],
      skippedCorrectedRows: 0,
    });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    const [strings, ...params] = db.$queryRaw.mock.calls[0]!;
    const sql = (strings as string[]).join('?');
    // Only tightens, in this tenant, matching names with whitespace collapsed on both sides.
    expect(sql).toContain('SET "controlled" = true');
    expect(sql).toContain('"controlled" = false');
    expect(params).toContain('org_a');
    expect(params).toContainEqual(['synthetic opioid 50mg']);
    // DEV-925: the database uses the code's whitespace rule, not btrim's spaces-only rule.
    expect(JSON.stringify(params)).toContain('lower(btrim(regexp_replace(');
    expect(JSON.stringify(params)).toContain(JSON.stringify(LEGACY_WHITESPACE_RUN));
    // A person's correction to "not controlled" through the catalogue edit path is respected.
    expect(JSON.stringify(params)).toContain('pharmacy_catalogue_edits');
  });

  it('skips and counts rows naming a medicine a person corrected to not controlled (DEV-925)', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 'med_sedative', correctedKey: null },
        { id: 'med_opioid', correctedKey: 'synthetic opioid 50mg' },
      ]),
    };
    const result = await applyLegacyControlledClass(db as never, 'org_a', [
      { productName: 'Synthetic Opioid 50mg', rawPayload: { classname: 'NARCOTICS' } },
      { productName: ' synthetic  opioid 50MG', rawPayload: { CLASS: 'narcotics' } },
      { productName: 'Synthetic Sedative 10mg', rawPayload: { classname: 'NARCOTICS' } },
      { productName: 'Synthetic Paracetamol', rawPayload: { classname: 'Example Distributors' } },
    ]);
    expect(result).toEqual({
      controlledRows: 3,
      medicineIds: ['med_sedative'],
      skippedCorrectedRows: 2,
    });
    const [strings] = db.$queryRaw.mock.calls[0]!;
    const sql = (strings as string[]).join('?');
    expect(sql).toContain('AND NOT matched."corrected"');
  });

  it('uses one trimming rule: the code and the SQL pattern remove the same characters (DEV-925)', () => {
    const whitespace = new RegExp(`^${LEGACY_WHITESPACE_RUN}$`);
    for (let code = 0; code <= 0xffff; code += 1) {
      const char = String.fromCharCode(code);
      expect(whitespace.test(char), `U+${code.toString(16)}`).toBe(/^\s$/.test(char));
    }
    for (const value of ['\tNARCOTICS\r\n', '\u00a0narcotics\u2003', '\nNarcotics\v'])
      expect(isLegacyControlledClass(value)).toBe(true);
    expect(normalizeLegacyText('\t Synthetic\n\u00a0Opioid  ')).toBe('Synthetic Opioid');
    expect(legacyProductNameKey('\tSynthetic \r\n Opioid 50MG ')).toBe('synthetic opioid 50mg');
  });

  it('writes nothing when no row is in the NARCOTICS class', async () => {
    const db = { $queryRaw: vi.fn() };
    const result = await applyLegacyControlledClass(db as never, 'org_a', [
      { productName: 'Synthetic Paracetamol', rawPayload: { classname: 'Example Distributors' } },
    ]);
    expect(result).toEqual({ controlledRows: 0, medicineIds: [], skippedCorrectedRows: 0 });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('makes a medicine created after staging controlled when a NARCOTICS row was staged', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ found: true }]),
      medicine: { update: vi.fn().mockResolvedValue({}) },
    };
    const created = { id: 'med_new', productName: 'Synthetic  Opioid 50mg', controlled: false };
    await expect(applyLegacyControlledToMedicine(db as never, 'org_a', created)).resolves.toBe(
      true
    );
    const [strings, ...params] = db.$queryRaw.mock.calls[0]!;
    expect((strings as string[]).join('?')).toContain('pharmacy_migration_rows');
    expect(params).toEqual(expect.arrayContaining(['org_a', 'synthetic opioid 50mg', 'NARCOTICS']));
    // DEV-925: the same query refuses when a person corrected this medicine to not controlled.
    expect(JSON.stringify(params)).toContain('pharmacy_catalogue_edits');
    expect(JSON.stringify(params)).toContain('med_new');
    expect(db.medicine.update).toHaveBeenCalledWith({
      where: { id: 'med_new' },
      data: { controlled: true },
    });
  });

  it('leaves a newly created medicine alone when no NARCOTICS row was staged for it', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ found: false }]),
      medicine: { update: vi.fn() },
    };
    await expect(
      applyLegacyControlledToMedicine(db as never, 'org_a', {
        id: 'med_new',
        productName: 'Synthetic Paracetamol',
        controlled: false,
      })
    ).resolves.toBe(false);
    expect(db.medicine.update).not.toHaveBeenCalled();
    // Already controlled, or nameless: no query, never cleared.
    for (const medicine of [
      { id: 'a', productName: 'Synthetic Opioid', controlled: true },
      { id: 'b', productName: null, controlled: false },
    ]) {
      await expect(applyLegacyControlledToMedicine(db as never, 'org_a', medicine)).resolves.toBe(
        false
      );
    }
    expect(db.$queryRaw).toHaveBeenCalledOnce();
  });

  it('the manual reference import reads the legacy class as controlled', async () => {
    const result = await new ManualFileConnector().fetch({
      batchId: 'batch_a',
      fileName: 'legacy.csv',
      retrievedAt: '2026-11-18T00:00:00.000Z',
      mapping: { productName: 'Name', strength: 'S', dosageForm: 'F', pack: 'P' },
      rows: [
        { Name: 'Synthetic Opioid', classname: ' narcotics ', S: '50mg', F: 'Tablet', P: '10' },
        { Name: 'Synthetic Drops', classname: 'NARCOTIC', S: '5mg', F: 'Drops', P: '1' },
        {
          Name: 'Synthetic Paracetamol',
          classname: 'Example Distributors',
          S: '500mg',
          F: 'Tablet',
          P: '10',
        },
      ],
    });
    const [opioid, drops, paracetamol] = result.rows;
    expect(opioid!.values.controlled).toBe('true');
    expect(opioid!.assertions).toContainEqual(
      expect.objectContaining({ field: 'controlled', value: 'true' })
    );
    expect(opioid!.blockingIssues).toEqual([]);
    expect(drops!.values.controlled).toBeUndefined();
    expect(paracetamol!.values.controlled).toBeUndefined();
  });

  it('a flagged medicine needs the usual verification at sale; an ordinary one does not', () => {
    const line = (controlled: boolean) => ({
      ref: controlled ? 'line_controlled' : 'line_ordinary',
      medicine: {
        medicineId: controlled ? 'med_opioid' : 'med_paracetamol',
        displayName: controlled ? 'Synthetic Opioid 50mg' : 'Synthetic Paracetamol',
        rx: false,
        controlled,
        restricted: false,
        highAlert: false,
        lasa: false,
        coldChain: false,
      },
      blocked: [],
      prescription: null,
      requestedCanonicalUnits: 1,
      nearestSafeExpiry: null,
      discountMinor: 0,
    });
    const at = new Date('2026-11-18T10:00:00Z');
    const controlledAlerts = counterAlertsFor([line(true)], { at });
    expect(controlledAlerts.map((alert) => alert.code)).toContain(
      'CONTROLLED_WITHOUT_PRESCRIPTION'
    );
    expect(hasBlockingAlert(controlledAlerts)).toBe(true);
    const ordinary = counterAlertsFor([line(false)], { at });
    expect(hasBlockingAlert(ordinary)).toBe(false);
  });
});
