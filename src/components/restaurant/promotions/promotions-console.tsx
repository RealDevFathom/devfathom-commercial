'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import type { inferRouterOutputs } from '@trpc/server';
import { Plus, RefreshCw } from 'lucide-react';
import { useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';

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
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type Outputs = inferRouterOutputs<AppRouter>;
type Offer = Outputs['restaurantPromotions']['list'][number];
type PickerOptions = Outputs['restaurantPromotions']['pickerOptions'];
type BenefitKind = NonNullable<Offer['latestVersion']>['benefitKind'];
type Editor = { offer: Offer | null };

const selectClass =
  'min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 py-2 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';
const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';

function Field({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <label className="space-y-1.5">
      <span className={labelClass}>{label}</span>
      {children}
      {detail ? (
        <span className="block text-xs leading-relaxed text-text-muted">{detail}</span>
      ) : null}
    </label>
  );
}

function errorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('data' in error)) return undefined;
  return (error as { data?: { code?: string } }).data?.code;
}

function value(data: FormData, name: string) {
  return String(data.get(name) ?? '').trim();
}

function nullableNumber(data: FormData, name: string) {
  const raw = value(data, name);
  return raw ? Number(raw) : null;
}

type SelectionName =
  | 'targetProductIds'
  | 'targetVariantIds'
  | 'targetCategoryIds'
  | 'allowedBranchIds'
  | 'allowedChannels';
type BundleRow = { key: number; productIds: string[]; categoryIds: string[]; quantity: string };

// DEV-1001 native exceptions: seven multi-select listboxes preserve selectedOptions,
// modifier-key selection and ordered bundles. Migrate with equivalent multi-select UX.
function selectedIds(select: HTMLSelectElement) {
  return Array.from(select.selectedOptions, (option) => option.value);
}

// Keep stored order and multiplicity for surviving selections; append only new IDs.
function orderedSelection(previous: string[], selected: string[]) {
  const membership = new Set(selected);
  const existing = new Set(previous);
  return [
    ...previous.filter((id) => membership.has(id)),
    ...selected.filter((id) => !existing.has(id)),
  ];
}

function dateInput(date: Date | string | null | undefined) {
  return date ? new Date(date).toISOString().slice(0, 16) : '';
}

// datetime-local has no zone; this editor explicitly displays and parses UTC.
function dateValue(input: string, original: Date | string | null | undefined) {
  if (original && input === dateInput(original)) return new Date(original);
  return new Date(input + 'Z');
}

function unavailableSelections(offer: Offer, options: PickerOptions | undefined) {
  const version = offer.latestVersion;
  if (!version || !options) return true;
  const products = new Set(options.products.map((item) => item.id));
  const variants = new Set(options.products.flatMap((item) => item.variants.map((v) => v.id)));
  const categories = new Set(options.categories.map((item) => item.id));
  const branches = new Set(options.branches.map((item) => item.id));
  return (
    version.targetProductIds.some((id) => !products.has(id)) ||
    version.targetVariantIds.some((id) => !variants.has(id)) ||
    version.targetCategoryIds.some((id) => !categories.has(id)) ||
    version.allowedBranchIds.some((id) => !branches.has(id)) ||
    version.components.some(
      (component) =>
        component.productIds.some((id) => !products.has(id)) ||
        component.categoryIds.some((id) => !categories.has(id))
    )
  );
}

function offerBenefit(offer: Offer) {
  const version = offer.latestVersion;
  if (!version) return 'No draft';
  if (version.benefitBasisPoints != null) return `${version.benefitBasisPoints / 100}%`;
  if (version.benefitAmount != null) return `${version.currency} ${version.benefitAmount}`;
  return version.benefitKind.replaceAll('_', ' ').toLowerCase();
}

function ConsoleLoading() {
  return (
    <div role="status" aria-label="Loading offers" className="space-y-5">
      <SectionCard title="Loading offer registry…">
        <div className="space-y-3">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-14 w-full motion-reduce:animate-none" />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

function StatePanel({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <SectionCard>
      <div className="py-8 text-center">
        <p className="font-display text-lg font-semibold text-text-strong">{title}</p>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-text-muted">{detail}</p>
        {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
      </div>
    </SectionCard>
  );
}

function OfferEditor({
  editor,
  options,
  onClose,
  onSaved,
}: {
  editor: Editor;
  options: PickerOptions;
  onClose: () => void;
  onSaved: () => void;
}) {
  const version = editor.offer?.latestVersion;
  const [benefitKind, setBenefitKind] = useState<BenefitKind>(
    version?.benefitKind ?? 'PERCENT_OFF'
  );
  const [targetKind, setTargetKind] = useState(version?.targetKind ?? 'ORDER');
  const [selections, setSelections] = useState<Record<SelectionName, string[]>>(() => ({
    targetProductIds: [...(version?.targetProductIds ?? [])],
    targetVariantIds: [...(version?.targetVariantIds ?? [])],
    targetCategoryIds: [...(version?.targetCategoryIds ?? [])],
    allowedBranchIds: [...(version?.allowedBranchIds ?? [])],
    allowedChannels: [...(version?.allowedChannels ?? [])],
  }));
  const [bundleRows, setBundleRows] = useState<BundleRow[]>(() =>
    (version?.components.length
      ? version.components
      : [{ productIds: [], categoryIds: [], quantity: 1 }]
    ).map((component, key) => ({
      key,
      productIds: [...component.productIds],
      categoryIds: [...component.categoryIds],
      quantity: String(component.quantity),
    }))
  );
  const nextRowKey = useRef(bundleRows.length);
  const [formError, setFormError] = useState('');
  const create = trpc.restaurantPromotions.createOffer.useMutation();
  const edit = trpc.restaurantPromotions.editOffer.useMutation();
  const pending = create.isPending || edit.isPending;
  const selectionProps = (name: SelectionName) => ({
    value: selections[name],
    onChange: (event: ChangeEvent<HTMLSelectElement>) => {
      const selected = selectedIds(event.currentTarget);
      setSelections((previous) => ({
        ...previous,
        [name]: orderedSelection(previous[name], selected),
      }));
    },
  });
  const changeTarget = (next: typeof targetKind) => {
    if (next === targetKind) return;
    setTargetKind(next);
    setSelections((previous) => ({
      ...previous,
      targetProductIds: next === 'ITEM' ? previous.targetProductIds : [],
      targetVariantIds: next === 'ITEM' ? previous.targetVariantIds : [],
      targetCategoryIds: next === 'CATEGORY' ? previous.targetCategoryIds : [],
    }));
  };
  const selectAlternatives = (
    key: number,
    field: 'productIds' | 'categoryIds',
    selected: string[]
  ) =>
    setBundleRows((rows) =>
      rows.map((row) =>
        row.key === key ? { ...row, [field]: orderedSelection(row[field], selected) } : row
      )
    );
  const addRow = () => {
    const row: BundleRow = {
      key: nextRowKey.current++,
      productIds: [],
      categoryIds: [],
      quantity: '1',
    };
    setBundleRows((rows) => (rows.length < 20 ? [...rows, row] : rows));
  };
  const moveRow = (key: number, direction: -1 | 1) =>
    setBundleRows((rows) => {
      const from = rows.findIndex((row) => row.key === key);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= rows.length) return rows;
      const next = [...rows];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  const amountBenefit = [
    'AMOUNT_OFF',
    'FIXED_PRICE',
    'BUY_X_GET_Y_AMOUNT',
    'BUNDLE_PRICE',
  ].includes(benefitKind);
  const buyGet = benefitKind.startsWith('BUY_X_GET_Y');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const components = bundleRows.map((row) => ({
      productIds: [...row.productIds],
      categoryIds: [...row.categoryIds],
      quantity: Number(row.quantity),
    }));
    if (
      benefitKind === 'BUNDLE_PRICE' &&
      (components.length < 1 ||
        components.length > 20 ||
        components.some(
          (component) =>
            !Number.isInteger(component.quantity) ||
            component.quantity <= 0 ||
            component.productIds.length + component.categoryIds.length === 0
        ))
    ) {
      setFormError(
        'Add 1–20 bundle components. Each needs product or category alternatives and a positive whole-number quantity.'
      );
      return;
    }
    setFormError('');
    const rule = {
      effectiveFrom: dateValue(value(data, 'effectiveFrom'), version?.effectiveFrom),
      effectiveTo: value(data, 'effectiveTo')
        ? dateValue(value(data, 'effectiveTo'), version?.effectiveTo)
        : null,
      timezone: value(data, 'timezone'),
      dayMask: version?.dayMask ?? 127,
      startMinute: version?.startMinute ?? null,
      endMinute: version?.endMinute ?? null,
      targetKind,
      targetProductIds: selections.targetProductIds,
      targetVariantIds: selections.targetVariantIds,
      targetCategoryIds: selections.targetCategoryIds,
      includeDescendants: version?.includeDescendants ?? false,
      componentTargeting: version?.componentTargeting ?? false,
      allowedBranchIds: selections.allowedBranchIds,
      allowedChannels: selections.allowedChannels as Array<'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'>,
      benefitKind,
      benefitBasisPoints: benefitKind.includes('PERCENT')
        ? Math.round(Number(value(data, 'percentage')) * 100)
        : null,
      benefitAmount: amountBenefit ? value(data, 'benefitAmount') : null,
      buyQuantity: buyGet ? nullableNumber(data, 'buyQuantity') : null,
      getQuantity: buyGet ? nullableNumber(data, 'getQuantity') : null,
      applicationBasis: value(data, 'applicationBasis') as 'LINE' | 'UNIT' | 'ORDER',
      currency: value(data, 'currency'),
      minimumQuantity: nullableNumber(data, 'minimumQuantity'),
      minimumAmount: value(data, 'minimumAmount') || null,
      maxBenefitAmount: version?.maxBenefitAmount ?? null,
      components: benefitKind === 'BUNDLE_PRICE' ? components : [],
      priority: version?.priority ?? 0,
      stackingGroup: version?.stackingGroup ?? '',
      stackingMode: version?.stackingMode ?? 'STACKABLE',
      stopFurtherProcessing: version?.stopFurtherProcessing ?? false,
      maxApplicationsPerOrder: version?.maxApplicationsPerOrder ?? null,
      perOrderCap: version?.perOrderCap ?? null,
      offlinePolicy: value(data, 'offlinePolicy') as 'ALLOW' | 'ONLINE_ONLY',
    };
    const done = () => {
      toast.success(editor.offer ? 'Offer updated.' : 'Offer created.');
      onSaved();
    };
    const fail = (error: { message: string }) => setFormError(error.message);
    if (editor.offer)
      edit.mutate(
        {
          promotionId: editor.offer.id,
          expectedVersionId: version!.id,
          expectedRuleHash: version!.ruleHash,
          expectedUpdatedAt: new Date(version!.updatedAt),
          name: value(data, 'name'),
          rule,
        },
        { onSuccess: done, onError: fail }
      );
    else
      create.mutate(
        { code: value(data, 'code').toUpperCase(), name: value(data, 'name'), rule },
        { onSuccess: done, onError: fail }
      );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editor.offer ? 'Edit offer draft' : 'Create offer'}</DialogTitle>
          <DialogDescription>
            Choose operational records by name. Stored identifiers come only from these workspace
            pickers.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <fieldset disabled={pending} className="min-w-0 space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Offer name">
                <Input
                  className="h-11"
                  name="name"
                  required
                  defaultValue={editor.offer?.name ?? ''}
                />
              </Field>
              <Field label="Offer code" detail="Stable after creation.">
                <Input
                  className="h-11 uppercase"
                  name="code"
                  required
                  disabled={Boolean(editor.offer)}
                  defaultValue={editor.offer?.code ?? ''}
                  pattern="[A-Za-z0-9_-]+"
                />
              </Field>
              <Field label="Starts (UTC)">
                <Input
                  className="h-11"
                  type="datetime-local"
                  name="effectiveFrom"
                  required
                  defaultValue={dateInput(version?.effectiveFrom) || dateInput(new Date())}
                />
              </Field>
              <Field label="Ends (UTC)" detail="Leave empty for an ongoing offer.">
                <Input
                  className="h-11"
                  type="datetime-local"
                  name="effectiveTo"
                  defaultValue={dateInput(version?.effectiveTo)}
                />
              </Field>
              <Field label="Timezone">
                <StudioSelect
                  className={selectClass}
                  name="timezone"
                  required
                  defaultValue={version?.timezone ?? options.branches[0]?.timezone ?? 'UTC'}
                >
                  {[
                    ...new Set([
                      'UTC',
                      ...(version?.timezone ? [version.timezone] : []),
                      ...options.branches.map((branch) => branch.timezone),
                    ]),
                  ].map((timezone) => (
                    <option key={timezone}>{timezone}</option>
                  ))}
                </StudioSelect>
              </Field>
              <Field label="Currency">
                <Input
                  className="h-11 uppercase"
                  name="currency"
                  maxLength={3}
                  required
                  defaultValue={version?.currency ?? 'PKR'}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Benefit type">
                <StudioSelect
                  className={selectClass}
                  name="benefitKind"
                  value={benefitKind}
                  onChange={(event) => setBenefitKind(event.target.value as BenefitKind)}
                >
                  {[
                    'PERCENT_OFF',
                    'AMOUNT_OFF',
                    'FIXED_PRICE',
                    'BUY_X_GET_Y_PERCENT',
                    'BUY_X_GET_Y_AMOUNT',
                    'BUY_X_GET_Y_FREE',
                    'BUNDLE_PRICE',
                  ].map((kind) => (
                    <option key={kind} value={kind}>
                      {kind.replaceAll('_', ' ')}
                    </option>
                  ))}
                </StudioSelect>
              </Field>
              <Field label="Application basis">
                <StudioSelect
                  className={selectClass}
                  name="applicationBasis"
                  defaultValue={version?.applicationBasis ?? 'ORDER'}
                >
                  <option value="ORDER">Order</option>
                  <option value="LINE">Line</option>
                  <option value="UNIT">Unit</option>
                </StudioSelect>
              </Field>
              {benefitKind.includes('PERCENT') ? (
                <Field label="Percentage">
                  <Input
                    className="h-11"
                    name="percentage"
                    type="number"
                    min="0.01"
                    max="100"
                    step="0.01"
                    required
                    defaultValue={
                      version?.benefitBasisPoints ? version.benefitBasisPoints / 100 : 10
                    }
                  />
                </Field>
              ) : null}
              {amountBenefit ? (
                <Field label="Benefit amount">
                  <Input
                    className="h-11"
                    name="benefitAmount"
                    inputMode="decimal"
                    pattern="\d+(\.\d{1,2})?"
                    required
                    defaultValue={version?.benefitAmount ?? ''}
                  />
                </Field>
              ) : null}
              {buyGet ? (
                <>
                  <Field label="Buy quantity">
                    <Input
                      className="h-11"
                      name="buyQuantity"
                      type="number"
                      min="1"
                      required
                      defaultValue={version?.buyQuantity ?? 2}
                    />
                  </Field>
                  <Field label="Get quantity">
                    <Input
                      className="h-11"
                      name="getQuantity"
                      type="number"
                      min="1"
                      required
                      defaultValue={version?.getQuantity ?? 1}
                    />
                  </Field>
                </>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Target type">
                <StudioSelect
                  className={selectClass}
                  value={targetKind}
                  onChange={(event) => changeTarget(event.target.value as typeof targetKind)}
                >
                  <option value="ORDER">Whole order</option>
                  <option value="ITEM">Selected items</option>
                  <option value="CATEGORY">Selected categories</option>
                </StudioSelect>
              </Field>
              <Field label="Branches" detail="No selection means every branch.">
                <select
                  className={selectClass}
                  name="allowedBranchIds"
                  multiple
                  {...selectionProps('allowedBranchIds')}
                >
                  {options.branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </Field>
              {targetKind === 'ITEM' ? (
                <>
                  <Field label="Products">
                    <select
                      className={selectClass}
                      name="targetProductIds"
                      multiple
                      {...selectionProps('targetProductIds')}
                    >
                      {options.products.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Variants">
                    <select
                      className={selectClass}
                      name="targetVariantIds"
                      multiple
                      {...selectionProps('targetVariantIds')}
                    >
                      {options.products.flatMap((product) =>
                        product.variants.map((variant) => (
                          <option key={variant.id} value={variant.id}>
                            {product.name} · {variant.name}
                          </option>
                        ))
                      )}
                    </select>
                  </Field>
                </>
              ) : null}
              {targetKind === 'CATEGORY' ? (
                <Field label="Categories">
                  <select
                    className={selectClass}
                    name="targetCategoryIds"
                    multiple
                    {...selectionProps('targetCategoryIds')}
                  >
                    {options.categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              <Field label="Channels">
                <select
                  className={selectClass}
                  name="allowedChannels"
                  multiple
                  {...selectionProps('allowedChannels')}
                >
                  <option value="DINE_IN">Dine in</option>
                  <option value="TAKEAWAY">Takeaway</option>
                  <option value="DELIVERY">Delivery</option>
                </select>
              </Field>
              <Field label="Offline policy">
                <StudioSelect
                  className={selectClass}
                  name="offlinePolicy"
                  defaultValue={version?.offlinePolicy ?? 'ALLOW'}
                >
                  <option value="ALLOW">Available offline</option>
                  <option value="ONLINE_ONLY">Online only</option>
                </StudioSelect>
              </Field>
              <Field label="Minimum quantity">
                <Input
                  className="h-11"
                  name="minimumQuantity"
                  type="number"
                  min="1"
                  defaultValue={version?.minimumQuantity ?? ''}
                />
              </Field>
              <Field label="Minimum amount">
                <Input
                  className="h-11"
                  name="minimumAmount"
                  inputMode="decimal"
                  pattern="\d+(\.\d{1,2})?"
                  defaultValue={version?.minimumAmount ?? ''}
                />
              </Field>
              {benefitKind === 'BUNDLE_PRICE' ? (
                <div className="min-w-0 space-y-4 sm:col-span-2">
                  <p className="text-sm text-text-muted">
                    Each quantity can be satisfied by any selected product or category. Components
                    are matched in the order shown.
                  </p>
                  {bundleRows.map((row, index) => (
                    <fieldset
                      key={row.key}
                      className="min-w-0 space-y-4 rounded-[var(--radius-md)] border border-border-default p-4"
                    >
                      <legend className={labelClass}>Bundle component {index + 1}</legend>
                      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                        <Field label="Product alternatives">
                          <select
                            className={selectClass}
                            multiple
                            value={row.productIds}
                            onChange={(event) =>
                              selectAlternatives(
                                row.key,
                                'productIds',
                                selectedIds(event.currentTarget)
                              )
                            }
                          >
                            {options.products.map((product) => (
                              <option key={product.id} value={product.id}>
                                {product.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Category alternatives">
                          <select
                            className={selectClass}
                            multiple
                            value={row.categoryIds}
                            onChange={(event) =>
                              selectAlternatives(
                                row.key,
                                'categoryIds',
                                selectedIds(event.currentTarget)
                              )
                            }
                          >
                            {options.categories.map((category) => (
                              <option key={category.id} value={category.id}>
                                {category.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Required quantity">
                          <Input
                            className="h-11"
                            type="number"
                            min="1"
                            step="1"
                            required
                            value={row.quantity}
                            onChange={(event) => {
                              const quantity = event.currentTarget.value;
                              setBundleRows((rows) =>
                                rows.map((item) =>
                                  item.key === row.key ? { ...item, quantity } : item
                                )
                              );
                            }}
                          />
                        </Field>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={index === 0}
                          aria-label={`Move component ${index + 1} up`}
                          onClick={() => moveRow(row.key, -1)}
                        >
                          Move up
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={index === bundleRows.length - 1}
                          aria-label={`Move component ${index + 1} down`}
                          onClick={() => moveRow(row.key, 1)}
                        >
                          Move down
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          aria-label={`Remove component ${index + 1}`}
                          onClick={() =>
                            setBundleRows((rows) => rows.filter((item) => item.key !== row.key))
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    </fieldset>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={bundleRows.length >= 20}
                    onClick={addRow}
                  >
                    Add component
                  </Button>
                  <p className="text-xs text-text-muted">{bundleRows.length} of 20 components</p>
                </div>
              ) : null}
            </div>
            {formError ? (
              <p
                role="alert"
                className="rounded-[var(--radius-sm)] bg-destructive/10 px-4 py-3 text-sm text-destructive"
              >
                {formError}
              </p>
            ) : null}
            <DialogFooter className="mx-0 mb-0">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? 'Saving…' : editor.offer ? 'Save changes' : 'Create offer'}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PromotionsConsole() {
  const utils = trpc.useUtils();
  const offersQuery = trpc.restaurantPromotions.list.useQuery();
  const optionsQuery = trpc.restaurantPromotions.pickerOptions.useQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [disableOffer, setDisableOffer] = useState<Offer | null>(null);
  const [disableError, setDisableError] = useState('');
  const [disableReason, setDisableReason] = useState('');
  const disable = trpc.restaurantPromotions.disableOffer.useMutation({
    onError: (error) => setDisableError(error.message),
    onSuccess: async () => {
      toast.success('Offer disabled.');
      setDisableOffer(null);
      await utils.restaurantPromotions.list.invalidate();
    },
  });
  const offers = offersQuery.data ?? [];
  const selected = offers.find((offer) => offer.id === selectedId) ?? offers[0] ?? null;
  const forbidden =
    errorCode(offersQuery.error) === 'FORBIDDEN' ||
    errorCode(optionsQuery.error) === 'FORBIDDEN' ||
    errorCode(offersQuery.error) === 'UNAUTHORIZED' ||
    errorCode(optionsQuery.error) === 'UNAUTHORIZED';
  const canAuthor =
    Boolean(optionsQuery.data) &&
    !forbidden &&
    !offersQuery.isLoading &&
    !optionsQuery.isLoading &&
    !offersQuery.isError &&
    !optionsQuery.isError;
  const reload = () => {
    void offersQuery.refetch();
    void optionsQuery.refetch();
  };
  const saved = async () => {
    setEditor(null);
    await utils.restaurantPromotions.list.invalidate();
  };

  return (
    <>
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Offers"
        description="Compose, review, and disable checkout promotions from named catalog and branch records."
        actions={
          <Button size="lg" onClick={() => setEditor({ offer: null })} disabled={!canAuthor}>
            <Plus />
            Create offer
          </Button>
        }
      />
      {offersQuery.isLoading || optionsQuery.isLoading ? (
        <ConsoleLoading />
      ) : forbidden ? (
        <StatePanel
          title="Offer management is restricted"
          detail="Your current role does not have the restaurant configuration capability. No offer data was exposed."
        />
      ) : offersQuery.isError || optionsQuery.isError ? (
        <StatePanel
          title="Offers could not be loaded"
          detail="No changes were made. Retry after checking your connection."
          action={
            <Button variant="outline" onClick={reload}>
              <RefreshCw />
              Retry
            </Button>
          }
        />
      ) : offers.length === 0 ? (
        <StatePanel
          title="No offers yet"
          detail="Create the first offer using branch, item, and category pickers from this workspace."
          action={
            <Button onClick={() => setEditor({ offer: null })}>
              <Plus />
              Create offer
            </Button>
          }
        />
      ) : (
        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.55fr)]">
          <SectionCard eyebrow={`${offers.length} total`} title="Offer registry">
            <div
              role="region"
              aria-label="Offer registry"
              tabIndex={0}
              className="overflow-x-auto rounded-[var(--radius-sm)] border border-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_[data-slot=table-container]]:overflow-visible"
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Offer</TableHead>
                    <TableHead>Benefit</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {offers.map((offer) => (
                    <TableRow
                      key={offer.id}
                      data-state={selected?.id === offer.id ? 'selected' : undefined}
                    >
                      <TableCell>
                        <button
                          className="min-h-11 text-left font-semibold text-text-strong outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-pressed={selected?.id === offer.id}
                          onClick={() => setSelectedId(offer.id)}
                        >
                          {offer.name}
                          <span className="block font-mono text-[0.6875rem] font-normal text-text-muted">
                            {offer.code}
                          </span>
                        </button>
                      </TableCell>
                      <TableCell className="tabular-nums">{offerBenefit(offer)}</TableCell>
                      <TableCell>
                        <StatusPill
                          status={offer.status}
                          tone={offer.status === 'ACTIVE' ? 'success' : 'neutral'}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" onClick={() => setSelectedId(offer.id)}>
                          Review
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </SectionCard>
          <SectionCard eyebrow="Selected offer" title={selected?.name ?? 'Offer detail'}>
            {selected ? (
              <div className="space-y-5">
                <div className="space-y-2 text-sm">
                  <p>
                    <span className="text-text-muted">Code</span>
                    <span className="float-right font-mono text-text-strong">{selected.code}</span>
                  </p>
                  <p>
                    <span className="text-text-muted">Target</span>
                    <span className="float-right text-text-strong">
                      {selected.latestVersion?.targetKind ?? '—'}
                    </span>
                  </p>
                  <p>
                    <span className="text-text-muted">Offline</span>
                    <span className="float-right text-text-strong">
                      {selected.latestVersion?.offlinePolicy === 'ALLOW'
                        ? 'Available'
                        : 'Online only'}
                    </span>
                  </p>
                </div>
                {selected.editRestriction || unavailableSelections(selected, optionsQuery.data) ? (
                  <p className="text-sm text-text-muted">
                    {selected.editRestriction ??
                      'Some selected records are unavailable. This offer is read-only here.'}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={
                      !canAuthor ||
                      !selected.latestVersion ||
                      selected.latestVersion.status !== 'DRAFT' ||
                      selected.status !== 'ACTIVE' ||
                      Boolean(selected.editRestriction) ||
                      unavailableSelections(selected, optionsQuery.data)
                    }
                    onClick={() => setEditor({ offer: selected })}
                  >
                    Edit draft
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={selected.status !== 'ACTIVE'}
                    onClick={() => {
                      setDisableError('');
                      setDisableReason('');
                      setDisableOffer(selected);
                    }}
                  >
                    Disable offer
                  </Button>
                </div>
              </div>
            ) : null}
          </SectionCard>
        </div>
      )}
      {editor && optionsQuery.data && canAuthor ? (
        <OfferEditor
          key={editor.offer?.id ?? 'new'}
          editor={editor}
          options={optionsQuery.data}
          onClose={() => setEditor(null)}
          onSaved={saved}
        />
      ) : null}
      {disableOffer && canAuthor ? (
        <Dialog open onOpenChange={(open) => !open && setDisableOffer(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Disable {disableOffer.name}?</DialogTitle>
              <DialogDescription>
                Checkout will stop offering it. Existing snapshots and audit evidence remain intact.
              </DialogDescription>
            </DialogHeader>
            <Field label="Reason for disabling">
              <Input
                value={disableReason}
                onChange={(event) => setDisableReason(event.target.value)}
                minLength={3}
                maxLength={500}
              />
            </Field>
            {disableError ? (
              <p role="alert" className="text-sm text-destructive">
                {disableError}
              </p>
            ) : null}
            <DialogFooter showCloseButton>
              <Button
                variant="destructive"
                disabled={disable.isPending || disableReason.trim().length < 3}
                onClick={() =>
                  disable.mutate({
                    promotionId: disableOffer.id,
                    reason: disableReason.trim(),
                  })
                }
              >
                {disable.isPending ? 'Disabling…' : 'Disable offer'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
