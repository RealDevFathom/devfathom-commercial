import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  gateways: [
    { id: 'gateway-internal', name: 'Main gateway', branchId: 'branch-1', status: 'ACTIVE' },
  ],
  onTest: vi.fn(async () => ({ outcome: 'ok' as const, discoveredProfile: 'Profile S' })),
  onSubmit: vi.fn(async () => undefined),
};

describe('RestaurantCameraWizard', () => {
  function fill() {
    fireEvent.change(selectFieldControl(screen.getByLabelText('Camera name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'Kitchen' } });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Camera gateway', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'gateway-internal' },
    });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Host / stream source', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Kitchen channel' },
    });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Username', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'reader' } });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Password', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'fixture-password' } });
  }
  test('owner-provisioned registration preserves inputs without a simulated check or unused port', async () => {
    const onTest = vi.fn(),
      onSubmit = vi.fn(async () => undefined);
    render(
      <RestaurantCameraWizard
        branches={branch}
        presets={[]}
        {...callbacks}
        ownerProvisioned
        onTest={onTest}
        onSubmit={onSubmit}
      />
    );
    expect(screen.getByText(/does not configure the DVR/)).toBeVisible();
    expect(screen.queryByLabelText('RTSP port', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Register camera' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        branchId: 'branch-1',
        gatewayId: 'gateway-internal',
        name: 'Kitchen',
        sourceRef: 'Kitchen channel',
        username: 'reader',
        password: 'fixture-password',
        registerAnyway: false,
      })
    );
    expect(onTest).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('Check configured connection');
  });
  test('CAM-3: registers a kitchen or counter preset and never offers cold chain', async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(
      <RestaurantCameraWizard
        branches={branch}
        presets={[]}
        {...callbacks}
        ownerProvisioned
        onSubmit={onSubmit}
      />
    );
    const watches = screen.getByLabelText('Watches', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    expect(
      Array.from(selectFieldControl((watches as HTMLSelectElement)).options).map((option) => option.textContent)
    ).toEqual(['Not set', 'Kitchen', 'Counter']);
    fill();
    fireEvent.change(selectFieldControl(watches), { target: { value: 'KITCHEN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register camera' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ preset: 'KITCHEN' }))
    );
  });
  test('registration failure preserves values and displays a safe error', async () => {
    render(
      <RestaurantCameraWizard
        branches={branch}
        presets={[]}
        {...callbacks}
        ownerProvisioned
        onSubmit={async () => {
          throw new Error('sensitive upstream detail');
        }}
      />
    );
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Register camera' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Registration failed')
    );
    expect(selectFieldControl(screen.getByLabelText('Camera name', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('Kitchen');
    expect(screen.queryByText('sensitive upstream detail')).not.toBeInTheDocument();
  });
  test('legacy connection rejection is handled locally', async () => {
    render(
      <RestaurantCameraWizard
        branches={branch}
        presets={[]}
        {...callbacks}
        onTest={async () => {
          throw new Error('precondition');
        }}
      />
    );
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Connection check failed')
    );
  });
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
    expect(screen.getByLabelText('Camera name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeVisible();
    expect(screen.getByLabelText('Password', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeVisible();
    expect(selectFieldControl(screen.getByRole('option', { hidden: true, name: 'Main gateway — active' }))).toHaveValue(
      'gateway-internal'
    );
  });
  test('enables the gateway choice when one branch arrives asynchronously', () => {
    const view = render(<RestaurantCameraWizard branches={[]} presets={[]} {...callbacks} />);
    expect(screen.getByLabelText('Camera gateway', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeDisabled();

    view.rerender(<RestaurantCameraWizard branches={branch} presets={[]} {...callbacks} />);
    expect(screen.getByLabelText('Camera gateway', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeEnabled();
    expect(selectFieldControl(screen.getByRole('option', { hidden: true, name: 'Main gateway — active' }))).toHaveValue(
      'gateway-internal'
    );
  });
});
