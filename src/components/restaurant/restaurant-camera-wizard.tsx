'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useMemo, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { CAMERA_PRESET_LABELS, VERTICAL_CAMERA_PRESETS } from '@/lib/cameras/camera-preset';
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
  /** CAM-3: what the camera watches; unset leaves it unclassified. */
  preset?: (typeof VERTICAL_CAMERA_PRESETS.restaurant)[number];
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
  ownerProvisioned = false,
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
  ownerProvisioned?: boolean;
}) {
  const manual = presets.length === 0;
  const [selected, setSelected] = useState<string>(manual ? 'manual' : '');
  const [tested, setTested] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [branchId, setBranchId] = useState(branches.length === 1 ? branches[0]!.id : '');
  const [gatewayId, setGatewayId] = useState('');
  const [pending, setPending] = useState(false);
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
      registerAnyway: ownerProvisioned ? false : data.get('registerAnyway') === 'on',
      preset: VERTICAL_CAMERA_PRESETS.restaurant.find((preset) => preset === data.get('preset')),
    };
  }
  async function test(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const result = await onTest(await values(event.currentTarget));
      setTested(result.outcome === 'ok');
      setOutcome(
        result.outcome === 'ok'
          ? `Connected · ${result.discoveredProfile ?? 'ONVIF profile'}`
          : result.outcome === 'auth-failed'
            ? 'Authentication failed.'
            : 'Camera is unreachable.'
      );
    } catch {
      setTested(false);
      setOutcome('Connection check failed. Check gateway setup and try again.');
    } finally {
      setPending(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      await onSubmit(await values(event.currentTarget));
      setOutcome(
        ownerProvisioned
          ? 'Camera registered. Run Check configured connection on its camera card. Registration does not prove live video.'
          : 'Camera registered.'
      );
    } catch {
      setOutcome('Registration failed. Check your access and gateway setup, then try again.');
    } finally {
      setPending(false);
    }
  }
  return (
    <SectionCard eyebrow="Camera setup" title="Register a camera">
      {ownerProvisioned && (
        <p className="mb-4 text-sm text-text-muted">
          Owner-provisioned live gateway: your administrator must configure the DVR source, RTSP
          port, credentials and private gateway connection separately. This form registers the
          camera; it does not configure the DVR. Stored credentials do not rotate gateway or DVR
          credentials. After registration, ask the owner to bind the registered camera, then run its
          connection check.
        </p>
      )}
      {branches.length > 1 && (
        <label className="mb-4 block text-sm font-medium text-text-strong">
          Branch
          <StudioSelect
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
          </StudioSelect>
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
          onSubmit={ownerProvisioned || tested ? submit : test}
          onChange={() => {
            setTested(false);
            setOutcome('');
          }}
        >
          <label className="text-sm font-medium text-text-strong">
            Camera name
            <Input name="name" required />
          </label>
          <label className="text-sm font-medium text-text-strong">
            Watches
            <StudioSelect name="preset" className={field} defaultValue="">
              <option value="">Not set</option>
              {VERTICAL_CAMERA_PRESETS.restaurant.map((preset) => (
                <option key={preset} value={preset}>
                  {CAMERA_PRESET_LABELS[preset]}
                </option>
              ))}
            </StudioSelect>
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
              disabled={!effectiveBranchId || busy || pending}
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
          <p className="text-sm text-text-muted">
            Configure the RTSP port on the gateway host. The source reference here is a registration
            label and does not configure a network connection. Do not include passwords in it.
          </p>
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
          {!ownerProvisioned && !tested && outcome && (
            <label className="md:col-span-2 flex items-center gap-2 text-sm">
              <input type="checkbox" name="registerAnyway" /> Register anyway while this camera is
              offline
            </label>
          )}
          <div className="md:col-span-2 flex flex-wrap gap-3">
            <Button type="submit" disabled={busy || pending || !effectiveBranchId || !gatewayId}>
              {ownerProvisioned || tested ? 'Register camera' : 'Test connection'}
            </Button>
            {!ownerProvisioned && !tested && outcome && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy || pending}
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
