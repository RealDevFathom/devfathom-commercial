'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useEntitlements } from '@/components/entitlements-provider';
import { CameraLivePlayer } from '@/components/camera/camera-live-player';
import {
  CameraEvidenceViewer,
  type CameraEvidenceViewerState,
} from '@/components/camera/camera-evidence-viewer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { CAMERA_PRESET_LABELS } from '@/lib/cameras/camera-preset';
import { CAMERA_DIAGNOSTIC_MESSAGES, CAMERA_H265_NOTE } from '@/lib/cameras/diagnostic-messages';
import { isModuleGranted } from '@/lib/module-catalog';
import { trpc } from '@/lib/trpc';
import { PharmacyCameraWizard, type PharmacyCameraWizardValues } from './pharmacy-camera-wizard';
import {
  PharmacyConfiguredSetup,
  type PharmacyConfiguredCameraValues,
  type PharmacyConfiguredGatewayValues,
} from './pharmacy-configured-setup';

/** Pharmacy evidence subjects, including the owner-only daily close. */
export const PHARMACY_EVIDENCE_SUBJECTS: Record<string, string> = {
  PHARMACY_TENDER: 'Tender',
  PHARMACY_REFUND: 'Refund',
  PHARMACY_DAILY_CLOSE: 'Daily close',
  PHARMACY_TEMPERATURE_EXCURSION: 'Cold-chain excursion',
};

const ACCESS_CODES = new Set(['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND']);
function errorCode(error: unknown): string {
  return (error as { data?: { code?: string } | null } | null)?.data?.code ?? '';
}

const field =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

type WorkspaceCamera = {
  id: string;
  name: string;
  branchId: string;
  gatewayId: string;
  sourceRef: string;
  enabled: boolean;
  preset: 'COUNTER' | 'COLD_CHAIN' | 'KITCHEN' | null;
  temperatureZoneId: string | null;
  counterEvidence: boolean;
  /** Server-decided: a snapshot binding exists for this exact camera scope. */
  evidenceStills?: boolean;
};
type Zone = { id: string; name: string; branchId: string };

/** Same-origin authorized stream; the browser never receives a gateway or DVR URL. */
export const pharmacyStreamUrl = (cameraId: string, grantId: string) =>
  `/api/pharmacy/cameras/${encodeURIComponent(cameraId)}/stream?grant=${encodeURIComponent(grantId)}`;

function ConfiguredConnectionCheck({ cameraId }: { cameraId: string }) {
  const check = trpc.pharmacyCameras.configuredConnectionDiagnostics.useMutation({
    retry: false,
  });
  return (
    <div className="mt-3 space-y-2">
      <Button
        variant="secondary"
        disabled={check.isPending}
        onClick={() => check.mutate({ cameraId })}
      >
        Check configured connection
      </Button>
      <p role="status" className="text-sm text-text-muted">
        {check.isPending
          ? 'Checking gateway…'
          : check.isError
            ? 'Connection check failed. Check your access and gateway setup.'
            : check.data
              ? CAMERA_DIAGNOSTIC_MESSAGES[check.data.outcome]
              : 'Connection not checked.'}
      </p>
      {check.data && 'videoCodec' in check.data && check.data.videoCodec === 'h265' ? (
        <p className="text-sm text-text-muted">{CAMERA_H265_NOTE}</p>
      ) : null}
    </div>
  );
}
type Viewer = { cameraId: string; grantId: string };

function CameraSettingsForm({
  camera,
  zones,
  pending,
  onSave,
}: {
  camera: WorkspaceCamera;
  zones: Zone[];
  pending: boolean;
  onSave: (input: {
    cameraId: string;
    preset: 'COUNTER' | 'COLD_CHAIN' | null;
    temperatureZoneId: string | null;
    enabled: boolean;
  }) => void;
}) {
  const [preset, setPreset] = useState<'' | 'COUNTER' | 'COLD_CHAIN'>(
    camera.preset === 'COUNTER' || camera.preset === 'COLD_CHAIN' ? camera.preset : ''
  );
  const branchZones = zones.filter((zone) => zone.branchId === camera.branchId);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSave({
      cameraId: camera.id,
      preset: preset || null,
      temperatureZoneId:
        preset === 'COLD_CHAIN' ? String(data.get('temperatureZoneId') ?? '') || null : null,
      enabled: data.get('enabled') === 'on',
    });
  }
  return (
    <form aria-label={`Settings for ${camera.name}`} className="mt-3 grid gap-3" onSubmit={submit}>
      <label className="text-sm font-medium text-text-strong">
        Preset
        <select
          name="preset"
          className={field}
          value={preset}
          onChange={(event) => setPreset(event.target.value as typeof preset)}
        >
          <option value="">No preset</option>
          <option value="COUNTER">
            {CAMERA_PRESET_LABELS.COUNTER} (tender, refund, daily close)
          </option>
          <option value="COLD_CHAIN">{CAMERA_PRESET_LABELS.COLD_CHAIN}</option>
        </select>
      </label>
      {preset === 'COLD_CHAIN' &&
        (branchZones.length ? (
          <label className="text-sm font-medium text-text-strong">
            Cold-chain zone
            <select
              name="temperatureZoneId"
              required
              className={field}
              defaultValue={camera.temperatureZoneId ?? ''}
            >
              <option value="" disabled>
                Select zone
              </option>
              {branchZones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p role="status" className="text-sm text-text-muted">
            No active cold-chain zone in this branch.
          </p>
        ))}
      <label className="flex items-center gap-2 text-sm text-text-strong">
        <input type="checkbox" name="enabled" defaultChecked={camera.enabled} /> Enabled
      </label>
      <Button
        type="submit"
        variant="secondary"
        disabled={pending || (preset === 'COLD_CHAIN' && branchZones.length === 0)}
      >
        Save camera settings
      </Button>
    </form>
  );
}

export function PharmacyCamerasConsole() {
  const enabled = isModuleGranted('pharmacy-core', useEntitlements().enabledModules);
  const utils = trpc.useUtils();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [viewerOpening, setViewerOpening] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState<string | null>(null);
  const [enrollBranchId, setEnrollBranchId] = useState('');
  const [liveCameraId, setLiveCameraId] = useState<string | null>(null);

  const workspace = trpc.pharmacyCameras.workspace.useQuery(undefined, {
    enabled,
    retry: false,
  });
  const workspaceAccessLost = workspace.isError && ACCESS_CODES.has(errorCode(workspace.error));
  const evidence = trpc.pharmacyCameras.evidence.useQuery(
    { cameraId: viewer?.cameraId ?? '', grantId: viewer?.grantId ?? '' },
    { enabled: enabled && !workspaceAccessLost && Boolean(viewer), retry: false }
  );
  const evidenceAccessLost = evidence.isError && ACCESS_CODES.has(errorCode(evidence.error));

  const invalidate = () => void utils.pharmacyCameras.workspace.invalidate();
  const enroll = trpc.pharmacyCameras.enrollGateway.useMutation({
    onSuccess: (_gateway, variables) => {
      toast.success(
        variables.baseUrl ? 'Configured gateway registered.' : 'Diagnostic gateway registered.'
      );
      invalidate();
    },
  });
  const test = trpc.pharmacyCameras.testConnection.useMutation();
  const register = trpc.pharmacyCameras.register.useMutation({ onSuccess: invalidate });
  const configure = trpc.pharmacyCameras.configure.useMutation({
    onSuccess: () => {
      toast.success('Camera settings saved.');
      invalidate();
    },
    onError: (error) => toast.error(error.message || 'Camera settings could not be saved.'),
  });
  const retention = trpc.pharmacyCameras.setRetention.useMutation({
    onSuccess: () => {
      toast.success('Evidence retention updated.');
      invalidate();
    },
    onError: () => toast.error('Retention could not be updated. Check your access.'),
  });
  const grant = trpc.pharmacyCameras.issueViewerGrant.useMutation({ retry: false });
  const revoke = trpc.pharmacyCameras.revokeViewerGrant.useMutation({ retry: false });
  const liveGrant = trpc.pharmacyCameras.issueLiveViewGrant.useMutation({ retry: false });
  const releaseLive = trpc.pharmacyCameras.revokeViewerGrant.useMutation({ retry: false });
  const capture = trpc.pharmacyCameras.capturePending.useMutation({
    onSuccess: () => void evidence.refetch(),
    onError: () => toast.error('Pending stills could not be captured.'),
  });

  // Access lost mid-view (grant expired/revoked, role or branch removed): drop
  // the grant so the read is disabled, then purge cached stills. Doing it in
  // that order means the reset cannot refetch the failing read.
  if (viewer && (evidenceAccessLost || workspaceAccessLost || !enabled)) {
    setAccessLost(viewer.cameraId);
    setViewer(null);
  }
  // The player stops and releases its grant when it unmounts.
  // A view whose camera is disabled or gone closes for good, so re-enabling the
  // camera later never restarts video by itself.
  const liveCamera = workspace.data?.cameras.find((camera) => camera.id === liveCameraId);
  if (liveCameraId && (workspaceAccessLost || !enabled || (workspace.data && !liveCamera?.enabled)))
    setLiveCameraId(null);
  useEffect(() => {
    if (!viewer || !enabled) void utils.pharmacyCameras.evidence.reset();
  }, [viewer, enabled, utils]);

  if (!enabled)
    return (
      <SectionCard title="Pharmacy cameras unavailable">
        <p role="status" className="text-sm text-text-muted">
          This module is not enabled for your organization.
        </p>
      </SectionCard>
    );
  if (workspace.isLoading)
    return (
      <SectionCard title="Checking pharmacy cameras">
        <p role="status" className="text-sm text-text-muted">
          Checking camera access…
        </p>
      </SectionCard>
    );
  if (workspace.isError || !workspace.data)
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Pharmacy devices" heading="Cameras" />
        <SectionCard title="Cameras unavailable" titleLevel={2}>
          <p role="alert" className="text-sm text-text-muted">
            {ACCESS_CODES.has(errorCode(workspace.error))
              ? 'Camera settings are available to pharmacy owners only.'
              : 'Camera settings could not be loaded.'}
          </p>
          {!ACCESS_CODES.has(errorCode(workspace.error)) ? (
            <Button className="mt-3" variant="secondary" onClick={() => void workspace.refetch()}>
              Try again
            </Button>
          ) : null}
        </SectionCard>
      </div>
    );

  const { branches, gateways, cameras, zones, availability } = workspace.data;
  const simulated = availability.available && availability.mode === 'simulated';
  const configured = availability.available && availability.mode === 'mediamtx';
  const branchName = (id: string) =>
    branches.find((b) => b.id === id)?.name ?? 'Unavailable branch';
  const effectiveEnrollBranch = enrollBranchId || (branches.length === 1 ? branches[0]!.id : '');

  async function onTest(values: PharmacyCameraWizardValues) {
    return test.mutateAsync({ branchId: values.branchId, sourceRef: values.sourceRef });
  }
  async function onSubmit(values: PharmacyCameraWizardValues) {
    await register.mutateAsync(values);
  }
  async function onEnrollConfigured(values: PharmacyConfiguredGatewayValues) {
    await enroll.mutateAsync(values);
  }
  async function onRegisterConfigured(values: PharmacyConfiguredCameraValues) {
    await register.mutateAsync({ ...values, registerAnyway: false });
  }
  async function openEvidence(cameraId: string) {
    setAccessLost(null);
    setViewerOpening(cameraId);
    try {
      const issued = await grant.mutateAsync({ cameraId });
      setViewer({ cameraId, grantId: issued.id });
    } catch {
      setAccessLost(cameraId);
    } finally {
      setViewerOpening(null);
    }
  }
  function closeEvidence() {
    if (viewer) revoke.mutate({ cameraId: viewer.cameraId, grantId: viewer.grantId });
    setViewer(null);
    setAccessLost(null);
  }
  function enrollGateway(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    enroll.mutate({
      branchId: effectiveEnrollBranch,
      name: String(data.get('name') ?? '').trim(),
      retentionDays: Number(data.get('retentionDays')),
    });
  }
  function updateRetention(event: FormEvent<HTMLFormElement>, branchId: string) {
    event.preventDefault();
    retention.mutate({ branchId, days: Number(new FormData(event.currentTarget).get('days')) });
  }
  function viewerState(cameraId: string): CameraEvidenceViewerState | null {
    if (viewerOpening === cameraId) return 'loading';
    if (accessLost === cameraId) return 'access-lost';
    if (viewer?.cameraId !== cameraId) return null;
    if (evidence.isLoading) return 'loading';
    if (evidence.isError) return 'error';
    return 'ready';
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy devices"
        heading="Cameras"
        description={
          configured
            ? 'Live view through your owner-provisioned camera gateway. Recordings and new evidence stills are not supported by this gateway.'
            : 'Counter and cold-chain camera presets with private evidence stills. Live video and recordings are unavailable.'
        }
      />
      {!availability.available ? (
        <SectionCard eyebrow="Gateway" title="Camera gateway not configured" titleLevel={2}>
          <p role="status" className="text-sm text-text-muted">
            Camera setup and evidence capture stay unavailable until an administrator configures a
            supported gateway. No camera footage is being simulated.
          </p>
        </SectionCard>
      ) : configured ? (
        <PharmacyConfiguredSetup
          branches={branches}
          gateways={gateways}
          onEnrollGateway={onEnrollConfigured}
          onRegisterCamera={onRegisterConfigured}
          busy={enroll.isPending || register.isPending}
        />
      ) : !simulated ? (
        <SectionCard eyebrow="Gateway" title="Setup unavailable for this gateway" titleLevel={2}>
          <p role="status" className="text-sm text-text-muted">
            Pharmacy camera setup here supports only the diagnostic simulator. Registered cameras
            and existing evidence remain listed below.
          </p>
        </SectionCard>
      ) : (
        <>
          <SectionCard eyebrow="Diagnostic gateway" title="Register a gateway">
            <p className="mb-4 text-sm text-text-muted">
              Registers a diagnostic simulator gateway for one branch. No hardware connection is
              made. Simulator stills are 1×1 test images, not physical camera proof.
            </p>
            <form
              aria-label="Register a gateway"
              className="grid gap-4 md:grid-cols-3"
              onSubmit={enrollGateway}
            >
              {branches.length > 1 ? (
                <label className="text-sm font-medium text-text-strong">
                  Branch
                  <select
                    className={field}
                    value={enrollBranchId}
                    required
                    onChange={(event) => setEnrollBranchId(event.target.value)}
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
              ) : null}
              <label className="text-sm font-medium text-text-strong">
                Gateway name
                <Input name="name" required maxLength={120} />
              </label>
              <label className="text-sm font-medium text-text-strong">
                Evidence retention days
                <Input
                  name="retentionDays"
                  type="number"
                  min={1}
                  max={90}
                  defaultValue={7}
                  required
                />
              </label>
              <div className="md:col-span-3">
                <Button type="submit" disabled={enroll.isPending || !effectiveEnrollBranch}>
                  Register gateway
                </Button>
              </div>
            </form>
          </SectionCard>
          <PharmacyCameraWizard
            branches={branches}
            gateways={gateways}
            onTest={onTest}
            onSubmit={onSubmit}
            busy={test.isPending || register.isPending}
          />
        </>
      )}
      <SectionCard eyebrow="Cameras" title="Registered cameras">
        {cameras.length === 0 ? (
          <p className="text-sm text-text-muted">No cameras registered yet.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {cameras.map((camera) => {
              const state = viewerState(camera.id);
              return (
                <article
                  key={camera.id}
                  className="rounded-md border border-border-subtle bg-surface-sunken p-4"
                >
                  {configured && liveCameraId === camera.id && camera.enabled ? (
                    <CameraLivePlayer
                      cameraId={camera.id}
                      name={camera.name}
                      streamUrl={pharmacyStreamUrl}
                      issue={(previousGrantId) =>
                        liveGrant.mutateAsync({ cameraId: camera.id, previousGrantId })
                      }
                      onRelease={(grantId) => releaseLive.mutate({ cameraId: camera.id, grantId })}
                    />
                  ) : (
                    <div className="flex aspect-video items-center justify-center rounded-sm bg-foreground/10 p-3 text-center text-sm text-text-muted">
                      {configured
                        ? camera.enabled
                          ? 'Live view closed. Recordings unavailable.'
                          : 'Disabled. Enable after the configured connection check passes.'
                        : 'Live video unavailable. Recordings unavailable.'}
                    </div>
                  )}
                  <h3 className="mt-3 font-semibold text-text-strong">{camera.name}</h3>
                  <p className="text-sm text-text-muted">
                    {branchName(camera.branchId)} ·{' '}
                    {camera.preset ? CAMERA_PRESET_LABELS[camera.preset] : 'No preset'} ·{' '}
                    {camera.enabled ? 'Enabled' : 'Disabled'}
                    {camera.counterEvidence ? ' · Captures counter evidence' : ''}
                  </p>
                  {configured ? (
                    <>
                      <dl className="mt-2 grid gap-1 font-mono text-xs text-text-muted">
                        <div className="flex flex-wrap gap-x-2">
                          <dt>Camera ID</dt>
                          <dd className="break-all text-text-strong">{camera.id}</dd>
                        </div>
                        <div className="flex flex-wrap gap-x-2">
                          <dt>Gateway ID</dt>
                          <dd className="break-all text-text-strong">{camera.gatewayId}</dd>
                        </div>
                        <div className="flex flex-wrap gap-x-2">
                          <dt>Branch ID</dt>
                          <dd className="break-all text-text-strong">{camera.branchId}</dd>
                        </div>
                        <div className="flex flex-wrap gap-x-2">
                          <dt>Organization ID</dt>
                          <dd className="break-all text-text-strong">
                            {workspace.data.organizationId}
                          </dd>
                        </div>
                      </dl>
                      <div className="mt-3 flex flex-wrap gap-3">
                        <Button
                          variant="secondary"
                          disabled={!camera.enabled}
                          onClick={() =>
                            setLiveCameraId(liveCameraId === camera.id ? null : camera.id)
                          }
                        >
                          {liveCameraId === camera.id ? 'Close live view' : 'Open live view'}
                        </Button>
                      </div>
                      <ConfiguredConnectionCheck cameraId={camera.id} />
                      <p role="note" className="mt-3 text-sm text-text-muted">
                        {camera.evidenceStills
                          ? 'Evidence stills: a gateway snapshot service is configured for this camera. Capture still needs verification on the real device.'
                          : 'Evidence stills: no gateway snapshot service is configured for this camera, so new counter and cold-chain events record the still as unavailable. Earlier stills remain viewable.'}
                      </p>
                    </>
                  ) : null}
                  <CameraSettingsForm
                    key={`${camera.id}:${camera.preset ?? ''}:${camera.temperatureZoneId ?? ''}:${camera.enabled}`}
                    camera={camera}
                    zones={zones}
                    pending={configure.isPending}
                    onSave={(input) => configure.mutate(input)}
                  />
                  <div className="mt-3">
                    {state ? (
                      <CameraEvidenceViewer
                        cameraName={camera.name}
                        state={state}
                        items={state === 'ready' ? (evidence.data ?? []) : []}
                        subjectLabels={PHARMACY_EVIDENCE_SUBJECTS}
                        refreshing={evidence.isFetching}
                        capturing={capture.isPending}
                        onRefresh={
                          viewer?.cameraId === camera.id ? () => void evidence.refetch() : undefined
                        }
                        onCapturePending={
                          simulated ? () => capture.mutate({ cameraId: camera.id }) : undefined
                        }
                        onClose={closeEvidence}
                      />
                    ) : (
                      <Button
                        variant="secondary"
                        disabled={!camera.enabled || Boolean(viewerOpening)}
                        onClick={() => {
                          if (viewer) closeEvidence();
                          void openEvidence(camera.id);
                        }}
                      >
                        Open private evidence
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </SectionCard>
      <SectionCard eyebrow="Retention" title="Evidence retention by branch">
        {gateways.length === 0 ? (
          <p className="text-sm text-text-muted">No gateways registered yet.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {branches
              .filter((branch) => gateways.some((gateway) => gateway.branchId === branch.id))
              .map((branch) => {
                const current = gateways.find(
                  (gateway) => gateway.branchId === branch.id && gateway.status === 'ACTIVE'
                );
                return (
                  <form
                    key={branch.id}
                    aria-label={`Retention for ${branch.name}`}
                    onSubmit={(event) => updateRetention(event, branch.id)}
                    className="rounded-md border border-border-subtle p-4"
                  >
                    <p className="font-semibold text-text-strong">{branch.name}</p>
                    <p className="mb-3 text-sm text-text-muted">
                      {current
                        ? `Current policy ${current.retentionDays} days`
                        : 'No active gateway'}
                    </p>
                    <label className="text-sm font-medium text-text-strong">
                      Retention days
                      <Input
                        name="days"
                        type="number"
                        min={1}
                        max={90}
                        defaultValue={current?.retentionDays ?? 7}
                        required
                      />
                    </label>
                    <Button
                      type="submit"
                      className="mt-3"
                      disabled={retention.isPending || !current}
                    >
                      Save retention
                    </Button>
                  </form>
                );
              })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
