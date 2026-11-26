'use client';
import { useState, useTransition } from 'react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import type { WahaCommand, WahaView } from '@/lib/pharmacy/whatsapp/waha-admin';
import { updateConnection } from './actions';
export function ConnectionPanel({ initial }: { initial: WahaView }) {
  const [view, setView] = useState(initial),
    [pending, start] = useTransition(),
    [confirm, setConfirm] = useState(false);
  const execute = (cmd: WahaCommand) =>
    start(async () => {
      try {
        setView(await updateConnection(cmd));
      } catch {
        setView({
          ...initial,
          qr: null,
          notice: 'Could not load the connection. Refresh to try again.',
        });
      }
      setConfirm(false);
    });
  const connected = view.status === 'WORKING',
    scan = view.status === 'SCAN_QR_CODE';
  return (
    <div className="space-y-6" aria-busy={pending}>
      <SectionCard title="Pharmacy number" titleLevel={2}>
        <div className="space-y-4">
          <StatusPill
            tone={connected ? 'success' : 'warning'}
            status={
              connected
                ? 'Connected'
                : scan
                  ? 'Scan again'
                  : view.status === 'STARTING'
                    ? 'Connecting'
                    : 'Disconnected'
            }
          />
          {view.number && <p>Connected number: +{view.number}</p>}
          {view.paused && (
            <p role="alert" className="text-warning">
              WhatsApp has restricted this number. Sending is paused. Keep this session connected.
            </p>
          )}
          {view.qr && (
            <div>
              <p>
                On the pharmacy phone, open Linked devices and scan this code. Refresh after
                scanning.
              </p>
              <Image
                unoptimized
                src={view.qr}
                alt="WhatsApp pairing QR code"
                width={240}
                height={240}
                className="max-w-full"
              />
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            {!connected && !scan && (
              <Button
                className="min-h-11"
                disabled={pending || view.paused}
                onClick={() => execute({ action: 'start' })}
              >
                Start connection
              </Button>
            )}
            <Button
              variant="outline"
              className="min-h-11"
              disabled={pending}
              onClick={() => execute({ action: 'refresh' })}
            >
              Refresh status
            </Button>
          </div>
        </div>
      </SectionCard>
      {view.configured && (
        <>
          <SectionCard title="Sending limits" titleLevel={2}>
            <form
              key={[view.minute, view.day, view.portal].join('-')}
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                execute({
                  action: 'settings',
                  minute: Number(data.get('minute')),
                  day: Number(data.get('day')),
                  portal: data.has('portal'),
                });
              }}
            >
              <label className="block">
                Messages per minute
                <Input
                  className="min-h-11"
                  name="minute"
                  type="number"
                  required
                  min={1}
                  max={60}
                  defaultValue={view.minute}
                />
              </label>
              <label className="block">
                Messages per 24 hours
                <Input
                  className="min-h-11"
                  name="day"
                  type="number"
                  required
                  min={0}
                  max={1000}
                  defaultValue={view.day}
                />
              </label>
              <p className="text-sm text-text-muted">A daily limit of zero keeps sending off.</p>
              <label className="flex min-h-11 items-center gap-3">
                <input type="checkbox" name="portal" defaultChecked={view.portal} />
                Allow portal sign-in codes over WhatsApp
              </label>
              <Button className="min-h-11" variant="outline" disabled={pending} type="submit">
                Save limits
              </Button>
            </form>
          </SectionCard>
          <SectionCard title="Test delivery" titleLevel={2}>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                execute({
                  action: 'test',
                  phone: String(new FormData(e.currentTarget).get('phone') ?? ''),
                });
              }}
            >
              <label className="block">
                Opted-in customer’s phone number
                <Input type="tel" name="phone" required maxLength={32} className="min-h-11" />
              </label>
              <p className="text-sm text-text-muted">
                The test says “This is a test message from your pharmacy.” Consent, quiet hours and
                sending limits apply.
              </p>
              <Button
                type="submit"
                className="min-h-11"
                disabled={pending || !connected || view.paused || view.day === 0}
              >
                Send test message
              </Button>
            </form>
          </SectionCard>
          <SectionCard title="Disconnect WhatsApp" titleLevel={2}>
            <p className="mb-3">Disconnecting signs the pharmacy phone out of this session.</p>
            {confirm ? (
              <div
                className="flex flex-wrap gap-3"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setConfirm(false);
                }}
              >
                <Button
                  variant="destructive"
                  className="min-h-11"
                  disabled={pending}
                  onClick={() => execute({ action: 'disconnect', confirmed: true })}
                >
                  Confirm disconnect
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={pending}
                  onClick={() => setConfirm(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="destructive"
                className="min-h-11"
                disabled={pending || view.paused || (!connected && !scan)}
                onClick={() => setConfirm(true)}
              >
                Disconnect
              </Button>
            )}
          </SectionCard>
        </>
      )}
      <p role="status" className="text-sm text-text-muted">
        {pending ? 'Updating connection…' : view.notice}
      </p>
    </div>
  );
}
