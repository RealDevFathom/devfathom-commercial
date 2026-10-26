import { describe, expect, it } from 'vitest';

import { financeCsvCell } from './finance-csv';

describe('financeCsvCell', () => {
  it.each(['=HYPERLINK("https://example.com")', '+cmd', '-danger', '@SUM(A1:A2)'])(
    'neutralizes formula-leading agency finance text: %s',
    (value) => {
      expect(financeCsvCell(value)).toBe(`"'${value.replaceAll('"', '""')}"`);
    }
  );

  it('quotes ordinary text without changing it', () => {
    expect(financeCsvCell('Client "A"')).toBe('"Client ""A"""');
  });

  it('keeps negative numeric amounts numeric', () => {
    expect(financeCsvCell(-125)).toBe('"-125"');
  });
});
