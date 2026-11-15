/**
 * CLIENTS domain — the assistant's tools for customers + their contacts.
 *
 * Mirrors `src/server/routers/clients.ts` (the source of truth): the same input
 * validation, the same authorization gate (create / update / delete / addContact
 * / deleteContact are ADMIN-only, exactly like `adminProcedure`), the same logic
 * and the same side effects (activity feed + the clientAdded notification).
 *
 * Read tools are role-scoped: a non-admin only sees a client if they are a member
 * of one of that client's projects (mirrors listClients / getClient in tools.ts);
 * invoice amounts are admin-only. Write tools are added to the toolset ONLY when
 * the acting user is an admin, AND are guarded again inside `execute` (belt +
 * braces). Every write sets `needsApproval: true` and records `h.audit`.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { appUrl, templates } from '@/lib/email';
import { matchScore, type AssistantHelpers, type ToolSet } from '@/lib/ai/context';

// True if a provided website isn't a full http(s) URL — mirrors the router's
// optionalWebsiteUrl write-boundary guard (blocks javascript:/data: schemes).
// Enforced in execute, never in the tool's input schema (a `format`/regex
// keyword in the schema would make Groq 400 the whole request).
const badWebsite = (url?: string | null): boolean =>
  !!url && url.trim() !== '' && !/^https?:\/\//i.test(url.trim());

export function buildClientsTools(h: AssistantHelpers): ToolSet {
  const { db } = h;
  const tools: ToolSet = {};

  // Non-admins may only see clients they touch through a shared project; admins
  // see everything (undefined predicate). Writes are admin-only, so for those
  // this resolves to `undefined` (all clients) anyway.
  const clientVisibility = (): Prisma.ClientWhereInput | undefined =>
    h.isAdmin ? undefined : { projects: { some: { members: { some: { userId: h.ctx.userId } } } } };

  // DEV-839: a visible client does not make all of its projects visible. Its
  // linked projects (and their count) follow the projects router's rule: admins
  // see all, everyone else only projects they are a member of.
  const projectVisibility = (): Prisma.ProjectWhereInput | undefined =>
    h.isAdmin ? undefined : { members: { some: { userId: h.ctx.userId } } };

  /** Resolve a free-text client name to one client the viewer can see. */
  const resolveClient = async (name: string) => {
    const clients = await db.client.findMany({
      where: clientVisibility(),
      select: { id: true, name: true },
    });
    return h.resolveNamed(name, clients);
  };

  // ─────────────────────────────────── READS ───────────────────────────────────

  tools.listClients = tool({
    description: 'List clients / customers (name, industry, location, status, project count).',
    inputSchema: z.object({
      query: z.string().nullish().describe('Optional name search'),
    }),
    execute: async ({ query }) => {
      const clients = await db.client.findMany({
        where: clientVisibility(),
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          industry: true,
          location: true,
          status: true,
          _count: { select: { projects: { where: projectVisibility() } } },
        },
      });
      const filtered = query ? clients.filter((c) => matchScore(query, c.name) > 0) : clients;
      return filtered.map((c) => ({
        id: c.id,
        name: c.name,
        industry: c.industry ?? null,
        location: c.location ?? null,
        status: c.status,
        projects: c._count.projects,
      }));
    },
  });

  tools.getClient = tool({
    description:
      'A deep dive on ONE client: industry, location, status, contacts, their projects, and an invoice summary (counts; amounts are admin-only). Use for "tell me about <client>", "<client> contacts", "what do we do for <client>". Give the client name.',
    inputSchema: z.object({
      name: z.string().describe('The client name (fuzzy match)'),
    }),
    execute: async ({ name }) => {
      const r = await resolveClient(name);
      if (r.kind === 'notfound')
        return { error: `No client matches "${name}"${h.isAdmin ? '' : ' that you can access'}.` };
      if (r.kind === 'ambiguous')
        return { needsClarification: `Which client — ${r.candidates.join(', ')}?` };

      const c = await db.client.findUnique({
        where: { id: r.value.id },
        select: {
          name: true,
          industry: true,
          location: true,
          website: true,
          status: true,
          notes: true,
          contacts: {
            select: { name: true, role: true, email: true, phone: true, isPrimary: true },
          },
          projects: { where: projectVisibility(), select: { name: true, status: true } },
          invoices: { select: { status: true, total: true } },
        },
      });
      if (!c) return { error: 'That client was not found.' };

      const outstanding = c.invoices.filter((i) => i.status === 'SENT' || i.status === 'OVERDUE');
      return {
        name: c.name,
        industry: c.industry,
        location: c.location,
        website: c.website,
        status: c.status,
        notes: c.notes,
        contacts: c.contacts.map((ct) => ({
          name: ct.name,
          role: ct.role,
          email: ct.email,
          phone: ct.phone,
          primary: ct.isPrimary,
        })),
        projects: c.projects,
        // Invoice existence + amounts are financial data → admin only (the
        // router hides invoices entirely from non-admins; mirror that).
        invoices: h.isAdmin
          ? {
              total: c.invoices.length,
              outstanding: outstanding.length,
              outstandingAmount: outstanding.reduce((s, i) => s + Number(i.total), 0),
            }
          : undefined,
        scopeNote: r.interpreted ? `Interpreted "${name}" as ${c.name}.` : undefined,
      };
    },
  });

  // ─────────────────────────────────── WRITES ──────────────────────────────────
  // ADMIN ONLY. Added to the toolset only when the acting user is an admin (so a
  // non-admin model literally cannot call them), and guarded again inside execute.

  if (h.isAdmin) {
    tools.createClient = tool({
      description:
        'Add a new client / customer to the hub (name, plus optional website, industry, location, timezone, notes, and initial contacts). ADMIN ONLY. Use for "add a client", "create a new customer", "onboard <company>". Other admins are notified.',
      inputSchema: z.object({
        name: z.string().min(1),
        website: z.string().nullish(),
        industry: z.string().nullish(),
        location: z.string().nullish(),
        timezone: z.string().nullish(),
        notes: z.string().nullish(),
        contacts: z
          .array(
            z.object({
              name: z.string().min(1),
              email: z.string().nullish(),
              phone: z.string().nullish(),
              role: z.string().nullish(),
              isPrimary: z.boolean().nullish(),
            })
          )
          .nullish()
          .describe('Optional initial contacts to create alongside the client'),
      }),
      needsApproval: true,
      execute: async ({ name, website, industry, location, timezone, notes, contacts }) => {
        if (!h.isAdmin) return { error: 'Only admins can add clients.' };
        // Write-boundary guard the router enforces via optionalWebsiteUrl: a
        // stored website must be a full http(s) URL (blocks javascript:/data:).
        // Done in execute, not the schema, so no `format` keyword reaches Groq.
        if (badWebsite(website)) return { error: 'Website must be a full http(s):// URL.' };

        const contactRows =
          contacts && contacts.length > 0
            ? contacts.map((ct) => ({
                name: ct.name,
                email: ct.email ?? null,
                phone: ct.phone ?? null,
                role: ct.role ?? null,
                isPrimary: ct.isPrimary ?? false,
              }))
            : [];

        const client = await db.client.create({
          data: {
            name,
            website: website ?? null,
            industry: industry ?? null,
            location: location ?? null,
            timezone: timezone ?? null,
            notes: notes ?? null,
            contacts: contactRows.length > 0 ? { create: contactRows } : undefined,
          },
        });

        // Side effects, mirroring clients.create + the clientAdded notification.
        h.activity({
          type: 'client_created',
          message: `added client ${client.name}`,
          entityType: 'Client',
          entityId: client.id,
        });
        h.audit({
          category: 'CLIENT',
          action: 'create',
          operation: 'CREATE',
          targetType: 'Client',
          targetId: client.id,
          targetLabel: client.name,
        });

        // Notify the OTHER admins a new client was added (in-app + email).
        const admins = await db.user.findMany({
          where: { role: 'ADMIN', status: { not: 'INACTIVE' }, id: { not: h.ctx.userId } },
          select: { id: true },
        });
        if (admins.length > 0) {
          h.notifyUsers(
            admins.map((a) => a.id),
            {
              type: 'client_created',
              title: 'New client added',
              message: `${h.ctx.name ?? 'An administrator'} added client ${client.name}.`,
              entityType: 'Client',
              entityId: client.id,
              email: (recipient) =>
                templates.clientAdded({
                  recipientName: recipient.name,
                  clientName: client.name,
                  addedByName: h.ctx.name ?? 'An administrator',
                  industry: client.industry ?? undefined,
                  url: `${appUrl()}/clients/${client.id}`,
                }),
            }
          );
        }

        return { id: client.id, name: client.name };
      },
    });

    tools.updateClient = tool({
      description:
        'Update an existing client (found by name): rename it, change its website / industry / location / timezone / notes, or set its status (ACTIVE / INACTIVE / PROSPECT). ADMIN ONLY. Use for "mark <client> as inactive", "update <client>\'s industry", "rename <client> to <new name>". Give the client name plus the fields to change.',
      inputSchema: z.object({
        name: z.string().describe('The client to update (fuzzy name match)'),
        newName: z.string().min(1).nullish().describe('Rename the client to this'),
        website: z.string().nullish(),
        industry: z.string().nullish(),
        location: z.string().nullish(),
        timezone: z.string().nullish(),
        notes: z.string().nullish(),
        status: z.enum(['ACTIVE', 'INACTIVE', 'PROSPECT']).nullish(),
      }),
      needsApproval: true,
      execute: async ({ name, newName, website, industry, location, timezone, notes, status }) => {
        if (!h.isAdmin) return { error: 'Only admins can update clients.' };
        if (badWebsite(website)) return { error: 'Website must be a full http(s):// URL.' };

        const r = await resolveClient(name);
        if (r.kind === 'notfound') return { error: `No client matches "${name}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which client — ${r.candidates.join(', ')}?` };

        const existing = await db.client.findUnique({
          where: { id: r.value.id },
          select: {
            name: true,
            website: true,
            industry: true,
            location: true,
            timezone: true,
            notes: true,
            status: true,
          },
        });
        if (!existing) return { error: 'That client was not found.' };

        // Only fields actually supplied (non-null) are applied — under the
        // .nullish() convention a `null` means "left out", not "clear it".
        const data: Prisma.ClientUpdateInput = {};
        const changes: Record<string, { before: unknown; after: unknown }> = {};
        const set = <K extends keyof typeof existing>(
          field: K,
          value: (typeof existing)[K] | null | undefined
        ) => {
          if (value == null || value === existing[field]) return;
          (data as Record<string, unknown>)[field as string] = value;
          changes[field as string] = { before: existing[field], after: value };
        };
        set('name', newName ?? null);
        set('website', website ?? null);
        set('industry', industry ?? null);
        set('location', location ?? null);
        set('timezone', timezone ?? null);
        set('notes', notes ?? null);
        set('status', status ?? null);

        if (Object.keys(data).length === 0) {
          return { error: 'Nothing to update — provide at least one field to change.' };
        }

        const updated = await db.client.update({ where: { id: r.value.id }, data });
        h.audit({
          category: 'CLIENT',
          action: 'update',
          operation: 'UPDATE',
          targetType: 'Client',
          targetId: updated.id,
          targetLabel: updated.name,
          changes,
        });

        return {
          name: updated.name,
          status: updated.status,
          updated: Object.keys(changes),
          scopeNote: r.interpreted ? `Interpreted "${name}" as ${existing.name}.` : undefined,
        };
      },
    });

    tools.deleteClient = tool({
      description:
        'Delete a client from the hub (found by name). Also removes its contacts. ADMIN ONLY. Use for "remove <client>", "delete the client <name>". Destructive — the user is asked to approve first.',
      inputSchema: z.object({
        name: z.string().describe('The client to delete (fuzzy name match)'),
      }),
      needsApproval: true,
      execute: async ({ name }) => {
        if (!h.isAdmin) return { error: 'Only admins can delete clients.' };

        const r = await resolveClient(name);
        if (r.kind === 'notfound') return { error: `No client matches "${name}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which client — ${r.candidates.join(', ')}?` };

        const client = await db.client.findUnique({
          where: { id: r.value.id },
          select: { name: true },
        });
        await db.client.delete({ where: { id: r.value.id } });

        if (client) {
          h.activity({
            type: 'client_deleted',
            message: `deleted client ${client.name}`,
          });
        }
        h.audit({
          category: 'CLIENT',
          action: 'delete',
          operation: 'DELETE',
          targetType: 'Client',
          targetId: r.value.id,
          targetLabel: client?.name ?? r.value.name,
        });

        return {
          deleted: client?.name ?? r.value.name,
          scopeNote: r.interpreted ? `Interpreted "${name}" as ${r.value.name}.` : undefined,
        };
      },
    });

    tools.addClientContact = tool({
      description:
        'Add a contact person to a client (name, plus optional role, email, phone, and whether they are the primary contact). ADMIN ONLY. Use for "add a contact to <client>", "<name> is the new point of contact at <client>". Give the client name and the contact details.',
      inputSchema: z.object({
        clientName: z.string().describe('The client to add the contact to (fuzzy name match)'),
        name: z.string().min(1).describe("The contact person's name"),
        role: z.string().nullish().describe('Their role / title, e.g. "CTO"'),
        email: z.string().nullish(),
        phone: z.string().nullish(),
        isPrimary: z.boolean().nullish().describe('Whether this is the primary contact'),
      }),
      needsApproval: true,
      execute: async ({ clientName, name, role, email, phone, isPrimary }) => {
        if (!h.isAdmin) return { error: 'Only admins can add client contacts.' };

        const r = await resolveClient(clientName);
        if (r.kind === 'notfound') return { error: `No client matches "${clientName}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which client — ${r.candidates.join(', ')}?` };

        const contact = await db.clientContact.create({
          data: {
            clientId: r.value.id,
            name,
            email: email ?? null,
            phone: phone ?? null,
            role: role ?? null,
            isPrimary: isPrimary ?? false,
          },
        });
        h.audit({
          category: 'CLIENT',
          action: 'addContact',
          operation: 'CREATE',
          targetType: 'ClientContact',
          targetId: contact.id,
          targetLabel: contact.name,
          metadata: { clientId: r.value.id, clientName: r.value.name },
        });

        return {
          client: r.value.name,
          contact: { name: contact.name, role: contact.role, primary: contact.isPrimary },
          scopeNote: r.interpreted ? `Interpreted "${clientName}" as ${r.value.name}.` : undefined,
        };
      },
    });

    tools.deleteClientContact = tool({
      description:
        'Remove a contact from a client, identified by the client name and the contact\'s name. ADMIN ONLY. Use for "remove <contact> from <client>", "delete <client>\'s contact <name>".',
      inputSchema: z.object({
        clientName: z.string().describe('The client the contact belongs to (fuzzy name match)'),
        contactName: z.string().describe('The contact to remove (fuzzy name match)'),
      }),
      needsApproval: true,
      execute: async ({ clientName, contactName }) => {
        if (!h.isAdmin) return { error: 'Only admins can delete client contacts.' };

        const r = await resolveClient(clientName);
        if (r.kind === 'notfound') return { error: `No client matches "${clientName}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which client — ${r.candidates.join(', ')}?` };

        const contacts = await db.clientContact.findMany({
          where: { clientId: r.value.id },
          select: { id: true, name: true },
        });
        if (contacts.length === 0) return { error: `${r.value.name} has no contacts to remove.` };

        const cr = h.resolveNamed(contactName, contacts);
        if (cr.kind === 'notfound')
          return { error: `No contact matches "${contactName}" at ${r.value.name}.` };
        if (cr.kind === 'ambiguous')
          return { needsClarification: `Which contact — ${cr.candidates.join(', ')}?` };

        await db.clientContact.delete({ where: { id: cr.value.id } });
        h.audit({
          category: 'CLIENT',
          action: 'deleteContact',
          operation: 'DELETE',
          targetType: 'ClientContact',
          targetId: cr.value.id,
          targetLabel: cr.value.name,
          metadata: { clientId: r.value.id, clientName: r.value.name },
        });

        return {
          client: r.value.name,
          removedContact: cr.value.name,
          scopeNote:
            r.interpreted || cr.interpreted
              ? `Interpreted contact "${contactName}" at "${clientName}" as ${cr.value.name} / ${r.value.name}.`
              : undefined,
        };
      },
    });
  }

  return tools;
}
