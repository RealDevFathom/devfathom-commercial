'use client';

import { useEffect, useState } from 'react';

import {
  startReceiptLeaseRenewal,
  type CounterLeaseReserver,
  type LeaseRenewalResult,
  type PharmacyCounterRuntime,
} from '@/lib/pharmacy/counter-offline-runtime';
import { reserveCounterReceipts } from '@/lib/pharmacy/counter-offline-transport';

export const COUNTER_LEASE_PATH = '/api/pharmacy/counter/lease';

/**
 * The established offline counter's transport credentials. Held in memory only:
 * the local store refuses secrets and session tokens on every write.
 */
export type CounterTerminalCredentials = { deviceSecret: string; sessionToken: string };

/**
 * DEV-767: reserve the next receipt block for THIS terminal. The device secret and
 * the actor/device-bound session token name the terminal, so the server leases only
 * for it, on its branch, and only while the signed-in cashier passes the counter
 * operator gate there. Any non-2xx answer throws; the runtime keeps its held blocks.
 */
export function counterLeaseReserver(
  credentials: CounterTerminalCredentials,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init)
): CounterLeaseReserver {
  return async (size) => {
    const response = await fetchImpl(COUNTER_LEASE_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${credentials.deviceSecret}`,
        'X-Terminal-Session': credentials.sessionToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ size }),
    });
    if (!response.ok) throw new Error(`lease_refused_${response.status}`);
    return response.json();
  };
}

/**
 * DEV-767: while an offline counter is established, keep its receipt-number runway
 * topped up in the background (now, every interval, and on reconnect) so a cashier
 * is never stopped mid-shift by an exhausted lease. Stops when the counter closes,
 * the session changes or the component unmounts. Returns the latest attempt.
 * DEV-957 passes only the session token. The browser supplies its HttpOnly cookie.
 */
export function useReceiptLeaseRenewal(
  runtime: Pick<PharmacyCounterRuntime, 'renewReceiptLeases'> | null,
  credentials: { sessionToken: string; deviceSecret?: string } | null,
  options: { intervalMs?: number; fetchImpl?: typeof fetch } = {}
): LeaseRenewalResult | null {
  const [latest, setLatest] = useState<{
    runtime: NonNullable<typeof runtime>;
    sessionToken: string;
    result: LeaseRenewalResult;
  } | null>(null);
  const deviceSecret = credentials?.deviceSecret ?? null;
  const sessionToken = credentials?.sessionToken ?? null;
  const { intervalMs, fetchImpl } = options;
  useEffect(() => {
    if (!runtime || !sessionToken) return;
    return startReceiptLeaseRenewal(
      runtime,
      deviceSecret
        ? counterLeaseReserver({ deviceSecret, sessionToken }, fetchImpl)
        : (size) => reserveCounterReceipts(sessionToken, size),
      { intervalMs, onResult: (result) => setLatest({ runtime, sessionToken, result }) }
    );
  }, [runtime, deviceSecret, sessionToken, intervalMs, fetchImpl]);
  return latest?.runtime === runtime && latest.sessionToken === sessionToken ? latest.result : null;
}
