'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { CameraTile } from '@/components/camera/camera-tile';
import { useEntitlements } from '@/components/entitlements-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { CAMERA_DIAGNOSTIC_MESSAGES, CAMERA_H265_NOTE } from '@/lib/cameras/diagnostic-messages';
import { trpc } from '@/lib/trpc';
import { RestaurantCameraWizard, type CameraWizardValues } from './restaurant-camera-wizard';
import { RestaurantCameraPlayer } from './restaurant-camera-player';

const diagnostics = CAMERA_DIAGNOSTIC_MESSAGES;

function CameraConnectionCheck({ cameraId }: { cameraId: string }) {
  const check = trpc.restaurantCameras.configuredConnectionDiagnostics.useQuery(
    { cameraId },
    {
      enabled: false,
      retry: false,
    }
  );
  return (
    <div className="mt-3 space-y-2">
      <Button variant="secondary" disabled={check.isFetching} onClick={() => void check.refetch()}>
        Check configured connection
      </Button>
      <p role="status" className="text-sm text-text-muted">
        {check.isFetching
          ? 'Checking gateway…'
          : check.isError
            ? 'Connection check failed. Check your access and gateway setup.'
            : check.data
              ? diagnostics[check.data.outcome]
              : 'Connection not checked.'}
      </p>
      {check.data && 'videoCodec' in check.data && check.data.videoCodec === 'h265' ? (
        <p className="text-sm text-text-muted">{CAMERA_H265_NOTE}</p>
      ) : null}
    </div>
  );
}

export function RestaurantCamerasConsole() {
  const enabled = useEntitlements().enabledModules.includes('restaurant-integrations');
  const utils = trpc.useUtils();
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const availability = trpc.restaurantCameras.availability.useQuery(undefined, { enabled });
  const gatewayAvailable = availability.data?.available === true;
  const ownerProvisioned = availability.data?.mode === 'mediamtx';
  const presets = trpc.restaurantCameras.presets.useQuery(undefined, {
    enabled: enabled && gatewayAvailable,
  });
  const cameras = trpc.restaurantCameras.list.useQuery(undefined, {
    enabled: enabled && gatewayAvailable,
  });
  const gateways = trpc.restaurantCameras.listGateways.useQuery(undefined, {
    enabled: enabled && gatewayAvailable,
  });
  const staff = trpc.restaurantStaff.list.useQuery(undefined, {
    enabled: enabled && gatewayAvailable,
  });
  const recordings = trpc.restaurantCameras.listRecordings.useQuery(
    { cameraId: selectedCameraId },
    {
      enabled: enabled && gatewayAvailable && !ownerProvisioned && Boolean(selectedCameraId),
      retry: false,
    }
  );
  const branches = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of staff.data ?? [])
      if (item.primaryBranch) map.set(item.primaryBranch.id, item.primaryBranch.name);
    return [...map].map(([id, name]) => ({ id, name }));
  }, [staff.data]);
  const test = trpc.restaurantCameras.testConnection.useMutation();
  const register = trpc.restaurantCameras.register.useMutation({
    onSuccess: () => {
      toast.success('Camera registered.');
      void utils.restaurantCameras.list.invalidate();
    },
  });
  const grant = trpc.restaurantCameras.issueStreamGrant.useMutation({ retry: false });
  const retention = trpc.restaurantCameras.setRetention.useMutation({
    onSuccess: () => {
      toast.success('Retention updated.');
      void utils.restaurantCameras.listGateways.invalidate();
    },
  });
  if (!enabled)
    return (
      <SectionCard title="Camera integrations unavailable">
        <p className="text-sm text-text-muted">This module is not enabled for your organization.</p>
      </SectionCard>
    );
  if (availability.isLoading)
    return (
      <SectionCard title="Checking camera gateway">
        <p className="text-sm text-text-muted" role="status">
          Checking whether camera services are available…
        </p>
      </SectionCard>
    );
  if (availability.isError || !gatewayAvailable)
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Device settings"
          heading="Cameras"
          description="Camera services are currently unavailable."
        />
        <SectionCard eyebrow="Gateway" title="Camera gateway not configured" titleLevel={2}>
          <p className="text-sm text-text-muted" role="status">
            Live feeds and recordings remain unavailable until an administrator configures a
            supported camera gateway. No camera footage is being simulated.
          </p>
        </SectionCard>
      </div>
    );
  async function onTest(values: CameraWizardValues) {
    return test.mutateAsync({ username: values.username, password: values.password });
  }
  async function onSubmit(values: CameraWizardValues) {
    await register.mutateAsync(values);
  }
  function updateRetention(event: FormEvent<HTMLFormElement>, branchId: string) {
    event.preventDefault();
    retention.mutate({ branchId, days: Number(new FormData(event.currentTarget).get('days')) });
  }
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Device settings"
        heading="Cameras"
        description={
          ownerProvisioned
            ? 'Live views through your owner-provisioned gateway. Recorded playback is unsupported.'
            : 'Camera gateway settings and live views.'
        }
      />
      <RestaurantCameraWizard
        branches={branches}
        presets={presets.data ?? []}
        gateways={gateways.data ?? []}
        gatewaysLoading={gateways.isLoading}
        gatewaysError={gateways.isError}
        onTest={onTest}
        onSubmit={onSubmit}
        busy={test.isPending || register.isPending}
        ownerProvisioned={ownerProvisioned}
      />
      <SectionCard eyebrow="Live view" title="Camera feeds">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(cameras.data ?? []).map((camera) => (
            <CameraTile
              key={camera.id}
              name={camera.name}
              preset={camera.preset ?? null}
              media={
                selectedCameraId === camera.id && camera.enabled ? (
                  <RestaurantCameraPlayer
                    cameraId={camera.id}
                    name={camera.name}
                    issue={(previousGrantId) =>
                      grant.mutateAsync({ cameraId: camera.id, previousGrantId })
                    }
                  />
                ) : (
                  'Live feed paused'
                )
              }
            >
              <p className="text-sm text-text-muted">
                {camera.enabled
                  ? 'Registered · connection requires verification'
                  : 'Registered offline'}
              </p>
              <Button
                className="mt-3"
                variant="secondary"
                disabled={!camera.enabled}
                onClick={() => setSelectedCameraId(selectedCameraId === camera.id ? '' : camera.id)}
              >
                {selectedCameraId === camera.id ? 'Close live view' : 'Open live view'}
              </Button>
              {ownerProvisioned && <CameraConnectionCheck cameraId={camera.id} />}
            </CameraTile>
          ))}
          {cameras.data?.length === 0 && (
            <p className="text-sm text-text-muted">No cameras registered yet.</p>
          )}
        </div>
      </SectionCard>
      <SectionCard eyebrow="Playback" title="Gateway recordings">
        {ownerProvisioned ? (
          <p className="text-sm text-text-muted">
            Recordings unsupported by this live gateway. Live video is never substituted for
            recorded footage.
          </p>
        ) : !selectedCameraId ? (
          <p className="text-sm text-text-muted">Open a camera to load its recordings.</p>
        ) : recordings.isLoading ? (
          <p className="text-sm text-text-muted">Loading recordings…</p>
        ) : recordings.isError ? (
          <p role="alert" className="text-sm text-text-muted">
            Recordings could not be loaded.
          </p>
        ) : recordings.data?.length ? (
          <ul className="divide-y divide-border-subtle">
            {recordings.data.map((recording) => (
              <li
                key={recording.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <span className="text-sm text-text-strong">
                  {new Date(recording.startedAt).toLocaleString()} · {recording.durationSeconds}s
                </span>
                <Button variant="secondary" disabled>
                  Recording playback unsupported
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">No recordings are available for this camera.</p>
        )}
      </SectionCard>
      <SectionCard eyebrow="Gateway" title="Retention by branch">
        {ownerProvisioned ? (
          <p className="text-sm text-text-muted">
            Manage retention on the gateway host. This live integration does not configure recording
            retention.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {(gateways.data ?? []).map((gateway) => (
              <form
                key={gateway.id}
                onSubmit={(event) => updateRetention(event, gateway.branchId)}
                className="rounded-md border border-border-subtle p-4"
              >
                <p className="font-semibold text-text-strong">{gateway.name}</p>
                <p className="mb-3 text-sm text-text-muted">
                  {gateway.health} · current policy {gateway.retentionDays} days
                </p>
                <label className="text-sm font-medium text-text-strong">
                  Retention days
                  <Input
                    name="days"
                    type="number"
                    min={1}
                    max={90}
                    defaultValue={gateway.retentionDays}
                    required
                  />
                </label>
                <Button className="mt-3" disabled={retention.isPending}>
                  Save retention
                </Button>
              </form>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
