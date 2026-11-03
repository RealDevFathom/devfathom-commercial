import { render, type RenderOptions } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Fragment, type ReactElement, type ReactNode } from 'react';
import type { AppLocale } from '@/i18n/config';
import en from '@/messages/en.json';
import ur from '@/messages/ur.json';

/** Keep isolated component tests under the same locale boundary as the app. */
export function renderWithIntl(
  ui: ReactElement,
  options: RenderOptions & { locale?: AppLocale } = {}
) {
  const { locale = 'en', wrapper: Wrapper = Fragment, ...rest } = options;
  return render(ui, {
    ...rest,
    wrapper: ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider
        locale={locale}
        messages={locale === 'ur' ? ur : en}
        timeZone="Asia/Karachi"
      >
        <Wrapper>{children}</Wrapper>
      </NextIntlClientProvider>
    ),
  });
}
