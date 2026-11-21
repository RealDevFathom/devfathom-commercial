'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { toast } from 'sonner';

import { useEntitlements } from '@/components/entitlements-provider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';
import { RestaurantBranchSelect } from '../restaurant-branch-select';
import { RestaurantStaffSelect } from '../restaurant-staff-select';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type Floor = RouterOutputs['restaurantFloor']['listFloors'][number];
type Table = Floor['tables'][number];
type Section = RouterOutputs['restaurantFloor']['listSections'][number];
type Assignment = Section['assignments'][number];
type Station = RouterOutputs['restaurantFloor']['listStations'][number];
type RoutingRule = Station['routingRules'][number];
type UiError = { message: string; data?: { code?: string } | null };

type Editor =
  | { kind: 'floor'; item?: Floor }
  | { kind: 'table'; floorId: string; item?: Table }
  | { kind: 'section'; item?: Section }
  | { kind: 'membership'; section: Section }
  | { kind: 'assignment'; sectionId: string }
  | { kind: 'station'; item?: Station }
  | { kind: 'routing'; stationId: string; item?: RoutingRule };

type Confirmation = {
  title: string;
  description: string;
  label: string;
  destructive?: boolean;
  run: () => void;
};

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1.5">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );
}

function text(data: FormData, name: string) {
  return String(data.get(name) ?? '').trim();
}

function integer(data: FormData, name: string, fallback = 0) {
  const value = Number(text(data, name));
  return Number.isInteger(value) ? value : fallback;
}

function isPermissionError(error?: UiError | null) {
  return error?.data?.code === 'FORBIDDEN' || error?.data?.code === 'UNAUTHORIZED';
}

function editorTitle(editor: Editor) {
  const editing = 'item' in editor && editor.item != null;
  const names: Record<Editor['kind'], string> = {
    floor: 'floor',
    table: 'table',
    section: 'section',
    membership: 'section tables',
    assignment: 'server assignment',
    station: 'station',
    routing: 'routing rule',
  };
  return `${editor.kind === 'membership' ? 'Set' : editing ? 'Edit' : 'Add'} ${names[editor.kind]}`;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md border border-dashed border-border-default px-5 py-10 text-center">
      <p className="font-medium text-text-strong">{title}</p>
      <p className="mt-1 text-sm text-text-muted">{detail}</p>
    </div>
  );
}

export function FloorConsole() {
  const entitlements = useEntitlements();
  const posModule = entitlements.modules.find((module) => module.key === 'restaurant-pos');
  const posEnabled = posModule?.enabled ?? entitlements.enabledModules.includes('restaurant-pos');
  const utils = trpc.useUtils();
  const branchesQuery = trpc.restaurantStaff.listBranches.useQuery(undefined, {
    enabled: posEnabled,
  });
  const accessQuery = trpc.restaurantFloor.access.useQuery(undefined, { enabled: posEnabled });
  const [branchId, setBranchId] = useState('');
  const [businessDate, setBusinessDate] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [mutationError, setMutationError] = useState('');

  const normalizedBranchId = branchId.trim();
  const branchReady = posEnabled && normalizedBranchId.length > 0;
  const staffQuery = trpc.restaurantStaff.listDirectory.useQuery(
    { branchId: normalizedBranchId },
    { enabled: branchReady }
  );
  const sectionsReady = branchReady && businessDate.length > 0;
  const floorsQuery = trpc.restaurantFloor.listFloors.useQuery(
    { branchId: normalizedBranchId, includeInactive },
    { enabled: branchReady }
  );
  const sectionsQuery = trpc.restaurantFloor.listSections.useQuery(
    { branchId: normalizedBranchId, businessDate, includeInactive },
    { enabled: sectionsReady }
  );
  const stationsQuery = trpc.restaurantFloor.listStations.useQuery(
    { branchId: normalizedBranchId, includeInactive },
    { enabled: branchReady }
  );
  const productsQuery = trpc.restaurantCatalog.listProducts.useQuery(
    { status: 'ACTIVE' },
    { enabled: posEnabled && editor?.kind === 'routing' && !editor.item }
  );
  const categoriesQuery = trpc.restaurantCatalog.listCategories.useQuery(undefined, {
    enabled: posEnabled && editor?.kind === 'routing' && !editor.item,
  });
  const [routingTargetType, setRoutingTargetType] = useState<'product' | 'category' | 'course'>(
    'product'
  );
  const [routingTargetSearch, setRoutingTargetSearch] = useState('');

  const refresh = () => {
    void utils.restaurantFloor.listFloors.invalidate();
    void utils.restaurantFloor.listSections.invalidate();
    void utils.restaurantFloor.listStations.invalidate();
  };
  const succeed = (message: string) => {
    setEditor(null);
    setConfirmation(null);
    setMutationError('');
    refresh();
    toast.success(message);
  };
  const fail = (error: { message: string }) => {
    setMutationError(error.message);
    toast.error(error.message);
  };
  const options = (message: string) => ({ onSuccess: () => succeed(message), onError: fail });

  const createFloor = trpc.restaurantFloor.createFloor.useMutation(options('Floor created.'));
  const updateFloor = trpc.restaurantFloor.updateFloor.useMutation(options('Floor updated.'));
  const deleteFloor = trpc.restaurantFloor.deleteFloor.useMutation(options('Floor deleted.'));
  const createTable = trpc.restaurantFloor.createTable.useMutation(options('Table created.'));
  const updateTable = trpc.restaurantFloor.updateTable.useMutation(options('Table updated.'));
  const deleteTable = trpc.restaurantFloor.deleteTable.useMutation(options('Table deleted.'));
  const createSection = trpc.restaurantFloor.createSection.useMutation(options('Section created.'));
  const updateSection = trpc.restaurantFloor.updateSection.useMutation(options('Section updated.'));
  const deleteSection = trpc.restaurantFloor.deleteSection.useMutation(options('Section deleted.'));
  const setSectionTables = trpc.restaurantFloor.setSectionTables.useMutation(
    options('Section tables updated.')
  );
  const assignServer = trpc.restaurantFloor.assignServer.useMutation(options('Server assigned.'));
  const unassignServer = trpc.restaurantFloor.unassignServer.useMutation(
    options('Server unassigned.')
  );
  const createStation = trpc.restaurantFloor.createStation.useMutation(options('Station created.'));
  const updateStation = trpc.restaurantFloor.updateStation.useMutation(options('Station updated.'));
  const setDefaultStation = trpc.restaurantFloor.setDefaultStation.useMutation(
    options('Default station updated.')
  );
  const deleteStation = trpc.restaurantFloor.deleteStation.useMutation(options('Station deleted.'));
  const createRoutingRule = trpc.restaurantFloor.createRoutingRule.useMutation(
    options('Routing rule created.')
  );
  const updateRoutingRule = trpc.restaurantFloor.updateRoutingRule.useMutation(
    options('Routing rule updated.')
  );
  const deleteRoutingRule = trpc.restaurantFloor.deleteRoutingRule.useMutation(
    options('Routing rule deleted.')
  );

  const busy = (
    [
      createFloor,
      updateFloor,
      deleteFloor,
      createTable,
      updateTable,
      deleteTable,
      createSection,
      updateSection,
      deleteSection,
      setSectionTables,
      assignServer,
      unassignServer,
      createStation,
      updateStation,
      setDefaultStation,
      deleteStation,
      createRoutingRule,
      updateRoutingRule,
      deleteRoutingRule,
    ] as const
  ).some((mutation) => mutation.isPending);

  const floors = floorsQuery.data ?? [];
  const allTables = floors.flatMap((floor) => floor.tables);
  const occupiedTables = allTables.filter((table) => table.occupied).length;
  const readError =
    accessQuery.error ?? floorsQuery.error ?? sectionsQuery.error ?? stationsQuery.error;
  const permissionDenied = isPermissionError(readError);
  const canManage = accessQuery.data?.canManage === true;
  const loading = accessQuery.isLoading || floorsQuery.isLoading || stationsQuery.isLoading;

  const openEditor = (value: Editor) => {
    setMutationError('');
    setEditor(value);
  };
  const confirm = (value: Confirmation) => {
    setMutationError('');
    setConfirmation(value);
  };

  const submitEditor = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor) return;
    const data = new FormData(event.currentTarget);
    switch (editor.kind) {
      case 'floor':
        if (editor.item) {
          updateFloor.mutate({
            id: editor.item.id,
            name: text(data, 'name'),
            sortOrder: integer(data, 'sortOrder'),
            active: data.has('active'),
          });
        } else {
          createFloor.mutate({
            branchId: normalizedBranchId,
            name: text(data, 'name'),
            sortOrder: integer(data, 'sortOrder'),
          });
        }
        break;
      case 'table':
        if (editor.item) {
          updateTable.mutate({
            id: editor.item.id,
            code: text(data, 'code'),
            capacity: integer(data, 'capacity', 1),
            active: data.has('active'),
          });
        } else {
          createTable.mutate({
            floorId: editor.floorId,
            code: text(data, 'code'),
            capacity: integer(data, 'capacity', 1),
          });
        }
        break;
      case 'section':
        if (editor.item) {
          updateSection.mutate({
            id: editor.item.id,
            name: text(data, 'name'),
            active: data.has('active'),
          });
        } else {
          createSection.mutate({ branchId: normalizedBranchId, name: text(data, 'name') });
        }
        break;
      case 'membership':
        setSectionTables.mutate({
          sectionId: editor.section.id,
          tableIds: data.getAll('tableIds').map(String),
        });
        break;
      case 'assignment':
        assignServer.mutate({
          sectionId: editor.sectionId,
          staffProfileId: text(data, 'staffProfileId'),
          businessDate: text(data, 'businessDate'),
        });
        break;
      case 'station':
        if (editor.item) {
          updateStation.mutate({
            id: editor.item.id,
            name: text(data, 'name'),
            active: data.has('active'),
          });
        } else {
          createStation.mutate({
            branchId: normalizedBranchId,
            name: text(data, 'name'),
            isDefault: data.has('isDefault'),
          });
        }
        break;
      case 'routing':
        if (editor.item) {
          updateRoutingRule.mutate({
            id: editor.item.id,
            priority: integer(data, 'priority'),
          });
        } else {
          const targetId = text(data, 'targetId');
          const targetType = text(data, 'targetType');
          createRoutingRule.mutate({
            stationId: editor.stationId,
            productId: targetType === 'product' ? targetId : null,
            categoryId: targetType === 'category' ? targetId : null,
            course: targetType === 'course' ? integer(data, 'course', 1) : null,
            priority: integer(data, 'priority'),
          });
        }
        break;
    }
  };

  const confirmDeleteFloor = (floor: Floor) =>
    confirm({
      title: `Delete ${floor.name}?`,
      description: 'Floors with order-table history cannot be deleted. Deactivate them instead.',
      label: 'Delete floor',
      destructive: true,
      run: () => deleteFloor.mutate({ id: floor.id }),
    });
  const confirmDeleteTable = (table: Table) =>
    confirm({
      title: `Delete table ${table.code}?`,
      description: 'Tables with order history cannot be deleted. Deactivate them instead.',
      label: 'Delete table',
      destructive: true,
      run: () => deleteTable.mutate({ id: table.id }),
    });
  const confirmDeleteSection = (section: Section) =>
    confirm({
      title: `Delete ${section.name}?`,
      description: 'Sections referenced by orders cannot be deleted. Deactivate them instead.',
      label: 'Delete section',
      destructive: true,
      run: () => deleteSection.mutate({ id: section.id }),
    });
  const confirmUnassign = (section: Section, assignment: Assignment) =>
    confirm({
      title: `Unassign ${assignment.staffDisplayName}?`,
      description: `Remove this server from ${section.name} for ${businessDate}.`,
      label: 'Unassign server',
      destructive: true,
      run: () =>
        unassignServer.mutate({
          sectionId: section.id,
          staffProfileId: assignment.staffProfileId,
          businessDate,
        }),
    });
  const confirmDeleteStation = (station: Station) =>
    confirm({
      title: `Delete ${station.name}?`,
      description: 'Stations with kitchen tickets cannot be deleted. Deactivate them instead.',
      label: 'Delete station',
      destructive: true,
      run: () => deleteStation.mutate({ id: station.id }),
    });
  const confirmDeleteRule = (rule: RoutingRule) =>
    confirm({
      title: 'Delete routing rule?',
      description: `Remove routing for ${rule.productName ?? rule.categoryName ?? 'this target'}.`,
      label: 'Delete rule',
      destructive: true,
      run: () => deleteRoutingRule.mutate({ id: rule.id }),
    });

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Floor"
        description="Manage floor occupancy, server sections, and kitchen routing by branch."
        actions={
          posEnabled && branchReady && !permissionDenied && canManage ? (
            <Button className="min-h-11" onClick={() => openEditor({ kind: 'floor' })}>
              Add floor
            </Button>
          ) : null
        }
      />

      {!posEnabled ? (
        <SectionCard title="Restaurant POS module disabled">
          <div className="space-y-3" role="status">
            <StatusPill status="Disabled" tone="warning" />
            <p className="max-w-2xl text-sm text-text-muted">
              Floor, section, and station tools require the Restaurant POS entitlement.
            </p>
          </div>
        </SectionCard>
      ) : (
        <>
          <SectionCard eyebrow="Scope" title="Branch and service date" titleLevel={2}>
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_13rem_auto] md:items-end">
              <Field label="Branch">
                <RestaurantBranchSelect
                  branches={branchesQuery.data ?? []}
                  loading={branchesQuery.isLoading}
                  error={Boolean(branchesQuery.error)}
                  value={branchId}
                  onChange={setBranchId}
                />
              </Field>
              <Field label="Business date">
                <Input
                  aria-label="Business date"
                  type="date"
                  value={businessDate}
                  onChange={(event) => setBusinessDate(event.target.value)}
                  className="h-11"
                />
              </Field>
              <label className="flex min-h-11 items-center gap-2 rounded-md border border-border-default px-3 text-sm text-text-strong">
                <input
                  type="checkbox"
                  checked={includeInactive}
                  onChange={(event) => setIncludeInactive(event.target.checked)}
                />
                Include inactive
              </label>
            </div>
          </SectionCard>

          {!branchReady ? (
            <SectionCard title="Choose a branch">
              <EmptyState
                title="Branch required"
                detail="Select a branch to load floors and stations. Add a business date to load assignments."
              />
            </SectionCard>
          ) : permissionDenied ? (
            <SectionCard title="Floor access unavailable">
              <p role="alert" className="text-sm text-destructive">
                You do not have permission to read this restaurant floor.
              </p>
            </SectionCard>
          ) : readError ? (
            <SectionCard title="Floor data unavailable">
              <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-destructive">{readError.message}</p>
                <Button variant="outline" onClick={refresh}>
                  Try again
                </Button>
              </div>
            </SectionCard>
          ) : loading ? (
            <SectionCard title="Loading floor…">
              <div role="status" aria-label="Loading floor data" className="space-y-3">
                {[0, 1, 2].map((row) => (
                  <Skeleton key={row} className="h-20 w-full" />
                ))}
              </div>
            </SectionCard>
          ) : (
            <>
              {!canManage ? (
                <SectionCard title="Read-only floor">
                  <p role="status" className="text-sm text-text-muted">
                    You can review floor occupancy and routing. A restaurant manager must make
                    configuration changes.
                  </p>
                </SectionCard>
              ) : null}
              <SectionCard eyebrow="Live ledger" title="Floor snapshot">
                <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                  <Stat label="Floors" value={floors.length} />
                  <Stat label="Tables" value={allTables.length} />
                  <Stat label="Occupied" value={occupiedTables} />
                  <Stat
                    label="Available"
                    value={allTables.filter((table) => table.active && !table.occupied).length}
                  />
                </div>
              </SectionCard>

              <SectionCard eyebrow="Service map" title="Floors and tables">
                {floors.length === 0 ? (
                  <EmptyState
                    title="No floors found"
                    detail="Add the first floor for this branch."
                  />
                ) : (
                  <div className="grid gap-4 xl:grid-cols-2">
                    {floors.map((floor) => (
                      <section
                        key={floor.id}
                        aria-labelledby={`floor-${floor.id}`}
                        className="rounded-md border border-border-subtle bg-surface-sunken p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <h3
                                id={`floor-${floor.id}`}
                                className="font-semibold text-text-strong"
                              >
                                {floor.name}
                              </h3>
                              <StatusPill
                                status={floor.active ? 'Active' : 'Inactive'}
                                tone={floor.active ? 'success' : 'neutral'}
                              />
                            </div>
                            <p className="mt-1 font-mono text-[0.6875rem] text-text-faint">
                              {floor.name} · sort {floor.sortOrder}
                            </p>
                          </div>
                          {canManage ? (
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => openEditor({ kind: 'table', floorId: floor.id })}
                              >
                                Add table
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => openEditor({ kind: 'floor', item: floor })}
                              >
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => confirmDeleteFloor(floor)}
                              >
                                Delete
                              </Button>
                            </div>
                          ) : null}
                        </div>
                        {floor.tables.length === 0 ? (
                          <p className="mt-4 text-sm text-text-muted">No tables on this floor.</p>
                        ) : (
                          <div className="mt-4 grid gap-3 sm:grid-cols-2">
                            {floor.tables.map((table) => (
                              <div
                                key={table.id}
                                data-tour={
                                  table.id === allTables[0]?.id ? 'floor-table' : undefined
                                }
                                className="rounded-md border border-border-default bg-card p-3"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="font-medium text-text-strong">
                                      Table {table.code}
                                    </p>
                                    <p className="text-xs text-text-muted">
                                      {table.capacity} seats · {table.activeOrderIds.length} active
                                      order
                                      {table.activeOrderIds.length === 1 ? '' : 's'}
                                    </p>
                                  </div>
                                  <StatusPill
                                    status={
                                      table.occupied
                                        ? 'Occupied'
                                        : table.active
                                          ? 'Available'
                                          : 'Inactive'
                                    }
                                    tone={
                                      table.occupied
                                        ? 'warning'
                                        : table.active
                                          ? 'success'
                                          : 'neutral'
                                    }
                                  />
                                </div>
                                {table.activeOrderIds.length ? (
                                  <p className="mt-2 break-all font-mono text-[0.625rem] text-text-faint">
                                    {table.activeOrderIds.join(', ')}
                                  </p>
                                ) : null}
                                {canManage ? (
                                  <div className="mt-3 flex gap-2">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() =>
                                        openEditor({
                                          kind: 'table',
                                          floorId: floor.id,
                                          item: table,
                                        })
                                      }
                                    >
                                      Edit
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="destructive"
                                      onClick={() => confirmDeleteTable(table)}
                                    >
                                      Delete
                                    </Button>
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        )}
                      </section>
                    ))}
                  </div>
                )}
              </SectionCard>

              <div className="grid gap-5 xl:grid-cols-2">
                <SectionCard
                  eyebrow="Date assignment"
                  title="Server sections"
                  actions={
                    canManage ? (
                      <Button size="sm" onClick={() => openEditor({ kind: 'section' })}>
                        Add section
                      </Button>
                    ) : null
                  }
                >
                  {!businessDate ? (
                    <EmptyState
                      title="Business date required"
                      detail="Choose a date to load section membership and assignments."
                    />
                  ) : sectionsQuery.isLoading ? (
                    <div role="status" aria-label="Loading server sections" className="space-y-3">
                      {[0, 1].map((row) => (
                        <Skeleton key={row} className="h-28 w-full" />
                      ))}
                    </div>
                  ) : sectionsQuery.data?.length ? (
                    <div className="space-y-3">
                      {sectionsQuery.data.map((section) => (
                        <section
                          key={section.id}
                          className="rounded-md border border-border-subtle p-4"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <h3 className="font-semibold text-text-strong">{section.name}</h3>
                                <StatusPill status={section.active ? 'Active' : 'Inactive'} />
                              </div>
                              <p className="mt-1 text-xs text-text-muted">
                                {section.tables.length} table
                                {section.tables.length === 1 ? '' : 's'} ·{' '}
                                {section.assignments.length} server
                                {section.assignments.length === 1 ? '' : 's'}
                              </p>
                            </div>
                            {canManage ? (
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => openEditor({ kind: 'membership', section })}
                                >
                                  Tables
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    openEditor({ kind: 'assignment', sectionId: section.id })
                                  }
                                >
                                  Assign
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => openEditor({ kind: 'section', item: section })}
                                >
                                  Edit
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => confirmDeleteSection(section)}
                                >
                                  Delete
                                </Button>
                              </div>
                            ) : null}
                          </div>
                          <p className="mt-3 text-sm text-text-muted">
                            Tables: {section.tables.map((table) => table.code).join(', ') || 'None'}
                          </p>
                          <div className="mt-3 space-y-2">
                            {section.assignments.map((assignment) => (
                              <div
                                key={assignment.id}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-sunken px-3 py-2"
                              >
                                <div>
                                  <span className="mr-2 text-sm font-medium text-text-strong">
                                    {assignment.staffDisplayName}
                                  </span>
                                  <StatusPill status={assignment.staffStatus} />
                                </div>
                                {canManage ? (
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => confirmUnassign(section, assignment)}
                                  >
                                    Unassign
                                  </Button>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      title="No sections found"
                      detail="Add a server section for this branch."
                    />
                  )}
                </SectionCard>

                <SectionCard
                  eyebrow="Kitchen routing"
                  title="Stations"
                  actions={
                    canManage ? (
                      <Button size="sm" onClick={() => openEditor({ kind: 'station' })}>
                        Add station
                      </Button>
                    ) : null
                  }
                >
                  {stationsQuery.data?.length ? (
                    <div className="space-y-3">
                      {stationsQuery.data.map((station) => (
                        <section
                          key={station.id}
                          className="rounded-md border border-border-subtle p-4"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <h3 className="font-semibold text-text-strong">{station.name}</h3>
                                <StatusPill
                                  status={
                                    station.isDefault
                                      ? 'Default'
                                      : station.active
                                        ? 'Active'
                                        : 'Inactive'
                                  }
                                  tone={
                                    station.isDefault
                                      ? 'info'
                                      : station.active
                                        ? 'success'
                                        : 'neutral'
                                  }
                                />
                              </div>
                            </div>
                            {canManage ? (
                              <div className="flex flex-wrap gap-2">
                                {!station.isDefault && station.active ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      confirm({
                                        title: `Make ${station.name} default?`,
                                        description:
                                          'This station becomes the branch routing fallback.',
                                        label: 'Set default',
                                        run: () => setDefaultStation.mutate({ id: station.id }),
                                      })
                                    }
                                  >
                                    Make default
                                  </Button>
                                ) : null}
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    openEditor({ kind: 'routing', stationId: station.id })
                                  }
                                >
                                  Add rule
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => openEditor({ kind: 'station', item: station })}
                                >
                                  Edit
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => confirmDeleteStation(station)}
                                >
                                  Delete
                                </Button>
                              </div>
                            ) : null}
                          </div>
                          {station.routingRules.length ? (
                            <div className="mt-3 space-y-2">
                              {station.routingRules.map((rule) => (
                                <div
                                  key={rule.id}
                                  className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-2"
                                >
                                  <p className="text-sm text-text-strong">
                                    {rule.productName
                                      ? `Product: ${rule.productName}`
                                      : rule.categoryName
                                        ? `Category: ${rule.categoryName}`
                                        : `Course: ${rule.course}`}{' '}
                                    <span className="text-text-muted">
                                      · priority {rule.priority}
                                    </span>
                                  </p>
                                  {canManage ? (
                                    <div className="flex gap-2">
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                          openEditor({
                                            kind: 'routing',
                                            stationId: station.id,
                                            item: rule,
                                          })
                                        }
                                      >
                                        Edit
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="destructive"
                                        onClick={() => confirmDeleteRule(rule)}
                                      >
                                        Delete
                                      </Button>
                                    </div>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-3 text-sm text-text-muted">
                              No explicit routing rules.
                            </p>
                          )}
                        </section>
                      ))}
                    </div>
                  ) : (
                    <EmptyState title="No stations found" detail="Add the first kitchen station." />
                  )}
                </SectionCard>
              </div>
            </>
          )}
        </>
      )}

      <Dialog
        open={editor != null}
        onOpenChange={(open) => {
          if (!open && !busy) setEditor(null);
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
          {editor ? (
            <form className="space-y-4" onSubmit={submitEditor}>
              <DialogHeader>
                <DialogTitle>{editorTitle(editor)}</DialogTitle>
                <DialogDescription>
                  Changes use the capability-gated restaurant floor procedures.
                </DialogDescription>
              </DialogHeader>

              {editor.kind === 'floor' ? (
                <>
                  <Field label="Floor name">
                    <Input
                      name="name"
                      required
                      maxLength={120}
                      defaultValue={editor.item?.name}
                      className="h-11"
                    />
                  </Field>
                  <Field label="Sort order">
                    <Input
                      name="sortOrder"
                      type="number"
                      defaultValue={editor.item?.sortOrder ?? 0}
                      className="h-11"
                    />
                  </Field>
                  {editor.item ? (
                    <label className="flex min-h-11 items-center gap-2 rounded-md border border-border-default px-3 text-sm">
                      <input name="active" type="checkbox" defaultChecked={editor.item.active} />{' '}
                      Active
                    </label>
                  ) : null}
                </>
              ) : null}

              {editor.kind === 'table' ? (
                <>
                  <Field label="Table code">
                    <Input
                      name="code"
                      required
                      maxLength={40}
                      defaultValue={editor.item?.code}
                      className="h-11"
                    />
                  </Field>
                  <Field label="Capacity">
                    <Input
                      name="capacity"
                      type="number"
                      required
                      min={1}
                      max={100}
                      defaultValue={editor.item?.capacity ?? 2}
                      className="h-11"
                    />
                  </Field>
                  {editor.item ? (
                    <label className="flex min-h-11 items-center gap-2 rounded-md border border-border-default px-3 text-sm">
                      <input name="active" type="checkbox" defaultChecked={editor.item.active} />{' '}
                      Active
                    </label>
                  ) : null}
                </>
              ) : null}

              {editor.kind === 'section' ? (
                <>
                  <Field label="Section name">
                    <Input
                      name="name"
                      required
                      maxLength={120}
                      defaultValue={editor.item?.name}
                      className="h-11"
                    />
                  </Field>
                  {editor.item ? (
                    <label className="flex min-h-11 items-center gap-2 rounded-md border border-border-default px-3 text-sm">
                      <input name="active" type="checkbox" defaultChecked={editor.item.active} />{' '}
                      Active
                    </label>
                  ) : null}
                </>
              ) : null}

              {editor.kind === 'membership' ? (
                <fieldset className="space-y-2">
                  <legend className={labelClass}>Tables in {editor.section.name}</legend>
                  {allTables.map((table) => (
                    <label
                      key={table.id}
                      className="flex min-h-11 items-center gap-3 rounded-md border border-border-default px-3 text-sm"
                    >
                      <input
                        name="tableIds"
                        type="checkbox"
                        value={table.id}
                        defaultChecked={editor.section.tables.some(
                          (member) => member.id === table.id
                        )}
                      />
                      Table {table.code}
                    </label>
                  ))}
                  {allTables.length === 0 ? (
                    <p className="text-sm text-text-muted">No tables available.</p>
                  ) : null}
                </fieldset>
              ) : null}

              {editor.kind === 'assignment' ? (
                <>
                  <Field label="Staff member">
                    <RestaurantStaffSelect
                      name="staffProfileId"
                      required
                      staff={staffQuery.data ?? []}
                      loading={staffQuery.isLoading}
                      error={Boolean(staffQuery.error)}
                    />
                  </Field>
                  <Field label="Business date">
                    <Input
                      name="businessDate"
                      type="date"
                      required
                      defaultValue={businessDate}
                      className="h-11"
                    />
                  </Field>
                </>
              ) : null}

              {editor.kind === 'station' ? (
                <>
                  <Field label="Station name">
                    <Input
                      name="name"
                      required
                      maxLength={120}
                      defaultValue={editor.item?.name}
                      className="h-11"
                    />
                  </Field>
                  {editor.item ? (
                    <label className="flex min-h-11 items-center gap-2 rounded-md border border-border-default px-3 text-sm">
                      <input name="active" type="checkbox" defaultChecked={editor.item.active} />{' '}
                      Active
                    </label>
                  ) : (
                    <label className="flex min-h-11 items-center gap-2 rounded-md border border-border-default px-3 text-sm">
                      <input name="isDefault" type="checkbox" /> Set as branch default
                    </label>
                  )}
                </>
              ) : null}

              {editor.kind === 'routing' ? (
                <>
                  {!editor.item ? (
                    <>
                      <Field label="Target type">
                        <select
                          name="targetType"
                          className={selectClass}
                          value={routingTargetType}
                          onChange={(event) =>
                            setRoutingTargetType(
                              event.target.value as 'product' | 'category' | 'course'
                            )
                          }
                        >
                          <option value="product">Product</option>
                          <option value="category">Category</option>
                          <option value="course">Course</option>
                        </select>
                      </Field>
                      {routingTargetType === 'course' ? (
                        <Field label="Course number">
                          <Input
                            name="course"
                            type="number"
                            required
                            min={1}
                            defaultValue={1}
                            className="h-11"
                          />
                        </Field>
                      ) : (
                        <div className="space-y-1.5">
                          <label htmlFor="routing-target" className={labelClass}>
                            {routingTargetType === 'product' ? 'Product' : 'Category'}
                          </label>
                          <Input
                            type="search"
                            aria-label={`Search ${routingTargetType === 'product' ? 'products' : 'categories'}`}
                            value={routingTargetSearch}
                            onChange={(event) => setRoutingTargetSearch(event.target.value)}
                            placeholder={`Search ${routingTargetType === 'product' ? 'products' : 'categories'}`}
                            className="mb-2 h-11"
                          />
                          <select
                            id="routing-target"
                            name="targetId"
                            required
                            className={selectClass}
                            disabled={
                              routingTargetType === 'product'
                                ? productsQuery.isLoading || Boolean(productsQuery.error)
                                : categoriesQuery.isLoading || Boolean(categoriesQuery.error)
                            }
                          >
                            <option value="">
                              {(
                                routingTargetType === 'product'
                                  ? productsQuery.isLoading
                                  : categoriesQuery.isLoading
                              )
                                ? 'Loading catalog…'
                                : (
                                      routingTargetType === 'product'
                                        ? productsQuery.error
                                        : categoriesQuery.error
                                    )
                                  ? 'Catalog unavailable for your access'
                                  : `Choose a ${routingTargetType}`}
                            </option>
                            {(routingTargetType === 'product'
                              ? (productsQuery.data ?? []).map((item) => ({
                                  id: item.id,
                                  label: item.name,
                                }))
                              : (categoriesQuery.data ?? []).map((item) => ({
                                  id: item.id,
                                  label: item.name,
                                }))
                            )
                              .filter((item) =>
                                item.label
                                  .toLowerCase()
                                  .includes(routingTargetSearch.trim().toLowerCase())
                              )
                              .map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.label}
                                </option>
                              ))}
                          </select>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="rounded-md bg-surface-sunken p-3 text-sm text-text-muted">
                      Rule target is fixed. Delete and recreate the rule to change it.
                    </p>
                  )}
                  <Field label="Priority">
                    <Input
                      name="priority"
                      type="number"
                      defaultValue={editor.item?.priority ?? 0}
                      className="h-11"
                    />
                  </Field>
                </>
              ) : null}

              {mutationError ? (
                <p
                  role="alert"
                  className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
                >
                  {mutationError}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => setEditor(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" className="min-h-11" disabled={busy}>
                  {busy ? 'Saving…' : editorTitle(editor)}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmation != null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{confirmation?.title}</DialogTitle>
            <DialogDescription>{confirmation?.description}</DialogDescription>
          </DialogHeader>
          {mutationError ? (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {mutationError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={confirmation?.destructive ? 'destructive' : 'default'}
              className="min-h-11"
              disabled={busy}
              onClick={() => confirmation?.run()}
            >
              {busy ? 'Working…' : confirmation?.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
