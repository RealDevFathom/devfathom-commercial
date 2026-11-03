import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import ur from '@/messages/ur.json';
import { LocaleSwitcher } from './locale-switcher';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  document.cookie = 'devfathom-locale=; Max-Age=0; Path=/';
});

describe('LocaleSwitcher', () => {
  beforeEach(() => {
    refresh.mockClear();
    document.cookie = 'devfathom-locale=; Max-Age=0; Path=/';
  });

  it('persists Urdu and refreshes the server-rendered document', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <LocaleSwitcher />
      </NextIntlClientProvider>
    );
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ur' } });
    expect(document.cookie).toContain('devfathom-locale=ur');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('renders the Urdu locale label and current selection', () => {
    render(
      <NextIntlClientProvider locale="ur" messages={ur}>
        <div data-counter-console="">
          <LocaleSwitcher />
        </div>
      </NextIntlClientProvider>
    );
    expect(screen.getByLabelText('زبان')).toHaveValue('ur');
  });
});
