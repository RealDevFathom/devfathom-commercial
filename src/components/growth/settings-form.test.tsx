import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { GrowthSettingsView } from '@/lib/growth/view';

import { SettingsForm } from './settings-form';

const settings: GrowthSettingsView = {
  monthlyBudgetMinor: 1_500_000,
  autoApproveUnderMinor: 50_000,
  quietHoursStart: 21,
  quietHoursEnd: 9,
  maxMsgsPerDay: 200,
  maxDiscountPct: 25,
  customDates: ['2026-11-09'],
  waInstanceName: 'sehat-pharmacy',
  waApiUrl: 'http://127.0.0.1:8080',
  waApiKeyHint: '••••9f3a',
};

describe('SettingsForm', () => {
  it('shows budget, quiet hours, and a masked WhatsApp key', () => {
    render(
      <SettingsForm
        settings={settings}
        connection={{ status: 'connected', managerUrl: 'http://127.0.0.1:8080' }}
        save={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Quiet hours start')).toHaveProperty('value', '21');
    expect(screen.getByLabelText('Quiet hours end')).toHaveProperty('value', '9');
    expect(screen.getByLabelText('Monthly budget (PKR)')).toHaveProperty('value', '15000');
    expect(screen.getByLabelText('Auto-approve under (PKR)')).toHaveProperty('value', '500');
    expect(screen.getByText('WhatsApp connected')).toBeTruthy();
    expect(screen.getByLabelText('API key').getAttribute('placeholder')).toMatch(/9f3a/);
    expect(document.body.textContent).not.toContain('fixture-key-9f3a');
  });
});
