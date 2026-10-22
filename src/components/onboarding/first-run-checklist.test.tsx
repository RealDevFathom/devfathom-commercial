import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { evaluateSetupChecklist } from '@/lib/onboarding/setup-evaluator';
import { VERTICALS } from '@/lib/vertical-catalog';
import { FirstRunChecklist } from './first-run-checklist';

const verticalFixtures = Object.values(VERTICALS).filter(
  (definition) => definition.firstRunChecklist.length > 0
);
const restaurant = verticalFixtures.find((definition) => definition.label === 'Restaurant')!;
const pharmacy = verticalFixtures.find((definition) => definition.label === 'Pharmacy')!;

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
    render(<FirstRunChecklist checklist={evaluateSetupChecklist(restaurant.vertical, evidence)} />);

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
    const complete = evaluateSetupChecklist(pharmacy.vertical, {
      ...evidence,
      hasCatalog: true,
      hasOpeningStock: true,
      hasFirstSale: true,
    });
    const { container } = render(<FirstRunChecklist checklist={complete} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links pharmacy first sale to the keyboard-first counter', () => {
    render(<FirstRunChecklist checklist={evaluateSetupChecklist(pharmacy.vertical, evidence)} />);
    expect(screen.getByRole('link', { name: /make a test sale/i })).toHaveAttribute(
      'href',
      '/pharmacy/counter'
    );
  });
});

it('keeps incomplete setup visible even when the restaurant has a settled sale', () => {
  render(
    <FirstRunChecklist
      checklist={evaluateSetupChecklist(restaurant.vertical, {
        ...evidence,
        hasFirstSale: true,
      })}
    />
  );
  expect(screen.getByTestId('first-run-checklist')).toBeVisible();
  expect(screen.getByRole('link', { name: /set up a menu/i })).toBeVisible();
});

it('hides the restaurant checklist once every required step is complete', () => {
  const { container } = render(
    <FirstRunChecklist
      checklist={evaluateSetupChecklist(restaurant.vertical, {
        ...evidence,
        hasCatalog: true,
        hasTax: true,
        hasFirstSale: true,
      })}
    />
  );
  expect(container).toBeEmptyDOMElement();
});
