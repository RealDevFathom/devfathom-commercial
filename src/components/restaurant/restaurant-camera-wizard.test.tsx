import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { RestaurantCameraWizard } from './restaurant-camera-wizard';

const branch = [{ id: 'branch-1', name: 'Main' }];
const preset = {
  key: 'fixture-brand',
  familyName: 'Fixture Brand',
  rtspPort: 554,
  onvifPort: 80,
  mainStreamPathTemplate: '/live',
  defaultUsernameHint: 'admin',
  setupNote: 'Fixture',
};
const callbacks = {
  onTest: vi.fn(async () => ({ outcome: 'ok' as const, discoveredProfile: 'Profile S' })),
  onSubmit: vi.fn(async () => undefined),
};

describe('RestaurantCameraWizard', () => {
  test('renders database-provided brands and the equally reachable manual choice', () => {
    render(<RestaurantCameraWizard branches={branch} presets={[preset]} {...callbacks} />);
    expect(screen.getByRole('button', { name: 'Fixture Brand' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Using another brand? Configure manually' })
    ).toBeVisible();
  });
  test('opens the manual details form when the catalog is empty', () => {
    render(<RestaurantCameraWizard branches={branch} presets={[]} {...callbacks} />);
    expect(screen.getByText('Using another brand? Configure manually')).toBeVisible();
    expect(screen.getByLabelText('Camera name')).toBeVisible();
    expect(screen.getByLabelText('Password')).toBeVisible();
  });
});
