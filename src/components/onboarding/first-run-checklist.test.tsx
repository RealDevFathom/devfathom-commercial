import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { evaluateSetupChecklist } from '@/lib/onboarding/setup-evaluator';
import { FirstRunChecklist } from './first-run-checklist';

const evidence = {
  hasBranch: true,
  hasProvisionedRoles: true,
  hasStationOrPrinter: false,
  hasCatalog: false,
  hasOpeningStock: false,
  hasTax: false,
  hasFirstSale: false,
};

describe('FirstRunChecklist', () => {
  it('shows every data-derived row with a status, reason, and exact action link', () => {
    render(<FirstRunChecklist checklist={evaluateSetupChecklist('RESTAURANT', evidence)} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByText('Stations and printers')).toBeVisible();
    expect(screen.getByText('Optional')).toBeVisible();
    expect(screen.getByRole('link', { name: /set up a menu/i })).toHaveAttribute(
      'href',
      '/restaurant/menus'
    );
    expect(screen.getByRole('link', { name: /make a test sale/i })).toHaveAttribute('href', '/pos');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('does not render after all required evidence is complete', () => {
    const complete = evaluateSetupChecklist('PHARMACY', {
      ...evidence,
      hasCatalog: true,
      hasOpeningStock: true,
      hasFirstSale: true,
    });
    const { container } = render(<FirstRunChecklist checklist={complete} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links pharmacy first sale to the keyboard-first counter', () => {
    render(<FirstRunChecklist checklist={evaluateSetupChecklist('PHARMACY', evidence)} />);
    expect(screen.getByRole('link', { name: /make a test sale/i })).toHaveAttribute(
      'href',
      '/pharmacy/counter'
    );
  });
});
