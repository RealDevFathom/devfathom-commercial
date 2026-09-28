import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FinancialComparisonExportButton,
  type FinancialComparisonExportFile,
} from './financial-comparison-export';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const file: FinancialComparisonExportFile = {
  csv: 'Current,Previous\r\nPKR 9007199254740993.01,Unavailable',
  filename: 'restaurant-financial-comparison-2026-09-01-to-2026-09-07.csv',
  identity: { branchIds: ['branch-1'], from: '2026-09-01', to: '2026-09-07' },
};
const initial = '/restaurant/reports?branch=branch-1&from=2026-09-01&to=2026-09-07';
const button = () => screen.getByRole('button', { name: 'Export comparison CSV' });

describe('Financial comparison download', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', initial);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:comparison');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it.each([
    '?branch=branch-2&from=2026-09-01&to=2026-09-07',
    '?branch=branch-1&from=2026-09-02&to=2026-09-07',
    '?branch=branch-1&from=2026-09-01&to=2026-09-08',
    '?branch=branch-1&branch=branch-2',
    '?from=2026-09-01&from=2026-09-02',
    '?to=',
  ])('disables mismatched or ambiguous applied filters %s', (search) => {
    window.history.replaceState({}, '', `/restaurant/reports${search}`);
    render(createElement(FinancialComparisonExportButton, { file }));
    expect(button()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Filters changed');
    fireEvent.click(button());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('denies a URL change before React receives it', () => {
    render(createElement(FinancialComparisonExportButton, { file }));
    window.history.replaceState({}, '', `${initial}&branch=branch-2`);
    fireEvent.click(button());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Filters changed');
  });

  it('keeps the old response disabled until a new response identity arrives', () => {
    const view = render(
      createElement(FinancialComparisonExportButton, { file, key: 'response-1' })
    );
    window.history.replaceState(
      {},
      '',
      '/restaurant/reports?branch=branch-2&from=2026-09-01&to=2026-09-07'
    );
    view.rerender(createElement(FinancialComparisonExportButton, { file, key: 'response-1' }));
    expect(button()).toBeDisabled();
    const next = {
      ...file,
      identity: { ...file.identity, branchIds: ['branch-2'] },
      csv: 'replacement response',
    };
    view.rerender(
      createElement(FinancialComparisonExportButton, { file: next, key: 'response-2' })
    );
    expect(button()).toBeEnabled();
    fireEvent.click(button());
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it('rejects cleared filters against an old explicit-period response', () => {
    const view = render(createElement(FinancialComparisonExportButton, { file }));
    window.history.replaceState({}, '', '/restaurant/reports');
    view.rerender(createElement(FinancialComparisonExportButton, { file }));
    expect(button()).toBeDisabled();
    fireEvent.click(button());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each(['', '?branch=all', '?branch=branch-1&stockLocation=irrelevant'])(
    'allows the existing resolved scope %s',
    (search) => {
      window.history.replaceState({}, '', `/restaurant/reports${search}`);
      render(createElement(FinancialComparisonExportButton, { file }));
      expect(button()).toBeEnabled();
      fireEvent.click(button());
      expect(URL.createObjectURL).toHaveBeenCalledOnce();
    }
  );

  it('exports an authorized all-branch response only under all-branch filters', () => {
    window.history.replaceState({}, '', '/restaurant/reports?branch=all');
    const all = { ...file, identity: { ...file.identity, branchIds: ['branch-1', 'branch-2'] } };
    const view = render(createElement(FinancialComparisonExportButton, { file: all, key: 'all' }));
    expect(button()).toBeEnabled();
    window.history.replaceState({}, '', '/restaurant/reports?branch=branch-1');
    view.rerender(createElement(FinancialComparisonExportButton, { file: all, key: 'new' }));
    expect(button()).toBeDisabled();
  });

  it('denies an empty scope and a subsequently withdrawn artifact', () => {
    const view = render(
      createElement(FinancialComparisonExportButton, {
        file: { ...file, identity: { ...file.identity, branchIds: [] } },
      })
    );
    expect(button()).toBeDisabled();
    view.rerender(createElement(FinancialComparisonExportButton, { file }));
    expect(button()).toBeEnabled();
    view.rerender(createElement(FinancialComparisonExportButton, { file: null }));
    expect(button()).toBeDisabled();
    fireEvent.click(button());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each(['create', 'click'] as const)(
    'shows actionable download failure and cleans allocated resources: %s',
    (stage) => {
      const fail = () => {
        throw new Error('Download unavailable');
      };
      if (stage === 'create') vi.mocked(URL.createObjectURL).mockImplementationOnce(fail);
      else vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(fail);
      render(createElement(FinancialComparisonExportButton, { file }));
      fireEvent.click(button());
      expect(screen.getByRole('status')).toHaveTextContent('CSV download could not start');
      expect(button()).toHaveAttribute('aria-describedby', screen.getByRole('status').id);
      expect(document.querySelector('a[download]')).toBeNull();
      if (stage === 'click') expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:comparison');
      else expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      fireEvent.click(button());
      expect(screen.queryByRole('status')).toBeNull();
      expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    }
  );
});
