import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PharmacistHome, pharmacistLanding } from './pharmacist-home';

const DISPENSING = ['pharmacy-core', 'pharmacy-dispensing', 'pharmacy-reports'];

describe('pharmacistLanding (DEV-95)', () => {
  it('sends a pharmacist to the pharmacist queue first', () => {
    const landing = pharmacistLanding(['pharmacy:dispense', 'pharmacy:prescriptions'], DISPENSING);
    expect(landing?.home).toBe('/pharmacy/pharmacist-queue');
    expect(landing?.tools.map((tool) => tool.label)).toEqual(['Pharmacist queue', 'Prescriptions']);
  });

  it('does not treat prescriptions alone (a tenant administrator) as a pharmacist', () => {
    expect(pharmacistLanding(['pharmacy:prescriptions'], DISPENSING)).toBeNull();
    expect(
      pharmacistLanding(['pharmacy:prescriptions'], ['pharmacy-core', 'pharmacy-dispensing'])
    ).toBeNull();
  });

  it('lists only the tools the pharmacist holds', () => {
    expect(pharmacistLanding(['pharmacy:dispense'], DISPENSING)?.tools.map((t) => t.href)).toEqual([
      '/pharmacy/pharmacist-queue',
    ]);
  });

  it('leaves report holders and non-pharmacists on the command centre', () => {
    expect(pharmacistLanding(['reports:operational', 'pharmacy:dispense'], DISPENSING)).toBeNull();
    expect(pharmacistLanding(['pharmacy:counter'], DISPENSING)).toBeNull();
    expect(pharmacistLanding([], DISPENSING)).toBeNull();
  });

  it('sends a report holder to their pharmacist tools when Pharmacy Reports is not licensed', () => {
    const landing = pharmacistLanding(
      ['reports:operational', 'pharmacy:dispense'],
      ['pharmacy-core', 'pharmacy-dispensing']
    );
    expect(landing?.home).toBe('/pharmacy/pharmacist-queue');
  });

  it('keeps a report holder on the package notice when neither Reports nor Dispensing is licensed', () => {
    expect(
      pharmacistLanding(['reports:operational', 'pharmacy:dispense'], ['pharmacy-core'])
    ).toBeNull();
  });

  it('offers no tool and no redirect without Pharmacy Dispensing', () => {
    expect(pharmacistLanding(['pharmacy:dispense'], ['pharmacy-core'])).toEqual({
      tools: [],
      home: null,
    });
  });
});

describe('PharmacistHome', () => {
  it('links to the pharmacist queue and prescriptions without any branch error', () => {
    const landing = pharmacistLanding(['pharmacy:dispense', 'pharmacy:prescriptions'], DISPENSING)!;
    render(<PharmacistHome tools={landing.tools} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Pharmacist home' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Pharmacist queue' })).toHaveAttribute(
      'href',
      '/pharmacy/pharmacist-queue'
    );
    expect(screen.getByRole('link', { name: 'Go to Prescriptions' })).toHaveAttribute(
      'href',
      '/pharmacy/prescriptions'
    );
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Owner command centre')).not.toBeInTheDocument();
  });

  it('explains a missing Dispensing module rather than showing dead links', () => {
    render(<PharmacistHome tools={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Pharmacy Dispensing');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
