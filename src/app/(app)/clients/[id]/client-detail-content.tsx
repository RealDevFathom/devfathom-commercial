'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
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
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { NotesContent } from '@/app/(app)/notes/notes-content';

const statusConfig: Record<string, { bg: string; dot: string; label: string }> = {
  ACTIVE: { bg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500', label: 'Active' },
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
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const updateClient = trpc.clients.update.useMutation({
    onSuccess: () => { utils.clients.getById.invalidate({ id: clientId }); setIsEditing(false); },
  });
  const deleteClient = trpc.clients.delete.useMutation({
    onSuccess: () => router.push('/clients'),
  });

  if (isLoading) {
    return (
      <div className="space-y-6 animate-fade-in">
        <Skeleton className="h-4 w-28 mb-4" />
        <Skeleton className="h-9 w-48 mb-2" />
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-10 w-96" />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2 border-border/60"><CardContent className="p-6"><Skeleton className="h-32 w-full" /></CardContent></Card>
          <Card className="border-border/60"><CardContent className="p-6"><Skeleton className="h-32 w-full" /></CardContent></Card>
        </div>
      </div>
    );
  }

  if (!client) {
    return (
      <div className="flex flex-col items-center justify-center py-32">
        <Briefcase className="h-16 w-16 text-muted-foreground/20" />
        <h2 className="mt-4 font-display text-xl font-semibold text-foreground">Client not found</h2>
        <Link href="/clients" className="mt-6 text-sm font-medium text-[#FF4C29] hover:underline">Back to Clients</Link>
      </div>
    );
  }

  const config = statusConfig[client.status] || statusConfig.ACTIVE;
  const totalRevenue = client.invoices.filter((i) => i.status === 'PAID').reduce((sum, i) => sum + Number(i.total), 0);
  const outstandingAmount = client.invoices.filter((i) => ['SENT', 'OVERDUE'].includes(i.status)).reduce((sum, i) => sum + Number(i.total), 0);

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <Link href="/clients" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4">
          <ArrowLeft className="h-4 w-4" /> Back to Clients
        </Link>

        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">{client.name}</h1>
              <div className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium', config.bg)}>
                <div className={cn('h-1.5 w-1.5 rounded-full', config.dot)} />
                {config.label}
              </div>
            </div>
            <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
              {client.industry && <span>{client.industry}</span>}
              {client.location && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{client.location}</span>}
              {client.website && (
                <a href={client.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[#FF4C29] hover:underline">
                  <Globe className="h-3 w-3" />{client.website.replace(/^https?:\/\//, '')}
                </a>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { if (!isEditing) { setEditName(client.name); setEditWebsite(client.website || ''); setEditIndustry(client.industry || ''); setEditLocation(client.location || ''); setEditNotes(client.notes || ''); } setIsEditing(!isEditing); }}
              className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </button>
            {!showDeleteConfirm ? (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-muted-foreground hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/20 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => deleteClient.mutate({ id: clientId })}
                  disabled={deleteClient.isPending}
                  className="rounded-xl bg-red-500 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
                >
                  {deleteClient.isPending ? 'Deleting...' : 'Confirm Delete'}
                </button>
                <button onClick={() => setShowDeleteConfirm(false)} className="rounded-xl px-2 py-2 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Edit form */}
      {isEditing && (
        <Card className="border-[#FF4C29]/20">
          <CardContent className="p-5 space-y-4">
            <h3 className="text-sm font-semibold text-foreground">Edit Client</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Name</label>
                <input value={editName} onChange={(e) => setEditName(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20" />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Website</label>
                <input value={editWebsite} onChange={(e) => setEditWebsite(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20" />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Industry</label>
                <input value={editIndustry} onChange={(e) => setEditIndustry(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20" />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Location</label>
                <input value={editLocation} onChange={(e) => setEditLocation(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Notes</label>
              <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows={2}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground resize-none focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20" />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setIsEditing(false)} className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
              <button
                onClick={() => updateClient.mutate({
                  id: clientId,
                  name: editName.trim() || undefined,
                  website: editWebsite || null,
                  industry: editIndustry || null,
                  location: editLocation || null,
                  notes: editNotes || null,
                })}
                disabled={updateClient.isPending}
                className="flex items-center gap-1.5 rounded-xl bg-[#FF4C29] px-4 py-2 text-xs font-semibold text-white hover:bg-[#E63E1C] disabled:opacity-40 transition-colors"
              >
                {updateClient.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
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
          {isAdmin && <TabsTrigger value="invoices">Invoices ({client.invoices.length})</TabsTrigger>}
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="contacts">Contacts ({client.contacts.length})</TabsTrigger>
        </TabsList>

        {/* OVERVIEW */}
        <TabsContent value="overview" className="space-y-5">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2 border-border/60">
              <CardHeader className="pb-3"><CardTitle className="text-[15px] font-semibold text-foreground">Details</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {client.notes && <p className="text-sm text-muted-foreground leading-relaxed">{client.notes}</p>}
                <div className="grid grid-cols-2 gap-4 pt-2">
                  {client.timezone && <div><p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Timezone</p><p className="text-sm font-medium text-foreground flex items-center gap-1"><ClockIcon className="h-3 w-3" />{client.timezone}</p></div>}
                  <div><p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Projects</p><p className="text-sm font-medium text-foreground">{client.projects.length}</p></div>
                  {isAdmin && (
                    <>
                      <div><p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Total Revenue</p><p className="text-sm font-bold text-emerald-500">${totalRevenue.toLocaleString()}</p></div>
                      <div><p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Outstanding</p><p className={cn('text-sm font-bold', outstandingAmount > 0 ? 'text-amber-500' : 'text-muted-foreground')}>${outstandingAmount.toLocaleString()}</p></div>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Primary contact */}
            <Card className="border-border/60">
              <CardHeader className="pb-3"><CardTitle className="text-[15px] font-semibold text-foreground">Primary Contact</CardTitle></CardHeader>
              <CardContent>
                {client.contacts.length > 0 ? (
                  <div className="space-y-3">
                    <p className="text-base font-semibold text-foreground">{client.contacts[0].name}</p>
                    {client.contacts[0].role && <p className="text-sm text-muted-foreground">{client.contacts[0].role}</p>}
                    {client.contacts[0].email && <p className="text-sm text-muted-foreground flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" />{client.contacts[0].email}</p>}
                    {client.contacts[0].phone && <p className="text-sm text-muted-foreground flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" />{client.contacts[0].phone}</p>}
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
          <ClientProjectsTab clientId={clientId} clientName={client.name} projects={client.projects} />
        </TabsContent>

        {/* INVOICES — admin only */}
        {isAdmin && (
        <TabsContent value="invoices">
          {client.invoices.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
              <FileText className="h-12 w-12 text-muted-foreground/20" />
              <h3 className="mt-4 font-display text-lg font-semibold text-foreground">No invoices</h3>
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
                          <p className="text-sm font-semibold text-foreground font-mono">{inv.invoiceNumber}</p>
                          <p className="text-xs text-muted-foreground">{inv.project?.name || '—'} &middot; {format(new Date(inv.dueDate), 'MMM d, yyyy')}</p>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="text-sm font-semibold text-foreground tabular-nums">${Number(inv.total).toLocaleString()}</span>
                          <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium', ic.bg)}>{ic.label}</span>
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

        {/* NOTES */}
        <TabsContent value="notes">
          <NotesContent clientId={clientId} embedded />
        </TabsContent>

        {/* CONTACTS */}
        <TabsContent value="contacts">
          {client.contacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
              <User className="h-12 w-12 text-muted-foreground/20" />
              <h3 className="mt-4 font-display text-lg font-semibold text-foreground">No contacts</h3>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {client.contacts.map((contact) => (
                <Card key={contact.id} className="border-border/60">
                  <CardContent className="p-5">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#FF4C29]/10 text-[#FF4C29] font-semibold text-sm">
                        {contact.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{contact.name}</p>
                        {contact.role && <p className="text-xs text-muted-foreground">{contact.role}</p>}
                      </div>
                      {contact.isPrimary && <span className="ml-auto rounded-md bg-[#FF4C29]/10 px-2 py-0.5 text-[10px] font-medium text-[#FF4C29]">Primary</span>}
                    </div>
                    {contact.email && <p className="text-xs text-muted-foreground flex items-center gap-1.5 mb-1"><Mail className="h-3 w-3" />{contact.email}</p>}
                    {contact.phone && <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Phone className="h-3 w-3" />{contact.phone}</p>}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ============================================
   Client Projects Tab — with create project
   ============================================ */
function ClientProjectsTab({ clientId, clientName, projects }: {
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
    ACTIVE: { bg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' },
    IN_DEVELOPMENT: { bg: 'bg-blue-500/10 text-blue-500', dot: 'bg-blue-500' },
    ON_HOLD: { bg: 'bg-amber-500/10 text-amber-500', dot: 'bg-amber-500' },
    COMPLETED: { bg: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' },
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{projects.length} project{projects.length !== 1 ? 's' : ''} for {clientName}</p>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 rounded-xl bg-[#FF4C29] px-3.5 py-2 text-xs font-semibold text-white transition-all hover:bg-[#E63E1C] hover:shadow-[0_0_20px_-5px_rgba(255,76,41,0.4)] active:scale-[0.98]"
        >
          <Plus className="h-3.5 w-3.5" />
          New Project
        </button>
      </div>

      {/* Create project form */}
      {showCreate && (
        <Card className="border-[#FF4C29]/20">
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">New Project for {clientName}</h3>
              <button onClick={() => setShowCreate(false)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Project Name *</label>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) handleSubmit(); }}
                placeholder={`e.g. ${clientName} Platform`}
                className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20" />
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Brief description..."
                className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20" />
            </div>

            {/* Team members */}
            {team && team.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">Team Members</label>
                <div className="flex flex-wrap gap-1.5">
                  {team.map((member) => (
                    <button
                      key={member.id}
                      onClick={() => setSelectedMembers((prev) => prev.includes(member.id) ? prev.filter((m) => m !== member.id) : [...prev, member.id])}
                      className={cn(
                        'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                        selectedMembers.includes(member.id)
                          ? 'bg-[#FF4C29]/10 text-[#FF4C29] ring-1 ring-[#FF4C29]/20'
                          : 'bg-secondary text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <Avatar className="h-4 w-4">
                        <AvatarImage src={member.avatar ?? undefined} />
                        <AvatarFallback className="text-[7px] bg-muted font-medium">{member.name[0]}</AvatarFallback>
                      </Avatar>
                      {member.name.split(' ')[0]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setShowCreate(false)} className="rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
              <button onClick={handleSubmit} disabled={!name.trim() || createProject.isPending}
                className="flex items-center gap-1.5 rounded-xl bg-[#FF4C29] px-4 py-2 text-xs font-semibold text-white hover:bg-[#E63E1C] disabled:opacity-40 transition-colors">
                {createProject.isPending ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Creating...</> : 'Create Project'}
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
          <p className="mt-1 text-sm text-muted-foreground">Create a project for this client to get started</p>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-4 flex items-center gap-1.5 rounded-xl bg-[#FF4C29] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#E63E1C] active:scale-[0.98] transition-all"
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
                      <h3 className="text-sm font-semibold text-foreground truncate group-hover:text-[#FF4C29] transition-colors">{project.name}</h3>
                      <div className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0', pc.bg)}>
                        <div className={cn('h-1 w-1 rounded-full', pc.dot)} />
                        {project.status.replace('_', ' ')}
                      </div>
                    </div>
                    <div className="flex -space-x-1.5 mt-4">
                      {project.members.slice(0, 4).map((m) => (
                        <Avatar key={m.user.id} className="h-6 w-6 border-2 border-card">
                          <AvatarImage src={m.user.avatar ?? undefined} />
                          <AvatarFallback className="text-[9px] bg-secondary font-medium">{m.user.name[0]}</AvatarFallback>
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
