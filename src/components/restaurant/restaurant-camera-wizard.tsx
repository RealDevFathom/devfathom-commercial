'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { OperatorSafeSelector } from './operator-safe-selector';

export type CameraWizardPreset = {
  key: string;
  familyName: string;
  rtspPort: number;
  onvifPort: number;
  mainStreamPathTemplate: string | null;
  defaultUsernameHint: string | null;
  setupNote: string;
};
export type CameraWizardBranch = { id: string; name: string };
export type CameraWizardGateway = { id: string; name: string; branchId: string; status: string };
export type CameraWizardValues = {
  branchId: string;
  name: string;
  gatewayId: string;
  sourceRef: string;
  username: string;
  password: string;
  registerAnyway: boolean;
};

export function RestaurantCameraWizard({
  branches,
  presets,
  gateways,
  gatewaysLoading = false,
  gatewaysError = false,
  onTest,
  onSubmit,
  busy = false,
}: {
  branches: CameraWizardBranch[];
  presets: CameraWizardPreset[];
  gateways: CameraWizardGateway[];
  gatewaysLoading?: boolean;
  gatewaysError?: boolean;
  onTest: (
    values: CameraWizardValues
  ) => Promise<{ outcome: 'ok' | 'auth-failed' | 'unreachable'; discoveredProfile?: string }>;
  onSubmit: (values: CameraWizardValues) => Promise<void>;
  busy?: boolean;
}) {
  const manual = presets.length === 0;
  const [selected, setSelected] = useState<string>(manual ? 'manual' : '');
  const [tested, setTested] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [branchId, setBranchId] = useState(branches.length === 1 ? branches[0]!.id : '');
  const [gatewayId, setGatewayId] = useState('');
  const effectiveBranchId = branchId || (branches.length === 1 ? branches[0]!.id : '');
  const chosen = useMemo(
    () => presets.find((preset) => preset.key === selected),
    [presets, selected]
  );
  const field =
    'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50';
  async function values(form: HTMLFormElement): Promise<CameraWizardValues> {
    const data = new FormData(form);
    return {
      branchId: String(data.get('branchId')),
      name: String(data.get('name')),
      gatewayId,
      sourceRef: String(data.get('sourceRef')),
      username: String(data.get('username')),
      password: String(data.get('password')),
      registerAnyway: data.get('registerAnyway') === 'on',
    };
  }
  async function test(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await onTest(await values(event.currentTarget));
    setTested(result.outcome === 'ok');
    setOutcome(
      result.outcome === 'ok'
        ? `Connected · ${result.discoveredProfile ?? 'ONVIF profile'}`
        : result.outcome === 'auth-failed'
          ? 'Authentication failed.'
          : 'Camera is unreachable.'
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(await values(event.currentTarget));
  }
  return (
    <SectionCard eyebrow="Camera setup" title="Register a camera">
      {branches.length > 1 && (
        <label className="mb-4 block text-sm font-medium text-text-strong">
          Branch
          <select
            name="branchId"
            form="camera-wizard"
            className={field}
            value={branchId}
            onChange={(event) => {
              setBranchId(event.target.value);
              setGatewayId('');
            }}
          >
            {' '}
            <option value="" disabled>
              Select branch
            </option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {branches.length === 1 && (
        <input form="camera-wizard" type="hidden" name="branchId" value={branches[0].id} />
      )}
      {!manual && (
        <div
          className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
          aria-label="Camera brands"
        >
          {presets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              aria-pressed={selected === preset.key}
              onClick={() => {
                setSelected(preset.key);
                setTested(false);
              }}
              className="min-h-24 rounded-md border border-border-subtle bg-card p-3 text-left text-sm font-semibold text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {preset.familyName}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={selected === 'manual'}
            onClick={() => {
              setSelected('manual');
              setTested(false);
            }}
            className="min-h-24 rounded-md border border-border-subtle bg-card p-3 text-left text-sm font-semibold text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Using another brand? Configure manually
          </button>
        </div>
      )}
      {manual && (
        <p className="mb-4 text-sm text-text-muted">Using another brand? Configure manually</p>
      )}
      {(selected || manual) && (
        <form
          id="camera-wizard"
          className="grid gap-4 md:grid-cols-2"
          onSubmit={tested ? submit : test}
        >
          <label className="text-sm font-medium text-text-strong">
            Camera name
            <Input name="name" required />
          </label>
          <div className="text-sm font-medium text-text-strong">
            <span>Camera gateway</span>
            <OperatorSafeSelector
              label="Camera gateway"
              name="gatewayId"
              required
              value={gatewayId}
              onChange={setGatewayId}
              loading={gatewaysLoading}
              error={gatewaysError}
              disabled={!effectiveBranchId || busy}
              emptyLabel="No active gateways for this branch"
              options={gateways
                .filter(
                  (gateway) =>
                    gateway.branchId === effectiveBranchId && gateway.status !== 'REVOKED'
                )
                .map((gateway) => ({
                  value: gateway.id,
                  label: gateway.name,
                  code: gateway.status.toLocaleLowerCase(),
                }))}
            />
          </div>
          <label className="text-sm font-medium text-text-strong">
            Host / stream source
            <Input
              name="sourceRef"
              required
              placeholder="camera.local/stream"
              defaultValue={chosen?.mainStreamPathTemplate ?? ''}
            />
          </label>
          <label className="text-sm font-medium text-text-strong">
            RTSP port
            <Input name="rtspPort" type="number" defaultValue={chosen?.rtspPort ?? 554} />
            <span className="text-xs text-text-muted">
              {chosen
                ? `Suggested by ${chosen.familyName}; editable`
                : 'Generic RTSP default; editable'}
            </span>
          </label>
          <label className="text-sm font-medium text-text-strong">
            Username
            <Input
              name="username"
              required
              defaultValue={chosen?.defaultUsernameHint ?? ''}
              autoComplete="username"
            />
          </label>
          <label className="text-sm font-medium text-text-strong">
            Password
            <Input name="password" required type="password" autoComplete="new-password" />
          </label>
          {outcome && (
            <p role="status" className="md:col-span-2 text-sm text-text-muted">
              {outcome}
            </p>
          )}
          {!tested && outcome && (
            <label className="md:col-span-2 flex items-center gap-2 text-sm">
              <input type="checkbox" name="registerAnyway" /> Register anyway while this camera is
              offline
            </label>
          )}
          <div className="md:col-span-2 flex flex-wrap gap-3">
            <Button type="submit" disabled={busy}>
              {tested ? 'Register camera' : 'Test connection'}
            </Button>
            {!tested && outcome && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={(event) =>
                  void submit({
                    preventDefault() {},
                    currentTarget: event.currentTarget.closest('form')!,
                  } as unknown as FormEvent<HTMLFormElement>)
                }
              >
                Register anyway
              </Button>
            )}
          </div>
        </form>
      )}
    </SectionCard>
  );
}
