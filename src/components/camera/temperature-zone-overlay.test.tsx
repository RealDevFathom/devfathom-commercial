import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { CameraTile } from './camera-tile';
import { TemperatureZoneOverlay } from './temperature-zone-overlay';

const zone = {
  minimumTemperatureC: 2,
  maximumTemperatureC: 8,
  latestRecordedAt: '2026-10-02T03:00:00.000Z',
  latestTemperatureC: 10.2,
};

describe('TemperatureZoneOverlay', () => {
  test('renders the bound zone status, reading and range over the camera picture', () => {
    render(
      <CameraTile
        name="Fridge camera"
        preset="COLD_CHAIN"
        media="No still captured yet"
        overlay={
          <TemperatureZoneOverlay
            zoneName="Vaccine fridge"
            zone={{ ...zone, status: 'EXCURSION' }}
          />
        }
      />
    );
    const overlay = screen.getByRole('status', { name: 'Vaccine fridge temperature: Excursion' });
    expect(overlay).toHaveTextContent('Excursion');
    expect(overlay).toHaveTextContent('10.2 °C');
    expect(overlay).toHaveTextContent('range 2–8 °C');
    expect(overlay.querySelector('[data-slot="status-pill"]')).toHaveAttribute(
      'data-tone',
      'danger'
    );
    expect(screen.getByRole('heading', { name: 'Fridge camera' })).toBeVisible();
    expect(screen.getByText('Cold chain')).toBeVisible();
  });

  test.each([
    ['IN_RANGE', 'In range', 'success'],
    ['OUT_OF_RANGE_PENDING', 'Out of range', 'warning'],
    ['UNMONITORED', 'Unmonitored', 'warning'],
    ['MONITORED', 'Monitored', 'neutral'],
  ] as const)('maps %s to %s', (status, label, tone) => {
    render(<TemperatureZoneOverlay zoneName="Fridge" zone={{ ...zone, status }} />);
    const overlay = screen.getByRole('status', { name: `Fridge temperature: ${label}` });
    expect(overlay.querySelector('[data-slot="status-pill"]')).toHaveAttribute('data-tone', tone);
  });

  test('reads missing zone evidence as unmonitored, never as in range', () => {
    render(<TemperatureZoneOverlay zoneName="Fridge" zone={null} />);
    const overlay = screen.getByRole('status', { name: 'Fridge temperature: Unmonitored' });
    expect(overlay).toHaveTextContent('no recent reading');
    expect(overlay).not.toHaveTextContent('In range');
  });
});
