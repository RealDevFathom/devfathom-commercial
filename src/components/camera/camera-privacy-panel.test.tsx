import { render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { CameraPrivacyPanel, cameraSignage } from './camera-privacy-panel';

const view = {
  retentionManaged: true,
  gateways: [
    { id: 'gw-1', name: 'Front gateway', retentionDays: 7 },
    { id: 'gw-2', name: 'Store gateway', retentionDays: 30 },
  ],
  grants: [
    {
      id: 'grant-live',
      cameraName: 'Counter',
      viewerName: 'Ayesha',
      createdAt: '2026-10-02T03:00:00.000Z',
      expiresAt: '2026-10-02T03:01:00.000Z',
      active: true,
    },
    {
      id: 'grant-old',
      cameraName: 'Fridge',
      viewerName: 'Bilal',
      createdAt: '2026-10-01T03:00:00.000Z',
      expiresAt: '2026-10-01T03:01:00.000Z',
      active: false,
    },
  ],
};

function panel(vertical: 'pharmacy' | 'restaurant' = 'pharmacy', overrides = {}) {
  const setRetentionAction = vi.fn();
  const revokeGrantAction = vi.fn();
  render(
    <CameraPrivacyPanel
      vertical={vertical}
      view={{ ...view, ...overrides }}
      setRetentionAction={setRetentionAction}
      revokeGrantAction={revokeGrantAction}
    />
  );
  return { setRetentionAction, revokeGrantAction };
}

describe('CameraPrivacyPanel', () => {
  test('shows English and right-to-left Urdu signage promising the longest retention', () => {
    panel();
    const notice = screen
      .getByRole('heading', { name: 'Camera notice' })
      .closest('[data-slot="section-card"]')!;
    expect(notice).toHaveTextContent('CCTV cameras in operation.');
    expect(notice).toHaveTextContent('monitor medicine refrigerators');
    expect(notice).toHaveTextContent('kept for 30 days');
    const urdu = notice.querySelector('[lang="ur"]')!;
    expect(urdu).toHaveAttribute('dir', 'rtl');
    expect(urdu).toHaveTextContent('سی سی ٹی وی کیمرے زیرِ استعمال ہیں۔');
    expect(urdu).toHaveTextContent('30 دن');
  });

  test('uses restaurant wording on the restaurant page', () => {
    panel('restaurant');
    expect(screen.getByText(/kitchen hygiene/)).toBeVisible();
    expect(screen.queryByText(/refrigerators/)).not.toBeInTheDocument();
    expect(cameraSignage('restaurant', 7).ur[1]).toContain('ریسٹورنٹ');
  });

  test('edits retention per gateway within the supported range', () => {
    panel();
    const input = screen.getByRole('spinbutton', { name: 'Retention days for Store gateway' });
    expect(input).toHaveValue(30);
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '90');
    expect(input).toBeRequired();
    const form = input.closest('form')!;
    expect(form.querySelector('input[name="gatewayId"]')).toHaveValue('gw-2');
    expect(within(form).getByRole('button', { name: 'Save retention' })).toHaveAttribute(
      'type',
      'submit'
    );
  });

  test('lists live-view grants and offers revoke only for active ones', () => {
    panel();
    const revoke = screen.getByRole('button', { name: "Revoke Ayesha's access to Counter" });
    expect(revoke.closest('form')!.querySelector('input[name="grantId"]')).toHaveValue(
      'grant-live'
    );
    expect(screen.getByText(/Bilal · Fridge · opened/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Revoke Bilal/ })).not.toBeInTheDocument();
    expect(screen.getByText('Ended')).toBeVisible();
  });

  test('explains empty states without inventing a retention period', () => {
    panel('pharmacy', { gateways: [], grants: [] });
    expect(screen.getByText('No camera recording is configured.')).toBeVisible();
    expect(screen.getByText('No active camera gateway is enrolled.')).toBeVisible();
    expect(screen.getByText('Nobody has opened a live view yet.')).toBeVisible();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });
});
