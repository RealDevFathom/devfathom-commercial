'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { isAppLocale, localeCookieName, type AppLocale } from '@/i18n/config';

export function LocaleSwitcher({ className = '' }: { className?: string }) {
  const locale = useLocale() as AppLocale;
  const t = useTranslations('Locale');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <label className={`inline-flex items-center gap-2 text-sm text-text-body ${className}`}>
      <span className="sr-only">{t('label')}</span>
      <select
        aria-label={t('label')}
        value={locale}
        disabled={pending}
        aria-busy={pending}
        onChange={(event) => {
          if (!isAppLocale(event.target.value)) return;
          document.cookie = `${localeCookieName}=${event.target.value}; Path=/; Max-Age=31536000; SameSite=Lax`;
          startTransition(() => router.refresh());
        }}
        className="h-11 rounded-[var(--radius-xs)] border border-border-default bg-surface-sunken px-3 font-semibold text-text-strong outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <option value="en">{t('english')}</option>
        <option value="ur">{t('urdu')}</option>
      </select>
    </label>
  );
}
