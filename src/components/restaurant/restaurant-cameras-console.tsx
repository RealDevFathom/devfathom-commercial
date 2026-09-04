'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useEntitlements } from '@/components/entitlements-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { trpc } from '@/lib/trpc';
import { RestaurantCameraWizard, type CameraWizardValues } from './restaurant-camera-wizard';

export function RestaurantCamerasConsole() {
  const enabled = useEntitlements().enabledModules.includes('restaurant-integrations');
  const utils = trpc.useUtils();
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [playbackUrl, setPlaybackUrl] = useState('');
  const availability = trpc.restaurantCameras.availability.useQuery(undefined, { enabled });
  const gatewayAvailable = availability.data?.available === true;
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
    { enabled: enabled && gatewayAvailable && Boolean(selectedCameraId) }
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
  const grant = trpc.restaurantCameras.issueStreamGrant.useMutation();
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
  async function openStream(cameraId: string) {
    const issued = await grant.mutateAsync({ cameraId });
    setSelectedCameraId(cameraId);
    setPlaybackUrl(
      `/api/restaurant/cameras/${encodeURIComponent(cameraId)}/stream?grant=${encodeURIComponent(issued.grantId)}`
    );
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
        description="Secure live views, gateway-local recordings, and retention by branch."
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
      />
      <SectionCard eyebrow="Live view" title="Camera feeds">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(cameras.data ?? []).map((camera) => (
            <article
              key={camera.id}
              className="rounded-md border border-border-subtle bg-surface-sunken p-4"
            >
              <div className="flex aspect-video items-center justify-center rounded-sm bg-foreground/10 text-sm text-text-muted">
                {selectedCameraId === camera.id && playbackUrl ? (
                  <video
                    className="h-full w-full"
                    controls
                    autoPlay
                    src={playbackUrl}
                    aria-label={`${camera.name} playback panel`}
                  />
                ) : (
                  'Live feed paused'
                )}
              </div>
              <h3 className="mt-3 font-semibold text-text-strong">{camera.name}</h3>
              <p className="text-sm text-text-muted">
                {camera.enabled ? 'Ready for live view' : 'Registered offline'}
              </p>
              <Button
                className="mt-3"
                variant="secondary"
                disabled={!camera.enabled || grant.isPending}
                onClick={() => void openStream(camera.id)}
              >
                Open live view
              </Button>
            </article>
          ))}
          {cameras.data?.length === 0 && (
            <p className="text-sm text-text-muted">No cameras registered yet.</p>
          )}
        </div>
      </SectionCard>
      <SectionCard eyebrow="Playback" title="Gateway recordings">
        {!selectedCameraId ? (
          <p className="text-sm text-text-muted">Open a camera to load its recordings.</p>
        ) : recordings.isLoading ? (
          <p className="text-sm text-text-muted">Loading recordings…</p>
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
                <Button
                  variant="secondary"
                  onClick={() =>
                    setPlaybackUrl(
                      `/api/restaurant/cameras/${encodeURIComponent(selectedCameraId)}/stream?grant=${encodeURIComponent(grant.data?.grantId ?? '')}&recording=${encodeURIComponent(recording.id)}`
                    )
                  }
                >
                  Play in panel
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">No recordings are available for this camera.</p>
        )}
      </SectionCard>
      <SectionCard eyebrow="Gateway" title="Retention by branch">
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
      </SectionCard>
    </div>
  );
}
