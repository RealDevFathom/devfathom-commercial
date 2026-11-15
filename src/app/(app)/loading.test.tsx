import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AppLoading from './loading';

describe('Workspace loading state', () => {
  it('announces visible loading feedback that can wrap in a narrow canvas', () => {
    render(<AppLoading />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading your workspace');
    expect(status).toHaveTextContent('Please wait while the page loads.');
    expect(status).toHaveClass('min-w-0', 'max-w-full', 'whitespace-normal', 'break-words');
    expect(status.parentElement).toHaveClass('px-4');
  });

  it('disables every loading animation when reduced motion is requested', () => {
    const { container } = render(<AppLoading />);
    const animated = container.querySelectorAll('[class*="animate-"]');
    expect(animated.length).toBeGreaterThan(0);
    for (const element of animated) {
      expect(element).toHaveClass('motion-reduce:animate-none');
    }
  });
});
