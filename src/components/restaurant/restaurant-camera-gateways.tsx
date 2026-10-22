'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { trpc } from '@/lib/trpc';
import type { CameraWizardBranch, CameraWizardGateway } from './restaurant-camera-wizard';

type Gateway = CameraWizardGateway & {
  baseUrl: string;
  health: string;
  retentionDays: number;
};

export function RestaurantCameraGateways({
  branches,
  branchesLoading,
  branchesError,
  gateways,
}: {
  branches: CameraWizardBranch[];
  branchesLoading: boolean;
  branchesError: boolean;
  gateways: Gateway[];
}) {
  const utils = trpc.useUtils();
  const [secret, setSecret] = useState('');
  const [secretFor, setSecretFor] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [revokingGatewayId, setRevokingGatewayId] = useState('');
  const revocationActors = trpc.restaurantCameras.gatewayRevocationActors.useQuery(
    { gatewayId: revokingGatewayId },
    { enabled: Boolean(revokingGatewayId), retry: false }
  );
  const refresh = () => void utils.restaurantCameras.listGateways.invalidate();
  const enroll = trpc.restaurantCameras.enrollGateway.useMutation({
    onSuccess: (result) => {
      setSecret(result.enrollmentSecret);
      setSecretFor(result.gateway.name);
      setAcknowledged(false);
      refresh();
      toast.success('Gateway enrolled. Copy its one-time secret now.');
    },
    onError: (error) => toast.error(error.message),
  });
  const rotate = trpc.restaurantCameras.rotateGatewaySecret.useMutation({
    onSuccess: (result, input) => {
      const gateway = gateways.find((item) => item.id === input.gatewayId);
      setSecret(result.enrollmentSecret);
      setSecretFor(gateway?.name ?? 'gateway');
      setAcknowledged(false);
      refresh();
      toast.success('Gateway secret rotated. The previous secret no longer works.');
    },
    onError: (error) => toast.error(error.message),
  });
  const revoke = trpc.restaurantCameras.revokeGateway.useMutation({
    onSuccess: () => {
      refresh();
      toast.success('Gateway revoked.');
    },
    onError: (error) => toast.error(error.message),
  });

  function submitEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    enroll.mutate({
      branchId: String(data.get('branchId')),
      name: String(data.get('name')),
      baseUrl: String(data.get('baseUrl')),
      retentionDays: Number(data.get('retentionDays')),
    });
  }

  function submitRevocation(event: FormEvent<HTMLFormElement>, gatewayId: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const approvingSecret = String(data.get('approvingSecret'));
    const secretInput = form.elements.namedItem('approvingSecret');
    if (secretInput instanceof HTMLInputElement) secretInput.value = '';
    revoke.mutate({
      gatewayId,
      actingStaffProfileId: String(data.get('actingStaffProfileId')),
      approvingStaffProfileId: String(data.get('approvingStaffProfileId')),
      approvingType: String(data.get('approvingType')) as 'PIN' | 'BADGE',
      approvingSecret,
      reason: String(data.get('reason')),
    });
  }

  return (
    <SectionCard eyebrow="Gateway lifecycle" title="Camera gateways">
      <p className="mb-4 text-sm text-text-muted">
        Enroll one branch-bound gateway per device. The one-time <code>rcg_</code> enrollment secret
        authenticates that gateway; it is distinct from HLS reader and DVR camera credentials.
      </p>
      {secret && !acknowledged && (
        <div className="mb-5 space-y-3 rounded-md border border-warning bg-warning/10 p-4">
          <p className="font-semibold text-text-strong">Copy the secret for {secretFor} now</p>
          <code className="block break-all text-sm text-text-strong">{secret}</code>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void navigator.clipboard.writeText(secret)}
          >
            Copy secret
          </Button>
          <label className="flex items-start gap-2 text-sm text-text-strong">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => {
                setAcknowledged(event.target.checked);
                if (event.target.checked) setSecret('');
              }}
            />
            I saved this one-time secret. It cannot be shown again.
          </label>
        </div>
      )}
      <form onSubmit={submitEnrollment} className="grid gap-4 md:grid-cols-2">
        <label className="text-sm font-medium text-text-strong">
          Branch
          <select
            name="branchId"
            required
            disabled={branchesLoading || branchesError || branches.length === 0}
            defaultValue=""
            className="h-11 w-full rounded-md border border-input bg-surface-raised px-3"
          >
            <option value="" disabled>
              {branchesLoading ? 'Loading branches…' : 'Select branch'}
            </option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-text-strong">
          Gateway name
          <Input name="name" required />
        </label>
        <label className="text-sm font-medium text-text-strong">
          Private HTTPS base URL
          <Input name="baseUrl" type="url" placeholder="https://gateway.internal" required />
        </label>
        <label className="text-sm font-medium text-text-strong">
          Registry retention (days)
          <Input name="retentionDays" type="number" min={1} max={90} defaultValue={7} required />
        </label>
        <div className="md:col-span-2">
          <Button
            disabled={enroll.isPending || branchesLoading || branchesError || !branches.length}
          >
            {enroll.isPending ? 'Enrolling…' : 'Enroll gateway'}
          </Button>
        </div>
      </form>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {gateways.map((gateway) => (
          <div key={gateway.id} className="space-y-3 rounded-md border border-border-subtle p-4">
            <div>
              <p className="font-semibold text-text-strong">{gateway.name}</p>
              <p className="text-sm text-text-muted">
                {gateway.health} · {gateway.status} · {gateway.baseUrl}
              </p>
            </div>
            {gateway.status !== 'REVOKED' && (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={rotate.isPending}
                  onClick={() => rotate.mutate({ gatewayId: gateway.id })}
                >
                  Rotate enrollment secret
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => setRevokingGatewayId(gateway.id)}
                >
                  Revoke gateway…
                </Button>
              </>
            )}
          </div>
        ))}
      </div>
      {revokingGatewayId && (
        <form
          className="mt-5 grid gap-3 rounded-md border border-destructive p-4"
          onSubmit={(event) => submitRevocation(event, revokingGatewayId)}
        >
          <p className="font-semibold text-text-strong">Co-authorize gateway revocation</p>
          <p className="text-sm text-text-muted">
            Two different active staff members must act and approve. Revocation immediately stops
            gateway access.
          </p>
          {revocationActors.isLoading ? (
            <p role="status" className="text-sm text-text-muted">
              Loading eligible staff…
            </p>
          ) : revocationActors.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Eligible staff could not be loaded.
            </p>
          ) : (
            <>
              <input
                type="hidden"
                name="actingStaffProfileId"
                value={revocationActors.data?.actingStaff.id ?? ''}
              />
              <p className="text-sm text-text-strong">
                Acting staff: {revocationActors.data?.actingStaff.displayName}
              </p>
              <label className="text-sm font-medium text-text-strong">
                Approving staff
                <select
                  name="approvingStaffProfileId"
                  required
                  defaultValue=""
                  className="h-11 w-full rounded-md border border-input bg-surface-raised px-3"
                >
                  <option value="" disabled>
                    Select a different active staff member
                  </option>
                  {(revocationActors.data?.approvers ?? []).map((staff) => (
                    <option key={staff.id} value={staff.id}>
                      {staff.displayName}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <select
            name="approvingType"
            className="h-11 rounded-md border border-input bg-surface-raised px-3"
          >
            <option value="PIN">Approving PIN</option>
            <option value="BADGE">Approving badge</option>
          </select>
          <Input
            name="approvingSecret"
            type="password"
            autoComplete="new-password"
            placeholder="Approving credential"
            required
          />
          <Input name="reason" placeholder="Reason for revocation" required />
          <div className="flex flex-wrap gap-3">
            <Button
              variant="destructive"
              disabled={revoke.isPending || !revocationActors.data?.approvers.length}
            >
              Revoke gateway
            </Button>
            <Button type="button" variant="secondary" onClick={() => setRevokingGatewayId('')}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </SectionCard>
  );
}
