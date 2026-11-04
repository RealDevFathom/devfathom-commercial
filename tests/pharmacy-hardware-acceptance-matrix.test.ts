import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// DEV-744 document contract. This guards the *honesty* of the hardware acceptance
// matrix: it cannot prove any device works, and it must never be edited into a
// document that claims one does without a recorded evidence pack.

const DOC = 'docs/pharmacy/hardware-acceptance-matrix.md';
const doc = readFileSync(join(process.cwd(), DOC), 'utf8');

function section(heading: string): string {
  const start = doc.indexOf(`\n${heading}`);
  expect(start, `missing heading ${heading}`).toBeGreaterThan(-1);
  const next = doc.indexOf('\n## ', start + heading.length + 1);
  return doc.slice(start, next === -1 ? undefined : next);
}

const tableRows = (text: string) =>
  text.split('\n').filter((line) => /^\| (HW-[A-Z]+-\d{2}) /.test(line));

describe('hardware acceptance matrix document', () => {
  it('opens with the no-acceptance banner', () => {
    expect(doc).toContain('NO PHYSICAL ACCEPTANCE HAS BEEN PERFORMED');
  });

  it('has every required section', () => {
    for (const heading of [
      '## 1. Reading this document',
      '## 2. What exists today',
      '## 3. Dependencies and owners',
      '## 4. Information needed before any physical test',
      '## 5. Test matrices',
      '## 6. Cross-cutting checks',
      '## 7. Prioritised blockers',
      '## 8. Safety rules and stop conditions',
      '## 9. Evidence pack',
      '## 10. Untested compatibility register',
    ]) {
      expect(doc, heading).toContain(heading);
    }
  });

  it('names every owning issue and every issue it must not duplicate', () => {
    for (const issue of [
      'DEV-740',
      'DEV-741',
      'DEV-742',
      'DEV-743',
      'DEV-745',
      'DEV-92',
      'DEV-575',
      'DEV-734',
      'DEV-713',
      'DEV-90',
      'DEV-636',
      'DEV-82',
    ]) {
      expect(doc, issue).toContain(issue);
    }
  });

  it('covers all four device families with test rows', () => {
    const rows = tableRows(section('## 5. Test matrices'));
    for (const family of ['CAM', 'PRN', 'SCN', 'PAY']) {
      expect(
        rows.filter((row) => row.startsWith(`| HW-${family}-`)).length,
        family
      ).toBeGreaterThanOrEqual(8);
    }
  });

  it('gives every test row a unique ID and an UNTESTED status', () => {
    const rows = tableRows(section('## 5. Test matrices'));
    const ids = rows.map((row) => row.split('|')[1]!.trim());
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim());
      // | ID | Check | Method | Expected | Evidence | Prerequisite | Status |
      expect(cells.at(-2), row).toBe('UNTESTED');
    }
  });

  it('never records a PASS or FAIL result for a device', () => {
    const rows = tableRows(doc).join('\n');
    expect(rows).not.toMatch(/\|\s*(PASS|FAIL)\s*\|/);
    expect(doc).not.toMatch(/\b(hardware|physical) acceptance (is )?(complete|passed|achieved)\b/i);
    expect(doc).not.toMatch(/\b(verified|certified|accepted) (compatible|compatibility)\b/i);
  });

  it('keeps the unconfirmed DVR brand unconfirmed', () => {
    expect(doc).toContain('"Al Hua" is unconfirmed');
    expect(doc).not.toMatch(/Al Hua[^.\n]{0,60}(is|are) (a )?(Dahua|compatible)/i);
  });

  it('separates every evidence class and keeps manual tender out of integration', () => {
    for (const label of [
      'REAL-INTEGRATION',
      'SIMULATOR',
      'GENERATED-FILE',
      'BROWSER-OS-DIALOG',
      'MANUAL-TENDER',
      'NOT-IMPLEMENTED',
    ]) {
      expect(doc, label).toContain(label);
    }
    expect(doc).toContain('must never be reported as terminal integration');
  });

  it('lists the stop conditions the issue forbids by default', () => {
    const rules = section('## 8. Safety rules and stop conditions');
    for (const phrase of ['DVR', 'password', 'Installing software', 'firewalls', 'live card']) {
      expect(rules, phrase).toContain(phrase);
    }
  });

  it('prioritises blockers P0 before P1 before P2 before P3', () => {
    const priorities = [...section('## 7. Prioritised blockers').matchAll(/\| (P[0-3]) \|/g)].map(
      (match) => Number(match[1]![1])
    );
    expect(priorities.length).toBeGreaterThanOrEqual(8);
    expect([...priorities].sort()).toEqual(priorities);
    expect(priorities).toContain(0);
  });

  it('only cites repository paths that exist', () => {
    const cited = new Set(
      [...doc.matchAll(/`((?:src|scripts|tests)\/[^`\s]+)`/g)].map((match) => match[1]!)
    );
    expect(cited.size).toBeGreaterThan(10);
    for (const path of cited) {
      if (/[*<>{}]/.test(path)) continue;
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
  });

  it('contains no credential-shaped text', () => {
    expect(doc).not.toMatch(/rtsp:\/\/[^\s)]*@/i);
    expect(doc).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(doc).not.toMatch(/\b(?:\d[ -]?){15}\d\b/);
    expect(doc).not.toMatch(/(password|token|secret)\s*[:=]\s*\S+/i);
  });
});
