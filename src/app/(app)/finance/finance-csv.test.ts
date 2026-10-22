import { describe, expect, it } from 'vitest';

import { financeCsvCell } from './finance-csv';

describe('finance CSV cells', () => {
  it.each(['=HYPERLINK("https://example.invalid")', '+SUM(A1:A2)', '-1+2', '@SUM(A1)'])(
    'neutralizes a formula-leading description, project, or client value: %s',
    (value) => {
      expect(financeCsvCell(value)).toBe(`"'${value.replaceAll('"', '""')}"`);
    }
  );

  it('preserves ordinary text while escaping CSV quotes', () => {
    expect(financeCsvCell('Project "North"')).toBe('"Project ""North"""');
  });
});
