import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Loading from './loading';

describe('pharmacist queue loading state', () => {
  it('keeps the page heading while loading instead of the onboarding skeleton', () => {
    const html = renderToString(<Loading />);
    expect(html).toContain('Pharmacist queue');
    expect(html).not.toContain('Onboarding');
  });
});
