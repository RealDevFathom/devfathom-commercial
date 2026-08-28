'use client';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { useEntitlements } from '@/components/entitlements-provider';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { trpc } from '@/lib/trpc';
import { RestaurantCameraWizard, type CameraWizardValues } from './restaurant-camera-wizard';

export function RestaurantCamerasConsole() {
  const entitlements = useEntitlements();
  const enabled = entitlements.enabledModules.includes('restaurant-integrations');
  const utils = trpc.useUtils();
  const presets = trpc.restaurantCameras.presets.useQuery(undefined, { enabled });
  const cameras = trpc.restaurantCameras.list.useQuery(undefined, { enabled });
  const gateways = trpc.restaurantCameras.listGateways.useQuery(undefined, { enabled });
  const staff = trpc.restaurantStaff.list.useQuery(undefined, { enabled });
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
  if (!enabled)
    return (
      <SectionCard title="Camera integrations unavailable">
        <p className="text-sm text-text-muted">This module is not enabled for your organization.</p>
      </SectionCard>
    );
  async function onTest(values: CameraWizardValues) {
    return test.mutateAsync({ username: values.username, password: values.password });
  }
  async function onSubmit(values: CameraWizardValues) {
    await register.mutateAsync(values);
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
              <div className="aspect-video rounded-sm bg-foreground/10" />
              <h3 className="mt-3 font-semibold text-text-strong">{camera.name}</h3>
              <p className="text-sm text-text-muted">
                {camera.enabled ? 'Ready for live view' : 'Registered offline'}
              </p>
            </article>
          ))}
          {cameras.data?.length === 0 && (
            <p className="text-sm text-text-muted">No cameras registered yet.</p>
          )}
        </div>
      </SectionCard>
      <SectionCard eyebrow="Gateway" title="Retention">
        {(gateways.data ?? []).map((gateway) => (
          <p key={gateway.id} className="text-sm text-text-muted">
            {gateway.name}: {gateway.retentionDays} days · {gateway.health}
          </p>
        ))}
      </SectionCard>
    </div>
  );
}
