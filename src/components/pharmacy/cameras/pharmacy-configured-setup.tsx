'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { OperatorSafeSelector } from '@/components/restaurant/operator-safe-selector';
import type {
  PharmacyCameraWizardBranch,
  PharmacyCameraWizardGateway,
} from './pharmacy-camera-wizard';

const field =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

export type PharmacyConfiguredGatewayValues = {
  branchId: string;
  name: string;
  baseUrl: string;
  retentionDays: number;
};
export type PharmacyConfiguredCameraValues = {
  branchId: string;
  gatewayId: string;
  name: string;
  sourceRef: string;
};

function BranchSelect({
  branches,
  value,
  onChange,
}: {
  branches: PharmacyCameraWizardBranch[];
  value: string;
  onChange: (value: string) => void;
}) {
  if (branches.length < 2) return null;
  return (
    <label className="text-sm font-medium text-text-strong">
      Branch
      <select
        className={field}
        value={value}
        required
        onChange={(event) => onChange(event.target.value)}
      >
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
  );
}

/**
 * DEV-740 configured (owner-provisioned MediaMTX) setup. Registration records the
 * gateway and camera only; it contacts no DVR and stores no DVR credential. The
 * gateway owner binds the shown IDs server-side, then the camera card's
 * connection check and the owner's explicit enable make it viewable.
 */
export function PharmacyConfiguredSetup({
  branches,
  gateways,
  onEnrollGateway,
  onRegisterCamera,
  busy = false,
}: {
  branches: PharmacyCameraWizardBranch[];
  gateways: PharmacyCameraWizardGateway[];
  onEnrollGateway: (values: PharmacyConfiguredGatewayValues) => Promise<void>;
  onRegisterCamera: (values: PharmacyConfiguredCameraValues) => Promise<void>;
  busy?: boolean;
}) {
  const single = branches.length === 1 ? branches[0]!.id : '';
  const [gatewayBranch, setGatewayBranch] = useState('');
  const [cameraBranch, setCameraBranch] = useState('');
  const [gatewayId, setGatewayId] = useState('');
  const [gatewayOutcome, setGatewayOutcome] = useState('');
  const [cameraOutcome, setCameraOutcome] = useState('');
  const effectiveGatewayBranch = gatewayBranch || single;
  const effectiveCameraBranch = cameraBranch || single;

  async function enroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await onEnrollGateway({
        branchId: effectiveGatewayBranch,
        name: String(data.get('name') ?? '').trim(),
        baseUrl: String(data.get('baseUrl') ?? '').trim(),
        retentionDays: Number(data.get('retentionDays')),
      });
      setGatewayOutcome('Gateway registered. Its ID appears on each camera card for the binding.');
      form.reset();
    } catch (error) {
      setGatewayOutcome(
        (error as { message?: string } | null)?.message?.startsWith('Gateway URL must')
          ? (error as Error).message
          : 'Gateway registration failed. Check your access and the gateway URL, then try again.'
      );
    }
  }
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await onRegisterCamera({
        branchId: effectiveCameraBranch,
        gatewayId,
        name: String(data.get('name') ?? '').trim(),
        sourceRef: String(data.get('sourceRef') ?? '').trim(),
      });
      setCameraOutcome(
        'Camera registered disabled. Give its camera and gateway IDs to the gateway owner, run Check configured connection, then enable it. Registration does not prove live video.'
      );
      form.reset();
      setGatewayId('');
    } catch (error) {
      const message = (error as { message?: string } | null)?.message ?? '';
      setCameraOutcome(
        message.startsWith('Stream path')
          ? message
          : 'Registration failed. Check your access and gateway setup, then try again.'
      );
    }
  }

  return (
    <>
      <SectionCard eyebrow="Configured gateway" title="Register a gateway">
        <p className="mb-4 text-sm text-text-muted">
          Records an owner-provisioned camera gateway for one branch. No DVR, camera or network
          address is contacted here. The gateway owner keeps DVR sign-in details in the gateway’s
          protected configuration; never enter them in this app.
        </p>
        <form
          aria-label="Register a configured gateway"
          className="grid gap-4 md:grid-cols-2"
          onSubmit={(event) => void enroll(event)}
        >
          <BranchSelect branches={branches} value={gatewayBranch} onChange={setGatewayBranch} />
          <label className="text-sm font-medium text-text-strong">
            Gateway name
            <Input name="name" required maxLength={120} />
          </label>
          <div>
            <label className="text-sm font-medium text-text-strong">
              Gateway URL
              <Input
                name="baseUrl"
                type="url"
                required
                maxLength={500}
                placeholder="https://camera-gateway.example.internal/"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="pharmacy-gateway-url-hint"
              />
            </label>
            <p id="pharmacy-gateway-url-hint" className="mt-1 text-xs text-text-muted">
              Exactly https://hostname/ with an optional port. No IP address, path or sign-in
              details.
            </p>
          </div>
          <label className="text-sm font-medium text-text-strong">
            Evidence retention days
            <Input name="retentionDays" type="number" min={1} max={90} defaultValue={7} required />
          </label>
          {gatewayOutcome && (
            <p role="status" className="md:col-span-2 text-sm text-text-muted">
              {gatewayOutcome}
            </p>
          )}
          <div className="md:col-span-2">
            <Button type="submit" disabled={busy || !effectiveGatewayBranch}>
              Register gateway
            </Button>
          </div>
        </form>
      </SectionCard>
      <SectionCard eyebrow="Camera setup" title="Register a camera">
        <p className="mb-4 text-sm text-text-muted">
          Name the gateway stream path the owner configured for this camera. Cameras start disabled;
          no device is probed and no live video is promised until the configured connection check
          and playback are verified.
        </p>
        {branches.length === 0 && (
          <p role="status" className="mb-4 text-sm text-text-muted">
            No active pharmacy branches are available for your access.
          </p>
        )}
        <form
          aria-label="Register a configured camera"
          className="grid gap-4 md:grid-cols-2"
          onSubmit={(event) => void register(event)}
        >
          <BranchSelect
            branches={branches}
            value={cameraBranch}
            onChange={(value) => {
              setCameraBranch(value);
              setGatewayId('');
            }}
          />
          <label className="text-sm font-medium text-text-strong">
            Camera name
            <Input name="name" required maxLength={120} />
          </label>
          <div className="text-sm font-medium text-text-strong">
            <span>Camera gateway</span>
            <OperatorSafeSelector
              label="Camera gateway"
              name="gatewayId"
              required
              value={gatewayId}
              onChange={setGatewayId}
              disabled={!effectiveCameraBranch || busy}
              emptyLabel="No active gateways for this branch"
              options={gateways
                .filter(
                  (gateway) =>
                    gateway.branchId === effectiveCameraBranch && gateway.status === 'ACTIVE'
                )
                .map((gateway) => ({
                  value: gateway.id,
                  label: gateway.name,
                  code: gateway.status.toLocaleLowerCase(),
                }))}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-text-strong">
              Gateway stream path
              <Input
                name="sourceRef"
                required
                maxLength={120}
                pattern="[A-Za-z0-9_\-]+(/[A-Za-z0-9_\-]+)*"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="pharmacy-stream-path-hint"
              />
            </label>
            <p id="pharmacy-stream-path-hint" className="mt-1 text-xs text-text-muted">
              A path name such as counter-1, not a URL or device address.
            </p>
          </div>
          {cameraOutcome && (
            <p role="status" className="md:col-span-2 text-sm text-text-muted">
              {cameraOutcome}
            </p>
          )}
          <div className="md:col-span-2">
            <Button type="submit" disabled={busy || !effectiveCameraBranch || !gatewayId}>
              Register camera
            </Button>
          </div>
        </form>
      </SectionCard>
    </>
  );
}
