import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./earn-rate-actions', () => ({ saveEarnRate: vi.fn() }));
import { OnboardingLoyaltyStep } from './onboarding-loyalty-step';

afterEach(cleanup);

const presets = [{ id: 'percent-1', label: '1% of spend' }];

describe('DEV-814 onboarding loyalty step', () => {
  it('asks the question without preselecting an answer or showing a rate form', () => {
    render(<OnboardingLoyaltyStep presets={presets} />);
    expect(screen.getByRole('group', { name: 'Enable the loyalty programme?' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Yes, customers earn points' })).toHaveProperty(
      'checked',
      false
    );
    expect(screen.getByRole('radio', { name: 'No, not now' })).toHaveProperty('checked', false);
    expect(screen.queryByRole('button', { name: 'Save earning rate' })).toBeNull();
  });

  it('opens the existing earning-rate form when the owner says yes', () => {
    render(<OnboardingLoyaltyStep presets={presets} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Yes, customers earn points' }));
    expect(screen.getByRole('group', { name: 'How points are earned' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '1% of spend' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save earning rate' })).toBeTruthy();
  });

  it('keeps loyalty off and offers no save when the owner says no', () => {
    render(<OnboardingLoyaltyStep presets={presets} />);
    fireEvent.click(screen.getByRole('radio', { name: 'No, not now' }));
    expect(screen.getByRole('status').textContent).toContain('Loyalty stays off');
    expect(screen.queryByRole('button', { name: 'Save earning rate' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Loyalty' }).getAttribute('href')).toBe(
      '/pharmacy/loyalty'
    );
  });
});
