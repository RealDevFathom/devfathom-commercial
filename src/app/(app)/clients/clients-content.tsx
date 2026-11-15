'use client';

import { memo, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
  Search,
  Plus,
  Briefcase,
  FolderKanban,
  FileText,
  ArrowUpRight,
  X,
  Loader2,
  Globe,
  MapPin,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { trpc } from '@/lib/trpc';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { cn } from '@/lib/utils';
import { moneyListLabel } from '@/lib/finance/currency';

type Client = inferRouterOutputs<AppRouter>['clients']['getAll'][number];

const statusConfig: Record<string, { bg: string; dot: string; label: string }> = {
  ACTIVE: {
    bg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
    label: 'Active',
  },
  INACTIVE: { bg: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground', label: 'Inactive' },
  PROSPECT: { bg: 'bg-blue-500/10 text-blue-500', dot: 'bg-blue-500', label: 'Prospect' },
};

export function ClientsContent() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const { data: clients, isLoading } = trpc.clients.getAll.useQuery();

  // IMP-CLI-08: richer search — match name, industry, location and contact name,
  // not just the client name.
  const filtered = useMemo(() => {
    if (!search) return clients ?? [];
    const q = search.toLowerCase();
    return (
      clients?.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.industry?.toLowerCase().includes(q) ?? false) ||
          (c.location?.toLowerCase().includes(q) ?? false) ||
          (c.contacts ?? []).some((ct) => ct.name?.toLowerCase().includes(q))
      ) ?? []
    );
  }, [clients, search]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="WORKSPACE"
        heading="Clients"
        description={
          <>{clients?.length ?? 0} clients &middot; Manage relationships and contacts.</>
        }
        actions={
          <Button size="lg" className="h-10 px-4" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            Add Client
          </Button>
        }
      />

      {/* Search */}
      <div className="relative max-w-xs">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search clients..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex h-10 w-full rounded-xl border border-border bg-card pl-9 pr-4 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {showCreate && <CreateClientForm onClose={() => setShowCreate(false)} />}

      {/* Client cards */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="border-border/60">
              <CardContent className="p-6">
                <Skeleton className="h-6 w-40 mb-2" />
                <Skeleton className="h-4 w-24 mb-4" />
                <Skeleton className="h-3 w-full mb-2" />
                <Skeleton className="h-3 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
          <Briefcase className="h-12 w-12 text-muted-foreground/20" />
          <h3 className="mt-4 font-display text-lg font-semibold text-foreground">
            {search ? 'No clients found' : 'No clients yet'}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {search ? 'Try a different search' : 'Add your first client to get started'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((client) => (
            <ClientCard key={client.id} client={client} isAdmin={isAdmin} />
          ))}
        </div>
      )}
    </div>
  );
}

const ClientCard = memo(function ClientCard({
  client,
  isAdmin,
}: {
  client: Client;
  isAdmin: boolean;
}) {
  const utils = trpc.useUtils();
  const prefetch = () => utils.clients.getById.prefetch({ id: client.id });
  const config = statusConfig[client.status] || statusConfig.ACTIVE;
  const primaryContact = client.contacts[0];

  return (
    <Link href={`/clients/${client.id}`} onMouseEnter={prefetch} onFocus={prefetch}>
      <Card className="group h-full border-border/60 transition-all duration-200 hover:border-border hover:shadow-lg hover:-translate-y-0.5 cursor-pointer">
        <CardContent className="p-6">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="min-w-0">
              <h3 className="font-display text-base font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                {client.name}
              </h3>
              {client.industry && (
                <p className="text-xs text-muted-foreground mt-0.5">{client.industry}</p>
              )}
            </div>
            <div
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium shrink-0',
                config.bg
              )}
            >
              <div className={cn('h-1.5 w-1.5 rounded-full', config.dot)} />
              {config.label}
            </div>
          </div>

          {/* Contact & location */}
          <div className="space-y-1.5 mb-4">
            {primaryContact && (
              <p className="text-sm text-muted-foreground truncate">
                {primaryContact.name} {primaryContact.role ? `· ${primaryContact.role}` : ''}
              </p>
            )}
            {client.location && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <MapPin className="h-3 w-3" /> {client.location}
              </p>
            )}
            {client.website && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Globe className="h-3 w-3" /> {client.website.replace(/^https?:\/\//, '')}
              </p>
            )}
          </div>

          {/* Stats footer */}
          <div className="flex items-center justify-between pt-3 border-t border-border/60">
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <FolderKanban className="h-3 w-3" />
                {client._count.projects}
              </span>
              {isAdmin && (
                <span className="flex items-center gap-1">
                  <FileText className="h-3 w-3" />
                  {client._count.invoices}
                </span>
              )}
              {isAdmin && client.totalRevenue.some(({ amount }) => amount > 0) && (
                <span className="font-semibold text-emerald-500">
                  {moneyListLabel(client.totalRevenue)}
                </span>
              )}
            </div>
            <ArrowUpRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-primary transition-all" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
});

function CreateClientForm({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const createClient = trpc.clients.create.useMutation({
    onSuccess: () => {
      utils.clients.getAll.invalidate();
      onClose();
    },
  });

  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [industry, setIndustry] = useState('');
  const [location, setLocation] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactRole, setContactRole] = useState('');

  const handleSubmit = () => {
    if (!name.trim()) return;
    createClient.mutate({
      name: name.trim(),
      website: website || undefined,
      industry: industry || undefined,
      location: location || undefined,
      contacts: contactName.trim()
        ? [
            {
              name: contactName.trim(),
              email: contactEmail || undefined,
              role: contactRole || undefined,
              isPrimary: true,
            },
          ]
        : [],
    });
  };

  return (
    <Card className="border-primary/20">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">New Client</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Company Name *</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Website</label>
            <input
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://example.com"
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Industry</label>
            <input
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="Technology, Finance..."
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Location</label>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="United States"
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>

        <div className="border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">
            Primary Contact (optional)
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Name"
              className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            <input
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="Email"
              className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            <input
              value={contactRole}
              onChange={(e) => setContactRole(e.target.value)}
              placeholder="Role (CEO, CTO...)"
              className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
          </div>
        </div>

        {/* UX-01: surface validation/mutation errors (e.g. invalid website URL). */}
        {createClient.error && <p className="text-xs text-red-500">{createClient.error.message}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || createClient.isPending}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-40 transition-colors"
          >
            {createClient.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Creating...
              </>
            ) : (
              'Create Client'
            )}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
