import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// DEV-750 document contract. The receipt designer plan must stay a plan: it may
// not lock fiscal fields or FBR QR rules without a recorded owner/legal sign-off,
// and it may not claim compliance or physical print success.

const DOC = 'docs/pharmacy/receipt-designer-plan-DEV-750.md';
const doc = readFileSync(join(process.cwd(), DOC), 'utf8');

function section(heading: string): string {
  const start = doc.indexOf(`\n${heading}`);
  expect(start, `missing heading ${heading}`).toBeGreaterThan(-1);
  const next = doc.indexOf('\n## ', start + heading.length + 1);
  return doc.slice(start, next === -1 ? undefined : next);
}

describe('pharmacy receipt designer plan document', () => {
  it('opens as planning only with an owner/legal sign-off banner', () => {
    expect(doc).toContain('PLANNING ONLY — NOT AN IMPLEMENTATION AUTHORIZATION.');
    expect(doc).toContain('OWNER/LEGAL SIGN-OFF REQUIRED.');
  });

  it('has the design, dependency map, field checklist, acceptance and test plan', () => {
    for (const heading of [
      '## 2. What exists today (FACT, code)',
      '## 3. Proposed design (PROPOSED)',
      '## 4. Dependency map',
      '## 5. Official-source field checklist (SIGN-OFF REQUIRED)',
      '## 6. Acceptance criteria',
      '## 7. Test plan',
      '## 9. Owner/legal sign-off record',
    ]) {
      expect(doc, heading).toContain(heading);
    }
  });

  it('names every issue it coordinates with', () => {
    const deps = section('## 4. Dependency map');
    for (const issue of ['DEV-742', 'DEV-636', 'DEV-100', 'DEV-680', 'DEV-354', 'DEV-744']) {
      expect(deps, issue).toContain(issue);
    }
  });

  it('marks every fiscal checklist row as needing sign-off', () => {
    const checklist = section('## 5. Official-source field checklist (SIGN-OFF REQUIRED)');
    const rows = checklist
      .split('\n')
      .filter((line) => line.startsWith('| ') && !/^\| (Field|Item) /.test(line))
      .filter((line) => !/^\|[\s-|]+\|$/.test(line))
      .filter((line) => line.split('|').length >= 6);
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const row of rows) expect(row, row).toMatch(/SIGN-OFF REQUIRED \|$/);
  });

  it('keeps the FBR QR size and fiscal data rules unresolved and gated', () => {
    expect(section('### 5.3 FBR QR size conflict (SIGN-OFF REQUIRED)')).toContain(
      'This plan does not pick one.'
    );
    const fiscal = section('### 3.4 Fiscal data rule (SIGN-OFF REQUIRED)');
    expect(fiscal).toContain('`SANDBOX` output');
    expect(fiscal).toContain('receiptFiscalFields()');
  });

  it('records no sign-off yet', () => {
    const record = section('## 9. Owner/legal sign-off record');
    const rows = record.split('\n').filter((line) => /^\| (?!Item |---)/.test(line));
    expect(rows.length).toBe(4);
    for (const row of rows) expect(row, row).toMatch(/\| Pending \|$/);
  });

  it('makes no compliance or physical success claim', () => {
    expect(doc).not.toMatch(/\bis (FBR[- ])?compliant\b/i);
    expect(doc).toContain('A preview or automated test is never evidence of');
  });
});
