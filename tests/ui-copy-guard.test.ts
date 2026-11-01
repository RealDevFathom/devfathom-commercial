// @vitest-environment node
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GLOBAL_RULES,
  PHARMACY_JARGON_RULES,
  extractCopyStrings,
  findViolations,
  formatViolations,
  isPharmacyScreen,
  scanBannedPhrases,
  scanRepository,
} from './ui-copy/ui-copy-guard';

const ALL_RULES = [...GLOBAL_RULES, ...PHARMACY_JARGON_RULES];

function rulesHit(source: string) {
  return findViolations('sample.tsx', source, ALL_RULES).map((v) => v.rule);
}

describe('ui copy guard — detection', () => {
  it('flags internal requirement codes in eyebrows, JSX text and copy fields', () => {
    expect(rulesHit(`export const A = () => <SectionCard eyebrow="INV-06" title="Count" />;`)).toContain(
      'requirement-code'
    );
    expect(rulesHit(`export const A = () => <p>That is the PUR-01 gate.</p>;`)).toContain('requirement-code');
    expect(rulesHit(`export const A = () => <Card eyebrow={\`INV-09 · within \${n} days\`} />;`)).toContain(
      'requirement-code'
    );
    expect(rulesHit(`const TABS = [{ label: 'Goods in', requirement: 'PUR-02/04/05' }];`)).toContain(
      'requirement-code'
    );
    expect(rulesHit(`export const A = () => <SectionCard eyebrow="CRM-L01" />;`)).toContain('requirement-code');
    expect(rulesHit(`export const A = () => <Header eyebrow="Pharmacy · RX-03" />;`)).toContain(
      'requirement-code'
    );
  });

  it('flags raw table names, permission tags, ISO timestamps and release hedges', () => {
    expect(rulesHit(`export const A = () => <p>Source: pharmacy_sales + pharmacy_sale_lines</p>;`)).toContain(
      'table-name'
    );
    expect(rulesHit(`export const A = () => <Card eyebrow="REPORTS:FINANCIAL" />;`)).toContain('permission-key');
    expect(rulesHit(`export const A = () => <p>Read at 2026-11-01T14:59:01.182Z</p>;`)).toContain(
      'iso-timestamp'
    );
    expect(rulesHit(`export const A = ({ at }) => <p>Read at {at.toISOString()}</p>;`)).toContain(
      'iso-timestamp'
    );
    expect(rulesHit('export const A = ({ at }) => <p>{`As of ${at.toISOString()}`}</p>;')).toContain(
      'iso-timestamp'
    );
    expect(
      rulesHit(
        `export const A = ({ at }) => <time dateTime={at.toISOString()}>{at.toISOString().slice(0, 10)}</time>;`
      )
    ).not.toContain('iso-timestamp');
    expect(rulesHit(`export const A = () => <Input name="from" placeholder="2026-10-01T00:00:00Z" />;`)).not.toContain(
      'iso-timestamp'
    );
    expect(rulesHit(`export const A = () => <p>{ok ? 'PKR 0' : 'Not available in this release'}</p>;`)).toContain(
      'release-hedge'
    );
    expect(rulesHit(`export const A = () => <p>Anomaly reader caps at 200.</p>;`)).toContain('dev-note');
  });

  it('flags pharmacy jargon', () => {
    const source = `export const A = () => (
      <>
        <SectionCard title="Lots and FEFO board" />
        <span>Ledger projection</span>
        <label>Requested canonical units</label>
        <Button>Capture shortfall: 1 canonical units</Button>
        <label>Original custody</label>
        <p>Its pack hierarchy does not match.</p>
        <p>then sign to release.</p>
        <Stat label="Orderable suppliers" />
      </>
    );`;
    const hits = new Set(rulesHit(source));
    for (const id of [
      'fefo',
      'ledger-projection',
      'canonical-unit',
      'capture-shortfall',
      'original-custody',
      'pack-hierarchy',
      'sign-to-release',
      'orderable-suppliers',
    ]) {
      expect(hits, id).toContain(id);
    }
  });

  it('ignores comments, class names, hrefs, keys and non-copy identifiers', () => {
    const source = `
      // PUR-01: supplier gate lives in src/lib (pharmacy_suppliers)
      const POLICY = 'PUR-02:SEGREGATION_OF_DUTIES';
      export const A = () => (
        <div className={cn('INV-06', 'pharmacy_x')} data-requirement="POS-02" key="RX-03">
          {/* INV-06 frozen snapshot */}
          <a href="/pharmacy/reports?permission=reports:financial">Open report</a>
          <Card eyebrow="Stock count" title="Physical count" />
        </div>
      );`;
    expect(findViolations('sample.tsx', source, ALL_RULES)).toEqual([]);
  });

  it('extracts JSX text and conditional copy', () => {
    const texts = extractCopyStrings(
      `export const A = ({ ok }) => <p title="Hint">{ok ? 'Ready' : 'Not ready'} now</p>;`
    ).map((s) => s.text);
    expect(texts).toEqual(expect.arrayContaining(['Hint', 'Ready', 'Not ready', 'now']));
  });

  it('applies jargon rules to pharmacy screens only', () => {
    expect(isPharmacyScreen('src/app/(app)/pharmacy/inventory/page.tsx')).toBe(true);
    expect(isPharmacyScreen('src/components/pharmacy/counter/counter-console.tsx')).toBe(true);
    expect(isPharmacyScreen('src/app/(app)/dashboard/pharmacy-dashboard-content.tsx')).toBe(true);
    expect(isPharmacyScreen('src/app/(app)/restaurant/reports/page.tsx')).toBe(false);
  });
});

describe('ui copy guard — repository', () => {
  const repoRoot = resolve('.');

  it('keeps internal codes, table names, permission keys, ISO timestamps and jargon out of UI strings', () => {
    const violations = scanRepository(repoRoot);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('keeps release hedges and developer notes out of shipped source', () => {
    const violations = scanBannedPhrases(repoRoot);
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});
