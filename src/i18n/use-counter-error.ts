'use client';
import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';

export function useCounterError() {
  const t = useTranslations('CounterErrors');
  return useCallback((error: unknown) => counterErrorMessage(error, t), [t]);
}
