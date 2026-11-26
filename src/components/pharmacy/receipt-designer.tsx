'use client';
import { useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select-field';
import { Textarea } from '@/components/ui/textarea';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import {
  receiptDesign,
  ReceiptDesignForSaveSchema,
  optionalSections,
  textBlocks,
  type ReceiptDesign,
  type PharmacyReceiptLayout,
} from '@/lib/pharmacy/receipt-layout';
import { receiptDesignSample } from '@/lib/pharmacy/receipt-design-sample';
import {
  buildCounterBrowserReceipt,
  counterFormatFromLayout,
  type PrinterTestFormat,
} from '@/lib/pharmacy/counter-browser-print';
import { layoutWithPaper } from '@/lib/pharmacy/receipt-layout';
import { ReceiptPaperPreview } from './receipt-paper-preview';

type Saved = {
  registeredName: string | null;
  layout: PharmacyReceiptLayout;
  revision: number;
  receiptLogoPng?: string;
};
const labels = {
  businessText: 'Business text',
  headerText: 'Header',
  footerText: 'Footer',
  brandingQr: 'Website QR',
  logo: 'Logo',
};
function Choice({
  label,
  value,
  children,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  children: ReactNode;
  onChange: (s: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <SelectField
        id={id}
        value={value}
        disabled={disabled}
        className="min-h-11 w-full rounded-control"
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </SelectField>
    </div>
  );
}
const papers = (
  <>
    <option value="THERMAL_58">58 mm roll</option>
    <option value="THERMAL">80 mm roll</option>
    <option value="A4">A4 sheet</option>
  </>
);
function Preview({
  layout,
  png,
  registeredName,
}: {
  layout: ReceiptDesign;
  png?: string;
  registeredName: string | null;
}) {
  const [paper, setPaper] = useState('saved');
  const format = (paper === 'saved' ? counterFormatFromLayout(layout) : paper) as PrinterTestFormat;
  const html = buildCounterBrowserReceipt(
    {
      ...receiptDesignSample,
      taxIdentity: {
        ...receiptDesignSample.taxIdentity!,
        registeredName: registeredName ?? undefined,
      },
      receiptLayout: layout,
      receiptLogoPng: png,
    },
    'en',
    format
  );
  return (
    <div className="space-y-4">
      <Choice label="Preview paper" value={paper} onChange={setPaper}>
        <option value="saved">Design paper</option>
        {papers}
      </Choice>
      <p className="text-sm text-text-muted">
        Sample sale. Legal identity, receipt number, items, totals, payments and copy marking are
        fixed.
      </p>
      {layout.logo && layout.sections.includes('logo') && format !== 'A4' && (
        <p className="text-sm text-text-muted">Logos print on A4 only</p>
      )}
      <ReceiptPaperPreview html={html} title="Sample receipt" format={format} />
    </div>
  );
}
function Editor({
  branchId,
  saved,
  canSave,
}: {
  branchId: string;
  saved: Saved;
  canSave: boolean;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState(() => receiptDesign(saved.layout));
  const [png, setPng] = useState(saved.receiptLogoPng);
  const [base, setBase] = useState(saved.revision);
  const [preview, setPreview] = useState('draft');
  const [notice, setNotice] = useState('');
  const upload = trpc.pharmacySales.counterUploadReceiptLogo.useMutation();
  const save = trpc.pharmacySales.counterSaveReceiptFormat.useMutation();
  const busy = save.isPending || upload.isPending;
  const disabled = busy || !canSave;
  const parsed = ReceiptDesignForSaveSchema.safeParse(draft);
  const dirty = JSON.stringify(receiptDesign(saved.layout)) !== JSON.stringify(draft);
  const conflict = base !== saved.revision;
  const patch = (values: Partial<ReceiptDesign>) => {
    setDraft((d) => ({ ...d, ...values }));
    setNotice('');
  };
  async function submit() {
    if (disabled || conflict || !parsed.success || !dirty) return;
    try {
      const next = await save.mutateAsync({ branchId, revision: base, layout: parsed.data });
      utils.pharmacySales.counterReceiptFormat.setData(
        { branchId },
        { ...next, registeredName: saved.registeredName, receiptLogoPng: png }
      );
      setBase(next.revision);
      setDraft(receiptDesign(next.layout));
      setNotice('Receipt design saved.');
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'data' in error &&
        (error.data as { code?: string })?.code === 'CONFLICT'
      ) {
        setNotice(
          'Another administrator saved changes. Your draft is still here. Review the saved design before saving again.'
        );
        await utils.pharmacySales.counterReceiptFormat.invalidate({ branchId });
      } else
        setNotice('Could not save the design. Check your connection or upload the logo again.');
    }
  }
  async function chooseLogo(file: File) {
    if (file.size > 1024 * 1024) {
      setNotice('Choose an image up to 1 MiB.');
      return;
    }
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(Error());
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.readAsDataURL(file);
      });
      const result = await upload.mutateAsync({
        branchId,
        contentType: file.type as 'image/png' | 'image/jpeg' | 'image/webp',
        dataBase64: data,
      });
      setPng(result.png);
      patch({ logo: { assetId: result.assetId, maxWidthMm: 32 } });
    } catch {
      setNotice('Upload failed. Choose a single PNG, JPEG or WebP up to 1 MiB and 4 megapixels.');
    }
  }
  const savedPreview = preview === 'saved';
  const errors = (id: string) =>
    parsed.success ? undefined : parsed.error.issues.find((i) => i.path[0] === id)?.message;
  return (
    <div className="grid min-w-0 gap-6 xl:grid-cols-2">
      <SectionCard title="Branding and layout" titleLevel={2}>
        <div className="space-y-6">
          <StatusPill
            tone={dirty ? 'warning' : 'success'}
            status={dirty ? 'draft' : 'saved'}
            label={dirty ? 'Unsaved draft' : 'Saved design'}
          />
          {canSave && !saved.registeredName && (
            <p className="text-sm text-text-muted">
              Add the registered name from your drug-sale licence in the branch&apos;s regulatory
              profile to print it on receipts.
            </p>
          )}
          {!canSave && (
            <p className="text-sm text-text-muted">
              You can preview this design. A workspace administrator can edit it.
            </p>
          )}
          <a
            href="#receipt-preview"
            className="inline-flex min-h-11 items-center text-sm underline xl:hidden"
          >
            View sample receipt
          </a>
          <fieldset disabled={disabled} className="min-w-0 space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <Choice
                label="Default paper"
                disabled={disabled}
                value={counterFormatFromLayout(draft)}
                onChange={(v) => patch(layoutWithPaper(draft, v as PrinterTestFormat))}
              >
                {papers}
              </Choice>
              <Choice
                label="Receipt language"
                disabled={disabled}
                value={draft.locale}
                onChange={(v) => patch({ locale: v as ReceiptDesign['locale'] })}
              >
                <option value="en">English</option>
                <option value="ur">اردو</option>
                <option value="both">English and Urdu</option>
              </Choice>
            </div>
            <p className="text-sm text-text-muted">
              Urdu and bilingual receipts use browser printing.
            </p>
            {textBlocks.map((id) => (
              <div key={id} className="space-y-2">
                <Label htmlFor={id}>{labels[id]}</Label>
                <Textarea
                  id={id}
                  value={draft[id]}
                  maxLength={id === 'footerText' ? 500 : 240}
                  aria-invalid={!!errors(id)}
                  aria-describedby={errors(id) ? id + '-error' : undefined}
                  onChange={(e) => patch({ [id]: e.target.value })}
                />
                {errors(id) && (
                  <p id={id + '-error'} className="text-sm text-destructive">
                    {errors(id)}
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Choice
                    label={labels[id] + ' alignment'}
                    disabled={disabled}
                    value={draft.alignment[id]}
                    onChange={(v) => patch({ alignment: { ...draft.alignment, [id]: v } })}
                  >
                    {['start', 'center', 'end'].map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </Choice>
                  <Choice
                    label={labels[id] + ' emphasis'}
                    disabled={disabled}
                    value={draft.emphasis[id]}
                    onChange={(v) => patch({ emphasis: { ...draft.emphasis, [id]: v } })}
                  >
                    {['normal', 'bold', 'large'].map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </Choice>
                </div>
              </div>
            ))}
            <div className="space-y-2">
              <Label htmlFor="receipt-url">Website for branding QR</Label>
              <Input
                id="receipt-url"
                type="url"
                placeholder="https://example.com"
                value={draft.brandingQr?.url ?? ''}
                aria-invalid={!!errors('brandingQr')}
                aria-describedby="website-hint"
                onChange={(e) =>
                  patch({ brandingQr: e.target.value ? { url: e.target.value } : undefined })
                }
              />
              <p id="website-hint" className="text-sm text-text-muted">
                Use an HTTPS website address. Leave blank to omit the QR.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="receipt-logo">Pharmacy logo</Label>
              <Input
                id="receipt-logo"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void chooseLogo(file);
                  e.target.value = '';
                }}
              />
              <p className="text-sm text-text-muted">
                PNG, JPEG or WebP, up to 1 MiB. A4 receipts can include the logo.
              </p>
              {draft.logo && (
                <>
                  <Label htmlFor="logo-width">Maximum logo width (mm)</Label>
                  <Input
                    id="logo-width"
                    type="number"
                    min={8}
                    max={48}
                    aria-invalid={!!errors('logo')}
                    aria-describedby="logo-width-hint"
                    value={Number.isFinite(draft.logo.maxWidthMm) ? draft.logo.maxWidthMm : ''}
                    onChange={(e) =>
                      patch({ logo: { ...draft.logo!, maxWidthMm: e.target.valueAsNumber } })
                    }
                  />
                  <p id="logo-width-hint" className="text-sm text-text-muted">
                    Choose a whole width from 8 to 48 mm.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      patch({ logo: undefined });
                      setPng(undefined);
                    }}
                  >
                    Remove logo
                  </Button>
                </>
              )}
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-text-strong">
                Optional section order
              </legend>
              {[
                ...draft.sections,
                ...optionalSections.filter((id) => !draft.sections.includes(id)),
              ].map((id, i) => (
                <div
                  key={id}
                  className="flex flex-wrap items-center gap-2 border-b border-border-subtle py-2"
                >
                  <label className="flex grow items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={'Include ' + labels[id]}
                      checked={draft.sections.includes(id)}
                      onChange={(e) =>
                        patch({
                          sections: e.target.checked
                            ? [...draft.sections, id]
                            : draft.sections.filter((x) => x !== id),
                        })
                      }
                    />
                    {labels[id]}
                  </label>
                  {([-1, 1] as const).map((step) => (
                    <Button
                      key={step}
                      type="button"
                      size="touch"
                      variant="ghost"
                      aria-label={'Move ' + labels[id] + (step < 0 ? ' up' : ' down')}
                      disabled={
                        i >= draft.sections.length ||
                        i + step < 0 ||
                        i + step >= draft.sections.length
                      }
                      onClick={() => {
                        const seq = [...draft.sections];
                        [seq[i], seq[i + step]] = [seq[i + step]!, id];
                        patch({ sections: seq });
                      }}
                    >
                      {step < 0 ? 'Up' : 'Down'}
                    </Button>
                  ))}
                </div>
              ))}
            </fieldset>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              size="touch"
              disabled={disabled || !dirty || !parsed.success || conflict}
              onClick={() => void submit()}
            >
              {save.isPending ? 'Saving…' : 'Save design'}
            </Button>
            <Button
              size="touch"
              variant="outline"
              disabled={disabled || (!dirty && !conflict)}
              onClick={() => {
                setDraft(receiptDesign(saved.layout));
                setPng(saved.receiptLogoPng);
                setBase(saved.revision);
                setNotice('Draft discarded.');
              }}
            >
              Discard draft
            </Button>
            <Button
              size="touch"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                setDraft(receiptDesign(null));
                setPng(undefined);
                setNotice('Defaults are in the draft. Save to apply them.');
              }}
            >
              Reset to defaults
            </Button>
          </div>
          {conflict && (
            <Button
              variant="outline"
              size="touch"
              disabled={disabled || !savedPreview}
              onClick={() => {
                setBase(saved.revision);
                setPreview('draft');
                setNotice('Latest revision reviewed. Save to apply your draft.');
              }}
            >
              Use reviewed revision {saved.revision}
            </Button>
          )}
          {notice && (
            <p role="status" className="text-sm text-text-body">
              {notice}
            </p>
          )}
        </div>
      </SectionCard>
      <SectionCard title="Receipt preview" titleLevel={2}>
        <div id="receipt-preview" className="space-y-4">
          <Choice label="Preview version" value={preview} onChange={setPreview}>
            <option value="draft">Current draft</option>
            <option value="saved">Saved design · revision {saved.revision}</option>
          </Choice>
          {savedPreview || parsed.success ? (
            <Preview
              layout={savedPreview ? receiptDesign(saved.layout) : draft}
              registeredName={saved.registeredName}
              png={savedPreview ? saved.receiptLogoPng : png}
            />
          ) : (
            <p role="alert">Correct the highlighted fields to preview this draft.</p>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
export function PharmacyReceiptDesigner({ canSave }: { canSave: boolean }) {
  const branches = trpc.pharmacySales.counterBranches.useQuery();
  const [selected, setSelected] = useState('');
  const list = branches.data?.branches ?? [];
  const branchId = list.some((b) => b.id === selected) ? selected : (list[0]?.id ?? '');
  const format = trpc.pharmacySales.counterReceiptFormat.useQuery(
    { branchId },
    { enabled: !!branchId, retry: false }
  );
  return (
    <div className="min-w-0 space-y-6">
      <SectionCard title="Branch" titleLevel={2}>
        {branches.isLoading ? (
          <p role="status">Loading branches…</p>
        ) : branches.isError ? (
          <p role="alert">
            Branches could not be loaded.{' '}
            <Button variant="outline" onClick={() => void branches.refetch()}>
              Retry
            </Button>
          </p>
        ) : !list.length ? (
          <p>No active branch is available.</p>
        ) : (
          <Choice label="Pharmacy branch" value={branchId} onChange={setSelected}>
            {list.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Choice>
        )}
      </SectionCard>
      {branchId &&
        (format.isLoading ? (
          <SectionCard title="Receipt design">
            <p role="status">Loading saved design…</p>
          </SectionCard>
        ) : format.isError || !format.data ? (
          <SectionCard title="Receipt design">
            <p role="alert">
              {format.error?.data?.code === 'FORBIDDEN'
                ? 'You do not have receipt access for this branch.'
                : 'The saved receipt design could not be loaded.'}
            </p>
            <Button variant="outline" onClick={() => void format.refetch()}>
              Retry
            </Button>
          </SectionCard>
        ) : (
          <Editor key={branchId} branchId={branchId} saved={format.data} canSave={canSave} />
        ))}
    </div>
  );
}
