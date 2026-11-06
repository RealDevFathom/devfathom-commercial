import { describe, expect, it } from 'vitest';

import { defaultImportTarget, explainImportRow, openingImportHref } from './opening-import';

const MATCH_ERROR =
  'Match exactly one published medicine pack with a valid current conversion, using its barcode or pack ID.';

describe('openingImportHref', () => {
  it('carries the working branch into the single import entry point', () => {
    expect(openingImportHref('branch a')).toBe('/pharmacy/inventory/import?branch=branch+a');
    expect(openingImportHref()).toBe('/pharmacy/inventory/import');
    expect(openingImportHref(null)).toBe('/pharmacy/inventory/import');
  });
});

describe('defaultImportTarget', () => {
  const options = {
    branches: [{ id: 'main' }, { id: 'north' }],
    locations: [
      { id: 'main-back', branchId: 'main', kind: 'RACK_BIN' },
      { id: 'main-hold', branchId: 'main', kind: 'QUARANTINE' },
      { id: 'main-store', branchId: 'main', kind: 'STORE' },
      { id: 'north-fridge', branchId: 'north', kind: 'FRIDGE' },
      { id: 'north-returns', branchId: 'north', kind: 'RETURNS' },
    ],
  };

  it('prefers the working branch and its ordinary store shelf', () => {
    expect(defaultImportTarget(options, 'main')).toEqual({
      branchId: 'main',
      stockLocationId: 'main-store',
    });
  });

  it('never defaults into a holding area when other storage exists', () => {
    expect(defaultImportTarget(options, 'north')).toEqual({
      branchId: 'north',
      stockLocationId: 'north-fridge',
    });
  });

  it('falls back to the first branch for an unknown or missing working branch', () => {
    expect(defaultImportTarget(options, 'other-tenant-branch').branchId).toBe('main');
    expect(defaultImportTarget(options).branchId).toBe('main');
  });

  it('uses a holding area only when it is the sole location, and handles no setup', () => {
    expect(
      defaultImportTarget({
        branches: [{ id: 'b' }],
        locations: [{ id: 'hold', branchId: 'b', kind: 'QUARANTINE' }],
      })
    ).toEqual({ branchId: 'b', stockLocationId: 'hold' });
    expect(defaultImportTarget({ branches: [{ id: 'b' }], locations: [] })).toEqual({
      branchId: 'b',
      stockLocationId: '',
    });
    expect(defaultImportTarget({ branches: [], locations: [] })).toEqual({
      branchId: '',
      stockLocationId: '',
    });
  });

  it('keeps name order among locations of the same kind', () => {
    expect(
      defaultImportTarget({
        branches: [{ id: 'b' }],
        locations: [
          { id: 'first', branchId: 'b', kind: 'STORE' },
          { id: 'second', branchId: 'b', kind: 'STORE' },
        ],
      }).stockLocationId
    ).toBe('first');
  });
});

describe('explainImportRow', () => {
  const line = { medicineName: null, packReference: '1234567890123', unitsPerPack: null };

  it('explains an unmatched pack code and links the catalogue search and reference upload', () => {
    const [problem] = explainImportRow({ ...line, errors: [MATCH_ERROR] });
    expect(problem!.title).toBe('No medicine in your catalogue has pack code 1234567890123');
    expect(problem!.detail).toMatch(/reference upload under Medicine reference connectors/);
    expect(problem!.detail).toMatch(/available after review and publication/);
    expect(problem!.detail).toMatch(/Adding a barcode to an existing pack is not available yet/);
    expect(problem!.detail).not.toMatch(/add this barcode or pack ID/);
    expect(problem!.medicine).toEqual({
      pickHref: '/pharmacy/medicines?query=1234567890123',
      reviewHref: '/pharmacy/medicines',
    });
  });

  it('explains an unknown pack size on a matched medicine and searches by its name', () => {
    const [problem] = explainImportRow({
      ...line,
      medicineName: 'Amoxicillin 250mg Capsules',
      errors: [MATCH_ERROR],
    });
    expect(problem!.title).toBe('Pack size unknown for Amoxicillin 250mg Capsules');
    expect(problem!.detail).toMatch(/units per pack/);
    expect(problem!.medicine!.pickHref).toBe(
      '/pharmacy/medicines?query=Amoxicillin+250mg+Capsules'
    );
  });

  it('explains a matched medicine that is not yet published for sale', () => {
    const [problem] = explainImportRow({
      ...line,
      medicineName: 'Paracetamol',
      unitsPerPack: 10,
      errors: [MATCH_ERROR],
    });
    expect(problem!.title).toBe('Paracetamol is not published for sale yet');
    expect(problem!.medicine).toBeDefined();
  });

  it('handles a row without any pack code', () => {
    const [problem] = explainImportRow({ ...line, packReference: '', errors: [MATCH_ERROR] });
    expect(problem!.title).toBe('No pack code on this row');
    expect(problem!.medicine).toEqual({
      pickHref: '/pharmacy/medicines',
      reviewHref: '/pharmacy/medicines',
    });
  });

  it('turns every known validation message into a plain problem and next step', () => {
    const errors = [
      'Source reference must be nonempty and unique (up to 160 characters).',
      'Supply the printed manufacturing batch (up to 160 characters).',
      'Supply a future expiry as YYYY-MM or YYYY-MM-DD.',
      'MRP and cost must be nonnegative PKR amounts with at most two decimals, within the supported range.',
      'Exported and physical counts must be explicit nonnegative whole base units, within the supported range.',
      'Explain the difference between the exported and physical counts.',
      'This medicine requires a cold-chain stock location.',
      'Duplicate medicine/batch/pack row. Combine its physical count in the source file.',
      'Rows for the same medicine and batch must agree on expiry.',
      'Existing batch is blocked or its expiry conflicts with this row.',
      'This branch already holds a lot for this medicine/batch/pack. Use inventory counts to reconcile it; it cannot be imported twice.',
      'This source reference was already used for this batch in an earlier opening import (possibly another branch). Use a distinct source reference, e.g. prefix it with the branch code.',
    ];
    const problems = explainImportRow({ ...line, errors });
    expect(problems).toHaveLength(errors.length);
    for (const problem of problems) {
      expect(problem.title).not.toBe('This row needs a fix');
      expect(problem.detail.length).toBeGreaterThan(10);
      expect(problem.medicine).toBeUndefined();
    }
  });

  it('keeps an unknown message visible instead of dropping it', () => {
    expect(explainImportRow({ ...line, errors: ['Something new.'] })).toEqual([
      { title: 'This row needs a fix', detail: 'Something new.' },
    ]);
  });

  it('returns nothing for a ready row', () => {
    expect(explainImportRow({ ...line, errors: [] })).toEqual([]);
  });
});
