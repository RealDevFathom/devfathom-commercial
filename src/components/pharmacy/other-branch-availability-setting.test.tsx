import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OtherBranchAvailabilityPanel } from './other-branch-availability-setting';

describe('DEV-907 other-branch availability setting', () => {
  it('lets the owner turn the switch on', () => {
    const onChange = vi.fn();
    render(
      <OtherBranchAvailabilityPanel
        enabled={false}
        canChange
        pending={false}
        notice={null}
        onChange={onChange}
      />
    );
    const toggle = screen.getByRole('switch', {
      name: 'Show when another branch has an out-of-stock item',
    });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByText(/Controlled drugs are never shown/)).toBeVisible();
  });

  it('is read-only with an explanation for anyone but the owner', () => {
    const onChange = vi.fn();
    render(
      <OtherBranchAvailabilityPanel
        enabled
        canChange={false}
        pending={false}
        notice={null}
        onChange={onChange}
      />
    );
    const toggle = screen.getByRole('switch');
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Only the owner can change this setting.')).toBeVisible();
  });
});
