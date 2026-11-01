import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AppLoading from './loading';

describe('AppLoading', () => {
  it('says what is loading instead of showing only an animation', () => {
    render(<AppLoading />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading your workspace');
    expect(status).toHaveTextContent('Checking your access and opening the page you asked for.');
  });

  it('stops its animation for people who ask for reduced motion', () => {
    const { container } = render(<AppLoading />);
    for (const element of container.querySelectorAll('[class*="animate-"]')) {
      expect(element.getAttribute('class')).toContain('motion-reduce:animate-none');
    }
  });
});
