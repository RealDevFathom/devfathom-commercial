'use client';

import { useState, type ChangeEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { safeHref } from '@/lib/validators';
import {
  ArrowLeft,
  Globe,
  MapPin,
  Clock as ClockIcon,
  Mail,
  Phone,
  User,
  FolderKanban,
  FileText,
  Briefcase,
  Plus,
  X,
  Loader2,
  Pencil,
  Trash2,
  Save,
  ScrollText,
  Calendar,
  ExternalLink,
  Upload,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { trpc } from '@/lib/trpc';
import { useBreadcrumbLabel } from '@/lib/breadcrumb-store';
import { cn } from '@/lib/utils';
import { format, formatDistanceToNow } from 'date-fns';
import { NotesContent } from '@/app/(app)/notes/notes-content';
import { uploadAttachment } from '@/lib/chat/upload-client';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { moneyListLabel } from '@/lib/finance/currency';
import { clientInvoiceTotals } from '@/lib/finance/client-invoice-totals';

type ClientDetail = NonNullable<inferRouterOutputs<AppRouter>['clients']['getById']>;
type ContractItem = ClientDetail['contracts'][number];

const statusConfig: Record<string, { bg: string; dot: string; label: string }> = {
  ACTIVE: {
    bg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
    label: 'Active',
  },
  INACTIVE: { bg: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground', label: 'Inactive' },
  PROSPECT: { bg: 'bg-blue-500/10 text-blue-500', dot: 'bg-blue-500', label: 'Prospect' },
};

const invoiceStatusConfig: Record<string, { bg: string; label: string }> = {
  DRAFT: { bg: 'bg-muted text-muted-foreground', label: 'Draft' },
  SENT: { bg: 'bg-blue-500/10 text-blue-500', label: 'Sent' },
  PAID: { bg: 'bg-emerald-500/10 text-emerald-500', label: 'Paid' },
  OVERDUE: { bg: 'bg-red-500/10 text-red-500', label: 'Overdue' },
  CANCELLED: { bg: 'bg-muted text-muted-foreground', label: 'Cancelled' },
};

const contractStatusConfig: Record<string, { bg: string; label: string }> = {
  DRAFT: { bg: 'bg-muted text-muted-foreground', label: 'Draft' },
  SENT: { bg: 'bg-blue-500/10 text-blue-500', label: 'Sent' },
  SIGNED: { bg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', label: 'Signed' },
  EXPIRED: { bg: 'bg-amber-500/10 text-amber-500', label: 'Expired' },
  TERMINATED: { bg: 'bg-red-500/10 text-red-500', label: 'Terminated' },
};

const CONTRACT_STATUSES = ['DRAFT', 'SENT', 'SIGNED', 'EXPIRED', 'TERMINATED'] as const;

// Mirrors how money is formatted across finance (see src/lib/ai/tools/finance.ts).
function formatContractValue(value: number | null, currency: string): string | null {
  if (value == null) return null;
  return currency === 'PKR' ? `Rs ${value.toLocaleString()}` : `$${value.toLocaleString()}`;
}

// IMP-CLI-04: derive the expiry / renewal chip for a contract row. Mirrors the
// server sweep (clients.sweepExpiredContracts): only live agreements lapse, so
// DRAFT and TERMINATED rows get no chip. Returns:
//   • 'expired'  — status is EXPIRED, or a still-in-force row is past its endDate
//   • 'expiring' — a still-in-force row whose endDate is within the next 30 days
//   • null       — nothing to flag
type ContractExpiry = { tone: 'expired' | 'expiring'; label: string };
function contractExpiry(
  status: string,
  endDate: Date | string | null | undefined,
  now: number = Date.now()
): ContractExpiry | null {
  // An already-swept contract always shows the red chip, even without a date.
  if (status === 'EXPIRED') return { tone: 'expired', label: 'Expired' };
  // Only SENT/SIGNED contracts are "in force" and worth chasing for renewal.
  if (status !== 'SENT' && status !== 'SIGNED') return null;
  if (!endDate) return null;
  const end = new Date(endDate).getTime();
  if (Number.isNaN(end)) return null;
  if (end < now) return { tone: 'expired', label: 'Expired' };
  const days = Math.ceil((end - now) / (24 * 60 * 60 * 1000));
  if (days <= 30)
    return { tone: 'expiring', label: `Expires in ${days} day${days === 1 ? '' : 's'}` };
  return null;
}

export function ClientDetailContent({ clientId }: { clientId: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  const { data: client, isLoading } = trpc.clients.getById.useQuery({ id: clientId });

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editWebsite, setEditWebsite] = useState('');
  const [editIndustry, setEditIndustry] = useState('');
  const [editLocation, setEditLocation] = useState('');
  const [editNotes, setEditNotes] = useState('');
  // IMP-CLI-03: editable client status + logo.
  const [editStatus, setEditStatus] = useState<'ACTIVE' | 'INACTIVE' | 'PROSPECT'>('ACTIVE');
  const [editLogo, setEditLogo] = useState<string | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const updateClient = trpc.clients.update.useMutation({
    onSuccess: () => {
      utils.clients.getById.invalidate({ id: clientId });
      setIsEditing(false);
    },
  });
  const deleteClient = trpc.clients.delete.useMutation({
    onSuccess: () => router.push('/clients'),
  });

  // Show the client name in the topbar breadcrumb instead of the raw id.
  useBreadcrumbLabel(clientId, client?.name);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-28 mb-4" />
        <Skeleton className="h-9 w-48 mb-2" />
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-10 w-96" />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2 border-border/60">
            <CardContent className="p-6">
              <Skeleton className="h-32 w-full" />
            </CardContent>
          </Card>
          <Card className="border-border/60">
            <CardContent className="p-6">
              <Skeleton className="h-32 w-full" />
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!client) {
    return (
      <div className="flex flex-col items-center justify-center py-32">
        <Briefcase className="h-16 w-16 text-muted-foreground/20" />
        <h2 className="mt-4 font-display text-xl font-semibold text-foreground">
          Client not found
        </h2>
        <Link href="/clients" className="mt-6 text-sm font-medium text-primary hover:underline">
          Back to Clients
        </Link>
      </div>
    );
  }

  const config = statusConfig[client.status] || statusConfig.ACTIVE;
  const { revenue: totalRevenue, outstanding: outstandingAmount } = clientInvoiceTotals(
    client.invoices
  );

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/clients"
          className="mb-5 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Clients
        </Link>

        <PageHeader
          eyebrow="WORKSPACE"
          className="mb-0"
          heading={
            <span className="flex min-w-0 flex-wrap items-center gap-3">
              <span className="min-w-0 break-words">{client.name}</span>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
                  config.bg
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', config.dot)} aria-hidden />
                {config.label}
              </span>
            </span>
          }
          description={
            client.industry || client.location || client.website ? (
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {client.industry && <span>{client.industry}</span>}
                {client.location && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {client.location}
                  </span>
                )}
                {client.website && (
                  <a
                    href={safeHref(client.website)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <Globe className="h-3 w-3" />
                    {client.website.replace(/^https?:\/\//, '')}
                  </a>
                )}
              </span>
            ) : undefined
          }
          actions={
            <>
              <Button
                variant="outline"
                size="lg"
                onClick={() => {
                  if (!isEditing) {
                    setEditName(client.name);
                    setEditWebsite(client.website || '');
                    setEditIndustry(client.industry || '');
                    setEditLocation(client.location || '');
                    setEditNotes(client.notes || '');
                    setEditStatus(client.status);
                    setEditLogo(client.logo ?? null);
                  }
                  setIsEditing(!isEditing);
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
              {!showDeleteConfirm ? (
                <Button
                  variant="destructive"
                  size="icon-lg"
                  onClick={() => setShowDeleteConfirm(true)}
                  aria-label="Delete client"
                  title="Delete client"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <>
                  <Button
                    variant="destructive"
                    size="lg"
                    onClick={() => deleteClient.mutate({ id: clientId })}
                    disabled={deleteClient.isPending}
                  >
                    {deleteClient.isPending ? 'Deleting...' : 'Confirm Delete'}
                  </Button>
                  <Button variant="ghost" size="lg" onClick={() => setShowDeleteConfirm(false)}>
                    Cancel
                  </Button>
                </>
              )}
            </>
          }
        />

        {/* CLI-01: surface a friendly delete error (e.g. client has invoices). */}
        {deleteClient.error && (
          <p className="mt-2 text-right text-xs text-red-500">{deleteClient.error.message}</p>
        )}
      </div>

      {/* Edit form */}
      {isEditing && (
        <Card className="border-primary/20">
          <CardContent className="p-5 space-y-4">
            <h3 className="text-sm font-semibold text-foreground">Edit Client</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Name</label>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Website</label>
                <input
                  value={editWebsite}
                  onChange={(e) => setEditWebsite(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Industry</label>
                <input
                  value={editIndustry}
                  onChange={(e) => setEditIndustry(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Location</label>
                <input
                  value={editLocation}
                  onChange={(e) => setEditLocation(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              {/* IMP-CLI-03: status selector */}
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Status</label>
                <select
                  value={editStatus}
                  onChange={(e) =>
                    setEditStatus(e.target.value as 'ACTIVE' | 'INACTIVE' | 'PROSPECT')
                  }
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="PROSPECT">Prospect</option>
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                </select>
              </div>
              {/* IMP-CLI-03: logo upload */}
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Logo</label>
                <div className="flex items-center gap-2">
                  {editLogo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={editLogo} alt="logo" className="h-9 w-9 rounded-lg object-cover" />
                  )}
                  <label className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-secondary">
                    {uploadingLogo ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Pencil className="h-3.5 w-3.5" />
                    )}
                    {editLogo ? 'Change' : 'Upload'}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      disabled={uploadingLogo}
                      onChange={async (e: ChangeEvent<HTMLInputElement>) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        setUploadingLogo(true);
                        try {
                          const fd = new FormData();
                          fd.append('file', file);
                          const res = await fetch('/api/upload', { method: 'POST', body: fd });
                          if (res.ok) setEditLogo(((await res.json()) as { url: string }).url);
                        } finally {
                          setUploadingLogo(false);
                        }
                      }}
                    />
                  </label>
                  {editLogo && (
                    <button
                      onClick={() => setEditLogo(null)}
                      className="text-xs text-muted-foreground hover:text-red-500"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Notes</label>
              <textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                rows={2}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground resize-none focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            {/* UX-01: surface validation/mutation errors (e.g. invalid website URL). */}
            {updateClient.error && (
              <p className="mb-2 text-xs text-red-500">{updateClient.error.message}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setIsEditing(false)}
                className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  updateClient.mutate({
                    id: clientId,
                    name: editName.trim() || undefined,
                    website: editWebsite || null,
                    industry: editIndustry || null,
                    location: editLocation || null,
                    notes: editNotes || null,
                    status: editStatus,
                    logo: editLogo,
                  })
                }
                disabled={updateClient.isPending}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
              >
                {updateClient.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save Changes
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="projects">Projects ({client.projects.length})</TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="invoices">Invoices ({client.invoices.length})</TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="contracts">Contracts ({client.contracts.length})</TabsTrigger>
          )}
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="contacts">Contacts ({client.contacts.length})</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        {/* OVERVIEW */}
        <TabsContent value="overview" className="space-y-5">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2 border-border/60">
              <CardHeader className="pb-3">
                <CardTitle className="text-[15px] font-semibold text-foreground">Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {client.notes && (
                  <p className="text-sm text-muted-foreground leading-relaxed">{client.notes}</p>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                  {client.timezone && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                        Timezone
                      </p>
                      <p className="text-sm font-medium text-foreground flex items-center gap-1">
                        <ClockIcon className="h-3 w-3" />
                        {client.timezone}
                      </p>
                    </div>
                  )}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                      Projects
                    </p>
                    <p className="text-sm font-medium text-foreground">{client.projects.length}</p>
                  </div>
                  {isAdmin && (
                    <>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                          Total Revenue
                        </p>
                        <p className="text-sm font-bold text-emerald-500">
                          {moneyListLabel(totalRevenue)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                          Outstanding
                        </p>
                        <p
                          className={cn(
                            'text-sm font-bold',
                            outstandingAmount.some(({ amount }) => amount > 0)
                              ? 'text-amber-500'
                              : 'text-muted-foreground'
                          )}
                        >
                          {moneyListLabel(outstandingAmount)}
                        </p>
                      </div>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Primary contact */}
            <Card className="border-border/60">
              <CardHeader className="pb-3">
                <CardTitle className="text-[15px] font-semibold text-foreground">
                  Primary Contact
                </CardTitle>
              </CardHeader>
              <CardContent>
                {client.contacts.length > 0 ? (
                  <div className="space-y-3">
                    <p className="text-base font-semibold text-foreground">
                      {client.contacts[0].name}
                    </p>
                    {client.contacts[0].role && (
                      <p className="text-sm text-muted-foreground">{client.contacts[0].role}</p>
                    )}
                    {client.contacts[0].email && (
                      <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                        <Mail className="h-3.5 w-3.5" />
                        {client.contacts[0].email}
                      </p>
                    )}
                    {client.contacts[0].phone && (
                      <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                        <Phone className="h-3.5 w-3.5" />
                        {client.contacts[0].phone}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No contacts added</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* PROJECTS */}
        <TabsContent value="projects">
          <ClientProjectsTab
            clientId={clientId}
            clientName={client.name}
            projects={client.projects}
          />
        </TabsContent>

        {/* INVOICES — admin only */}
        {isAdmin && (
          <TabsContent value="invoices">
            {client.invoices.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
                <FileText className="h-12 w-12 text-muted-foreground/20" />
                <h3 className="mt-4 font-display text-lg font-semibold text-foreground">
                  No invoices
                </h3>
              </div>
            ) : (
              <Card className="border-border/60">
                <CardContent className="p-0">
                  <div className="divide-y divide-border/60">
                    {client.invoices.map((inv) => {
                      const ic = invoiceStatusConfig[inv.status] || invoiceStatusConfig.DRAFT;
                      return (
                        <div key={inv.id} className="flex items-center justify-between px-6 py-3.5">
                          <div>
                            <p className="text-sm font-semibold text-foreground font-mono">
                              {inv.invoiceNumber}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {inv.project?.name || '—'} &middot;{' '}
                              {format(new Date(inv.dueDate), 'MMM d, yyyy')}
                            </p>
                          </div>
                          <div className="flex items-center gap-4">
                            <span className="text-sm font-semibold text-foreground tabular-nums">
                              ${Number(inv.total).toLocaleString()}
                            </span>
                            <span
                              className={cn(
                                'rounded-full px-2.5 py-1 text-[11px] font-medium',
                                ic.bg
                              )}
                            >
                              {ic.label}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        )}

        {/* CONTRACTS — admin only */}
        {isAdmin && (
          <TabsContent value="contracts">
            <ClientContractsTab
              clientId={clientId}
              clientName={client.name}
              contracts={client.contracts}
              projects={client.projects}
            />
          </TabsContent>
        )}

        {/* NOTES */}
        <TabsContent value="notes">
          <NotesContent clientId={clientId} embedded />
        </TabsContent>

        {/* CONTACTS */}
        <TabsContent value="contacts">
          <ContactsTab clientId={clientId} contacts={client.contacts} />
        </TabsContent>

        {/* IMP-CLI-02: client activity timeline */}
        <TabsContent value="activity">
          <ClientActivityTab clientId={clientId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ============================================
   IMP-CLI-01: Contacts tab — full CRUD (add/edit/delete/set-primary)
   ============================================ */
type ClientContact = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  isPrimary: boolean;
};

function ContactForm({
  initial,
  onSubmit,
  onCancel,
  pending,
}: {
  initial?: ClientContact;
  onSubmit: (d: {
    name: string;
    email: string;
    phone: string;
    role: string;
    isPrimary: boolean;
  }) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [role, setRole] = useState(initial?.role ?? '');
  const [isPrimary, setIsPrimary] = useState(initial?.isPrimary ?? false);
  const inp =
    'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';
  return (
    <Card className="border-primary/20">
      <CardContent className="p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name *"
            className={inp}
          />
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Role"
            className={inp}
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className={inp}
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone"
            className={inp}
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={isPrimary}
            onChange={(e) => setIsPrimary(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-primary"
          />
          Primary contact
        </label>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-xl px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={() =>
              name.trim() &&
              onSubmit({
                name: name.trim(),
                email: email.trim(),
                phone: phone.trim(),
                role: role.trim(),
                isPrimary,
              })
            }
            disabled={!name.trim() || pending}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] disabled:opacity-40"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function ContactsTab({ clientId, contacts }: { clientId: string; contacts: ClientContact[] }) {
  const utils = trpc.useUtils();
  const invalidate = () => utils.clients.getById.invalidate({ id: clientId });
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const addContact = trpc.clients.addContact.useMutation({
    onSuccess: () => {
      invalidate();
      setShowAdd(false);
    },
  });
  const updateContact = trpc.clients.updateContact.useMutation({
    onSuccess: () => {
      invalidate();
      setEditingId(null);
    },
  });
  const deleteContact = trpc.clients.deleteContact.useMutation({ onSuccess: invalidate });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {!showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> Add Contact
          </button>
        )}
      </div>
      {showAdd && (
        <ContactForm
          onSubmit={(d) => addContact.mutate({ clientId, ...d })}
          onCancel={() => setShowAdd(false)}
          pending={addContact.isPending}
        />
      )}
      {contacts.length === 0 && !showAdd ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16">
          <User className="h-10 w-10 text-muted-foreground/20" />
          <p className="mt-3 text-sm text-muted-foreground">No contacts yet</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {contacts.map((contact) =>
            editingId === contact.id ? (
              <ContactForm
                key={contact.id}
                initial={contact}
                onSubmit={(d) => updateContact.mutate({ id: contact.id, ...d })}
                onCancel={() => setEditingId(null)}
                pending={updateContact.isPending}
              />
            ) : (
              <Card key={contact.id} className="group/contact border-border/60">
                <CardContent className="p-5">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary font-semibold text-sm">
                      {contact.name
                        .split(' ')
                        .map((n) => n[0])
                        .join('')
                        .slice(0, 2)}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground truncate">
                        {contact.name}
                      </p>
                      {contact.role && (
                        <p className="text-xs text-muted-foreground truncate">{contact.role}</p>
                      )}
                    </div>
                    {contact.isPrimary && (
                      <span className="ml-auto rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary shrink-0">
                        Primary
                      </span>
                    )}
                  </div>
                  {contact.email && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5 mb-1">
                      <Mail className="h-3 w-3" /> {contact.email}
                    </p>
                  )}
                  {contact.phone && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <Phone className="h-3 w-3" /> {contact.phone}
                    </p>
                  )}
                  <div className="mt-3 flex items-center gap-1 opacity-0 group-hover/contact:opacity-100 transition-opacity">
                    {!contact.isPrimary && (
                      <button
                        onClick={() => updateContact.mutate({ id: contact.id, isPrimary: true })}
                        className="rounded-md px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-primary"
                      >
                        Set primary
                      </button>
                    )}
                    <button
                      onClick={() => setEditingId(contact.id)}
                      className="ml-auto text-muted-foreground/60 hover:text-foreground"
                      title="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => deleteContact.mutate({ id: contact.id })}
                      className="text-muted-foreground/60 hover:text-red-500"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </CardContent>
              </Card>
            )
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================
   IMP-CLI-02: Client activity timeline tab
   ============================================ */
function ClientActivityTab({ clientId }: { clientId: string }) {
  const { data, isLoading } = trpc.clients.getActivity.useQuery({ id: clientId });
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16">
        <ClockIcon className="h-10 w-10 text-muted-foreground/20" />
        <p className="mt-3 text-sm text-muted-foreground">No activity yet</p>
      </div>
    );
  }
  return (
    <Card className="border-border/60">
      <CardContent className="p-0 divide-y divide-border/60">
        {data.map((a) => (
          <div key={a.id} className="flex items-center gap-3 px-5 py-3">
            <div className="h-2 w-2 rounded-full bg-primary/50 shrink-0" />
            <p className="flex-1 text-sm text-muted-foreground">
              <span className="font-medium text-foreground/80">{a.user?.name ?? 'Someone'}</span>{' '}
              {a.message}
            </p>
            <span className="text-xs text-muted-foreground/50 shrink-0">
              {formatDistanceToNow(new Date(a.createdAt), { addSuffix: true })}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ============================================
   Client Projects Tab — with create project
   ============================================ */
function ClientProjectsTab({
  clientId,
  clientName,
  projects,
}: {
  clientId: string;
  clientName: string;
  projects: Array<{
    id: string;
    name: string;
    status: string;
    members: Array<{ user: { id: string; name: string; avatar: string | null } }>;
  }>;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data: team } = trpc.team.getAll.useQuery();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);

  const createProject = trpc.projects.create.useMutation({
    onSuccess: (project) => {
      utils.clients.getById.invalidate({ id: clientId });
      setShowCreate(false);
      router.push(`/projects/${project.id}`);
    },
  });

  const handleSubmit = () => {
    if (!name.trim()) return;
    createProject.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      type: 'CLIENT',
      clientId,
      memberIds: selectedMembers,
      createDefaultBoard: true,
    });
  };

  const pStatusConfig: Record<string, { bg: string; dot: string }> = {
    ACTIVE: {
      bg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      dot: 'bg-emerald-500',
    },
    IN_DEVELOPMENT: { bg: 'bg-blue-500/10 text-blue-500', dot: 'bg-blue-500' },
    ON_HOLD: { bg: 'bg-amber-500/10 text-amber-500', dot: 'bg-amber-500' },
    COMPLETED: { bg: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' },
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {projects.length} project{projects.length !== 1 ? 's' : ''} for {clientName}
        </p>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
        >
          <Plus className="h-3.5 w-3.5" />
          New Project
        </button>
      </div>

      {/* Create project form */}
      {showCreate && (
        <Card className="border-primary/20">
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">
                New Project for {clientName}
              </h3>
              <button
                onClick={() => setShowCreate(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                Project Name *
              </label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && name.trim()) handleSubmit();
                }}
                placeholder={`e.g. ${clientName} Platform`}
                className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Brief description..."
                className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            {/* Team members */}
            {team && team.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">
                  Team Members
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {team.map((member) => (
                    <button
                      key={member.id}
                      onClick={() =>
                        setSelectedMembers((prev) =>
                          prev.includes(member.id)
                            ? prev.filter((m) => m !== member.id)
                            : [...prev, member.id]
                        )
                      }
                      className={cn(
                        'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                        selectedMembers.includes(member.id)
                          ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                          : 'bg-secondary text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <Avatar className="h-4 w-4">
                        <AvatarImage src={member.avatar ?? undefined} />
                        <AvatarFallback className="text-[7px] bg-muted font-medium">
                          {member.name[0]}
                        </AvatarFallback>
                      </Avatar>
                      {member.name.split(' ')[0]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!name.trim() || createProject.isPending}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
              >
                {createProject.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create Project'
                )}
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Project cards */}
      {projects.length === 0 && !showCreate ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
          <FolderKanban className="h-12 w-12 text-muted-foreground/20" />
          <h3 className="mt-4 font-display text-lg font-semibold text-foreground">No projects</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a project for this client to get started
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-4 flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] active:scale-[0.98] transition-all"
          >
            <Plus className="h-3.5 w-3.5" />
            Create First Project
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const pc = pStatusConfig[project.status] || pStatusConfig.ACTIVE;
            return (
              <Link key={project.id} href={`/projects/${project.id}`}>
                <Card className="group border-border/60 hover:border-border hover:shadow-lg hover:-translate-y-0.5 transition-all cursor-pointer">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                        {project.name}
                      </h3>
                      <div
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0',
                          pc.bg
                        )}
                      >
                        <div className={cn('h-1 w-1 rounded-full', pc.dot)} />
                        {project.status.replace('_', ' ')}
                      </div>
                    </div>
                    <div className="flex -space-x-1.5 mt-4">
                      {project.members.slice(0, 4).map((m) => (
                        <Avatar key={m.user.id} className="h-6 w-6 border-2 border-card">
                          <AvatarImage src={m.user.avatar ?? undefined} />
                          <AvatarFallback className="text-[9px] bg-secondary font-medium">
                            {m.user.name[0]}
                          </AvatarFallback>
                        </Avatar>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================================
   Client Contracts Tab — admin only, with CRUD
   ============================================ */
const inputClass =
  'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

function ClientContractsTab({
  clientId,
  clientName,
  contracts,
  projects,
}: {
  clientId: string;
  clientName: string;
  contracts: ContractItem[];
  projects: Array<{ id: string; name: string }>;
}) {
  const utils = trpc.useUtils();

  // IMP-CLI-05: per-client total contracted value, grouped by currency.
  const { data: contractedValue } = trpc.clients.contractedValue.useQuery({ id: clientId });

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<(typeof CONTRACT_STATUSES)[number]>('DRAFT');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState<'USD' | 'PKR'>('USD');
  const [projectId, setProjectId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [signedAt, setSignedAt] = useState('');
  const [fileUrl, setFileUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [notes, setNotes] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const resetForm = () => {
    setEditingId(null);
    setTitle('');
    setStatus('DRAFT');
    setValue('');
    setCurrency('USD');
    setProjectId('');
    setStartDate('');
    setEndDate('');
    setSignedAt('');
    setFileUrl('');
    setFileName('');
    setNotes('');
    setUploadError(null);
    // Clear any prior save error so a reopened form starts clean.
    addContract.reset();
    updateContract.reset();
  };

  const closeForm = () => {
    setShowForm(false);
    resetForm();
  };

  const invalidate = () => {
    utils.clients.getById.invalidate({ id: clientId });
    utils.clients.contractedValue.invalidate({ id: clientId });
  };

  const addContract = trpc.clients.addContract.useMutation({
    onSuccess: () => {
      invalidate();
      closeForm();
    },
  });
  const updateContract = trpc.clients.updateContract.useMutation({
    onSuccess: () => {
      invalidate();
      closeForm();
    },
  });
  const setContractStatus = trpc.clients.setContractStatus.useMutation({
    onSuccess: () => invalidate(),
  });
  const deleteContract = trpc.clients.deleteContract.useMutation({
    onSuccess: () => {
      invalidate();
      setDeletingId(null);
    },
  });
  // IMP-CLI-05: draft an invoice from a contract's value (refresh the invoices tab).
  const generateInvoice = trpc.clients.generateInvoiceFromContract.useMutation({
    onSuccess: () => invalidate(),
  });

  // IMP-CLI-04: on-demand expiry sweep (the action a cron would run). Flips
  // lapsed SENT/SIGNED contracts to EXPIRED, refreshes the list, and surfaces the
  // count briefly. Errors stay inline next to the button.
  const [sweepResult, setSweepResult] = useState<number | null>(null);
  const sweepExpired = trpc.clients.sweepExpiredContracts.useMutation({
    onSuccess: (res) => {
      setSweepResult(res.expired);
      invalidate();
      window.setTimeout(() => setSweepResult(null), 5000);
    },
  });

  // IMP-CLI-04: renewal heads-up derived client-side from each row's endDate.
  const expiringSoon = contracts.filter(
    (c) => contractExpiry(c.status, c.endDate)?.tone === 'expiring'
  ).length;

  const isSaving = addContract.isPending || updateContract.isPending;
  // Surface a save failure inline so the form stays open and the user can retry.
  const saveError = (editingId ? updateContract.error : addContract.error)?.message;
  const toDate = (s: string) => (s ? new Date(s) : undefined);

  // Reuse the shared upload pipeline (uploadAttachment → /api/upload) for the
  // optional signed-document link.
  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file after a failure
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const uploaded = await uploadAttachment(file);
      setFileUrl(uploaded.url);
      setFileName(uploaded.name);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const openCreate = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (c: ContractItem) => {
    setEditingId(c.id);
    setTitle(c.title);
    setStatus(c.status as (typeof CONTRACT_STATUSES)[number]);
    setValue(c.value != null ? String(Number(c.value)) : '');
    setCurrency(c.currency as 'USD' | 'PKR');
    setProjectId(c.projectId ?? '');
    setStartDate(c.startDate ? format(new Date(c.startDate), 'yyyy-MM-dd') : '');
    setEndDate(c.endDate ? format(new Date(c.endDate), 'yyyy-MM-dd') : '');
    setSignedAt(c.signedAt ? format(new Date(c.signedAt), 'yyyy-MM-dd') : '');
    setFileUrl(c.fileUrl ?? '');
    setFileName(c.fileUrl ? (c.fileUrl.split('/').pop() ?? 'Document') : '');
    setNotes(c.notes ?? '');
    setUploadError(null);
    // Clear any prior save error so the edit form starts clean.
    addContract.reset();
    updateContract.reset();
    setShowForm(true);
  };

  const handleSubmit = () => {
    if (!title.trim()) return;
    const numericValue = value.trim() ? Number(value) : undefined;
    if (numericValue !== undefined && Number.isNaN(numericValue)) return;
    if (editingId) {
      updateContract.mutate({
        id: editingId,
        title: title.trim(),
        status,
        value: numericValue ?? null,
        currency,
        projectId: projectId || null,
        startDate: toDate(startDate) ?? null,
        endDate: toDate(endDate) ?? null,
        signedAt: toDate(signedAt) ?? null,
        fileUrl: fileUrl.trim() || null,
        notes: notes.trim() || null,
      });
    } else {
      addContract.mutate({
        clientId,
        title: title.trim(),
        status,
        value: numericValue,
        currency,
        projectId: projectId || undefined,
        startDate: toDate(startDate),
        endDate: toDate(endDate),
        signedAt: toDate(signedAt),
        fileUrl: fileUrl.trim() || undefined,
        notes: notes.trim() || undefined,
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {contracts.length} contract{contracts.length !== 1 ? 's' : ''} for {clientName}
          {expiringSoon > 0 && (
            <span className="ml-2 text-amber-500">· {expiringSoon} expiring soon</span>
          )}
        </p>
        {!showForm && (
          <div className="flex items-center gap-2">
            {/* IMP-CLI-04: on-demand expiry sweep (admin-only tab). */}
            <button
              onClick={() => sweepExpired.mutate()}
              disabled={sweepExpired.isPending}
              title="Mark lapsed contracts as expired"
              className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
            >
              {sweepExpired.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Check expiries
              {sweepResult !== null && (
                <span className="text-primary">({sweepResult} expired)</span>
              )}
            </button>
            <button
              onClick={openCreate}
              className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
            >
              <Plus className="h-3.5 w-3.5" />
              New Contract
            </button>
          </div>
        )}
      </div>
      {sweepExpired.error && <p className="text-xs text-red-500">{sweepExpired.error.message}</p>}

      {/* IMP-CLI-05: per-client total contracted value, grouped by currency. */}
      {contractedValue && contractedValue.length > 0 && (
        <Card className="border-border/60">
          <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3 p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Total Contracted Value
            </p>
            {contractedValue.map((cv) => (
              <div key={cv.currency} className="flex items-baseline gap-1.5">
                <span className="text-base font-bold tabular-nums text-foreground">
                  {formatContractValue(cv.total, cv.currency)}
                </span>
                <span className="text-xs text-muted-foreground">
                  ({cv.count} {cv.currency})
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Create / edit form */}
      {showForm && (
        <Card className="border-primary/20">
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">
                {editingId ? 'Edit Contract' : `New Contract for ${clientName}`}
              </h3>
              <button onClick={closeForm} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Title *</label>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Master Services Agreement"
                className={inputClass}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Status</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as (typeof CONTRACT_STATUSES)[number])}
                  className={inputClass}
                >
                  {CONTRACT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {contractStatusConfig[s].label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Value</label>
                <div className="flex gap-2">
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value as 'USD' | 'PKR')}
                    className={cn(inputClass, 'w-20 shrink-0')}
                  >
                    <option value="USD">USD</option>
                    <option value="PKR">PKR</option>
                  </select>
                  <input
                    type="number"
                    min="0"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="0"
                    className={inputClass}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  Linked Project
                </label>
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className={inputClass}
                >
                  <option value="">No project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Start Date</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">End Date</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  Signed Date
                </label>
                <input
                  type="date"
                  value={signedAt}
                  onChange={(e) => setSignedAt(e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                Signed Document
              </label>
              {fileUrl ? (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2">
                  <a
                    href={safeHref(fileUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-primary hover:underline truncate"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{fileName || 'Document'}</span>
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      setFileUrl('');
                      setFileName('');
                    }}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-border bg-background px-3 py-2 text-sm text-muted-foreground hover:border-primary hover:text-foreground transition-colors',
                    uploading && 'pointer-events-none opacity-60'
                  )}
                >
                  {uploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  {uploading ? 'Uploading…' : 'Upload signed document'}
                  <input type="file" className="hidden" onChange={handleFileSelect} />
                </label>
              )}
              {uploadError && <p className="mt-1 text-xs text-red-500">{uploadError}</p>}
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Scope, terms, renewal details..."
                className={cn(inputClass, 'resize-none')}
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              {saveError && <p className="mr-auto text-xs text-red-500">{saveError}</p>}
              <button
                onClick={closeForm}
                className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!title.trim() || isSaving || uploading}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] disabled:opacity-40 transition-colors"
              >
                {isSaving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {editingId ? 'Save Changes' : 'Create Contract'}
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Contract list */}
      {contracts.length === 0 && !showForm ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
          <ScrollText className="h-12 w-12 text-muted-foreground/20" />
          <h3 className="mt-4 font-display text-lg font-semibold text-foreground">No contracts</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Track agreements and their terms for this client
          </p>
          <button
            onClick={openCreate}
            className="mt-4 flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground hover:bg-[#0C2E2C] active:scale-[0.98] transition-all"
          >
            <Plus className="h-3.5 w-3.5" />
            Add First Contract
          </button>
        </div>
      ) : (
        contracts.length > 0 && (
          <Card className="border-border/60">
            <CardContent className="p-0">
              <div className="divide-y divide-border/60">
                {contracts.map((c) => {
                  const sc = contractStatusConfig[c.status] || contractStatusConfig.DRAFT;
                  const valueLabel = formatContractValue(
                    c.value != null ? Number(c.value) : null,
                    c.currency
                  );
                  return (
                    <div key={c.id} className="px-6 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-semibold text-foreground">{c.title}</p>
                            <select
                              value={c.status}
                              onChange={(e) =>
                                setContractStatus.mutate({
                                  id: c.id,
                                  status: e.target.value as (typeof CONTRACT_STATUSES)[number],
                                })
                              }
                              disabled={setContractStatus.isPending}
                              aria-label="Contract status"
                              className={cn(
                                'cursor-pointer rounded-full border-0 px-2.5 py-1 text-[11px] font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60',
                                sc.bg
                              )}
                            >
                              {CONTRACT_STATUSES.map((s) => (
                                <option key={s} value={s} className="bg-card text-foreground">
                                  {contractStatusConfig[s].label}
                                </option>
                              ))}
                            </select>
                            {/* IMP-CLI-04: expiry / renewal indicator. */}
                            {(() => {
                              const chip = contractExpiry(c.status, c.endDate);
                              if (!chip) return null;
                              return (
                                <span
                                  className={cn(
                                    'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium',
                                    chip.tone === 'expired'
                                      ? 'bg-red-500/10 text-red-500'
                                      : 'bg-amber-500/10 text-amber-500'
                                  )}
                                >
                                  <AlertTriangle className="h-3 w-3" />
                                  {chip.label}
                                </span>
                              );
                            })()}
                          </div>
                          {setContractStatus.error && setContractStatus.variables?.id === c.id && (
                            <p className="mt-1 text-xs text-red-500">
                              {setContractStatus.error.message}
                            </p>
                          )}
                          <div className="flex items-center gap-4 mt-1.5 text-xs text-muted-foreground flex-wrap">
                            {valueLabel && (
                              <span className="font-semibold text-foreground tabular-nums">
                                {valueLabel}
                              </span>
                            )}
                            {c.project && (
                              <Link
                                href={`/projects/${c.project.id}`}
                                className="flex items-center gap-1 text-primary hover:underline"
                              >
                                <FolderKanban className="h-3 w-3" />
                                {c.project.name}
                              </Link>
                            )}
                            {(c.startDate || c.endDate) && (
                              <span className="flex items-center gap-1">
                                <Calendar className="h-3 w-3" />
                                {c.startDate ? format(new Date(c.startDate), 'MMM d, yyyy') : '—'}
                                {' – '}
                                {c.endDate ? format(new Date(c.endDate), 'MMM d, yyyy') : '—'}
                              </span>
                            )}
                            {c.signedAt && (
                              <span className="flex items-center gap-1">
                                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                                Signed {format(new Date(c.signedAt), 'MMM d, yyyy')}
                              </span>
                            )}
                            {c.fileUrl && (
                              <a
                                href={safeHref(c.fileUrl)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-primary hover:underline"
                              >
                                <ExternalLink className="h-3 w-3" /> Document
                              </a>
                            )}
                          </div>
                          {c.notes && (
                            <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                              {c.notes}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {deletingId === c.id ? (
                            <>
                              <button
                                onClick={() => deleteContract.mutate({ id: c.id })}
                                disabled={deleteContract.isPending}
                                className="rounded-lg bg-red-500 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-red-600 disabled:opacity-50"
                              >
                                {deleteContract.isPending ? '...' : 'Confirm'}
                              </button>
                              <button
                                onClick={() => {
                                  deleteContract.reset();
                                  setDeletingId(null);
                                }}
                                className="rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              {c.value != null && Number(c.value) > 0 && (
                                <button
                                  onClick={() => generateInvoice.mutate({ contractId: c.id })}
                                  disabled={
                                    generateInvoice.isPending &&
                                    generateInvoice.variables?.contractId === c.id
                                  }
                                  title="Generate draft invoice from value"
                                  className="rounded-lg border border-border bg-card p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-50"
                                >
                                  {generateInvoice.isPending &&
                                  generateInvoice.variables?.contractId === c.id ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <FileText className="h-3.5 w-3.5" />
                                  )}
                                </button>
                              )}
                              <button
                                onClick={() => openEdit(c)}
                                title="Edit"
                                className="rounded-lg border border-border bg-card p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => setDeletingId(c.id)}
                                title="Delete"
                                className="rounded-lg border border-border bg-card p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/20 transition-colors"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {deletingId === c.id &&
                        deleteContract.error &&
                        deleteContract.variables?.id === c.id && (
                          <p className="mt-2 text-xs text-red-500 text-right">
                            {deleteContract.error.message}
                          </p>
                        )}
                      {generateInvoice.error && generateInvoice.variables?.contractId === c.id && (
                        <p className="mt-2 text-xs text-red-500 text-right">
                          {generateInvoice.error.message}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )
      )}
    </div>
  );
}
