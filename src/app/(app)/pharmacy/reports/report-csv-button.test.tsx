// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildReportCsv, ReportCsvButton } from './report-csv-button';

describe('report CSV export', () => {
  it('quotes values, escapes quotes and neutralises formulas', () => {
    const csv = buildReportCsv(
      [
        { label: 'Sales', figure: '£1,200.00' },
        { label: 'Odd "one"', figure: '=SUM(A1)' },
      ],
      { From: '2026-11-01' },
    );
    expect(csv).toBe(
      '"From","2026-11-01"\r\n"Metric","Value"\r\n"Sales","£1,200.00"\r\n"Odd ""one""","\'=SUM(A1)"\r\n',
    );
  });

  it('downloads the file when clicked', () => {
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<ReportCsvButton rows={[{ label: 'A', figure: '1' }]} context={{}} filename="r.csv" />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });
});
