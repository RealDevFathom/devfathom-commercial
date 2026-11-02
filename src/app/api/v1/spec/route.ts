import { NextResponse } from 'next/server';
import { authenticateApiRequest } from '@/lib/api-auth';
import { publicRequestOrigin } from '@/lib/http-origin';
import { recordRestAudit } from '@/server/audit';

/**
 * GET /api/v1/spec
 *
 * Returns the full DevFathom REST API reference as a markdown document
 * optimized for LLM agents (Claude Code, Cursor, etc.). Token-gated — any
 * valid Bearer token grants access regardless of scope, since reading the
 * spec doesn't expose any data.
 *
 * Hand the URL of this endpoint + a token to your AI agent and it has
 * everything it needs to operate the hub on behalf of the bound user.
 */
export async function GET(request: Request) {
  // Any valid token works — we don't enforce a scope here. The actual
  // endpoint calls the agent makes will still be scope-checked individually.
  // REST-02: this route bypasses withApiAuth, so record the audit manually —
  // reads of the full API map (and 401 attempts) must leave an audit trail.
  const start = Date.now();
  const auth = await authenticateApiRequest(request);
  if (auth instanceof NextResponse) {
    recordRestAudit({
      request,
      ctx: null,
      scope: 'spec:read',
      status: auth.status,
      durationMs: Date.now() - start,
    });
    return auth;
  }

  const baseUrl = publicRequestOrigin(request);
  const md = buildSpec(baseUrl);

  recordRestAudit({
    request,
    ctx: auth,
    scope: 'spec:read',
    status: 200,
    durationMs: Date.now() - start,
  });

  return new NextResponse(md, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      // Don't cache — markdown is generated per-request and includes the
      // exact base URL of the host serving it
      'Cache-Control': 'private, no-store',
    },
  });
}

function buildSpec(baseUrl: string): string {
  return `# DevFathom API — Full Reference

> Auto-generated machine-readable API spec. This document contains everything
> you need to operate DevFathom via REST. If you are an AI coding agent (Claude
> Code, Cursor, etc.), use this as your single source of truth.

**Base URL:** \`${baseUrl}/api/v1\`
**Auth:** Every request must include \`Authorization: Bearer <token>\`
**Spec:** \`${baseUrl}/api/v1/spec\` (this document)

---

## How attribution works

Tokens are bound to a specific user when issued. Every change you make is
logged to the activity feed and counted in stats **as the user the token
represents** — not as the admin who created the token. So if Shehroz's token
creates a task, the dashboard says "Shehroz created task X", and it counts
toward Shehroz's "tasks created this week" stat.

## Response shape

Successful responses:
\`\`\`json
{ "data": { ... } }   // single resource
{ "data": [ ... ] }   // collection
{ "success": true }   // mutation with no resource to return
\`\`\`

Errors:
\`\`\`json
{ "error": "message", "details"?: [...] }
\`\`\`

HTTP status codes: \`200\` ok, \`201\` created, \`400\` validation, \`401\` auth,
\`403\` forbidden (insufficient scope), \`404\` not found, \`500\` server error.

## Scopes

Each endpoint requires a scope. Tokens are issued with one or more scopes.
\`*\` is the wildcard and grants everything. \`resource:write\` implicitly
grants \`resource:read\` on the same resource.

| Scope | What it allows |
|---|---|
| \`*\` | Full access |
| \`tasks:read\` | Read tasks, boards, comments |
| \`tasks:write\` | Create / update / delete tasks, add comments |
| \`projects:read\` | Read projects |
| \`projects:write\` | Create / update projects |
| \`clients:read\` | Read clients |
| \`clients:write\` | Create / update clients |
| \`team:read\` | Read team directory |
| \`finance:read\` | Read invoices and transactions (admin-bound tokens only) |
| \`finance:write\` | Create / update invoices and transactions (admin-bound tokens only) |
| \`meetings:read\` | Read meetings |
| \`meetings:write\` | Create / update meetings |

## How to find common IDs

Most write endpoints take cuid-style IDs (\`cl...\` or \`cm...\`). To discover them:

- **My user ID** → \`GET /team\` then filter by name or email
- **Project ID** → \`GET /projects\`
- **Board ID** → \`GET /projects/:id\` (returns boards array)
- **Column ID** → \`GET /boards/:id\` (returns columns with full task data)
- **Task ID** → \`GET /tasks?columnId=...\` or \`GET /boards/:id\`
- **Client ID** → \`GET /clients\`

---

# Endpoints

## Tasks

### \`GET /tasks\`
List tasks. Returns up to 50 by default.

- **Scope:** \`tasks:read\`
- **Query params:**
  - \`columnId?: string\` — filter to one column
  - \`assigneeId?: string\` — filter to tasks assigned to this user
  - \`priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'\`
  - \`limit?: number\` — max 100
- **Response:** \`{ data: Task[] }\` where each task includes \`column\`, \`assignees\`, \`labels\`

### \`POST /tasks\`
Create a new task. The column's default assignees are auto-added in addition to any explicit \`assigneeIds\`.

- **Scope:** \`tasks:write\`
- **Body:**
  \`\`\`json
  {
    "title": "string (required)",
    "columnId": "string (required)",
    "description": "string (optional)",
    "priority": "LOW | MEDIUM | HIGH | URGENT (default MEDIUM)",
    "dueDate": "ISO 8601 datetime (optional)",
    "assigneeIds": ["userId", ...],
    "labelIds": ["labelId", ...]
  }
  \`\`\`
- **Response:** \`{ data: Task }\` (201 Created)
- **Side effects:** logs \`task_created\` activity

### \`GET /tasks/:id\`
Get full task with comments, checklists, labels, assignees.

- **Scope:** \`tasks:read\`
- **Response:** \`{ data: Task }\` with deeply-included relations

### \`PATCH /tasks/:id\`
Update a task. Setting \`columnId\` triggers a proper column move — reorders both source and target columns and adds the target column's default assignees (additive, idempotent). If the move enters the "Done" column, logs \`task_completed\`.

- **Scope:** \`tasks:write\`
- **Body (all fields optional):**
  \`\`\`json
  {
    "title": "string",
    "description": "string | null",
    "priority": "LOW | MEDIUM | HIGH | URGENT",
    "dueDate": "ISO 8601 datetime | null",
    "columnId": "string",

    // Three flavors of assignee operations — pick ONE pattern:
    "assigneeIds": ["userId"],         // REPLACE the entire assignee list
    "addAssigneeIds": ["userId"],      // ADD only (keeps existing, dedupes)
    "removeAssigneeIds": ["userId"]    // REMOVE only
  }
  \`\`\`
- **Constraint:** \`assigneeIds\` (full replace) cannot be combined with \`addAssigneeIds\` / \`removeAssigneeIds\`. The two partial ops can be combined for swap-style updates.
- **Response:** \`{ data: Task }\`

### \`DELETE /tasks/:id\`
Delete a task. Cascades to comments and checklists.

- **Scope:** \`tasks:write\`
- **Response:** \`{ success: true }\`

### \`GET /tasks/:id/comments\`
List comments on a task (top-level + threaded replies).

- **Scope:** \`tasks:read\`
- **Response:** \`{ data: Comment[] }\` where each comment has \`user\` and \`replies\`

### \`POST /tasks/:id/comments\`
Add a comment to a task. The comment author is the user the token is bound to.

- **Scope:** \`tasks:write\`
- **Body:**
  \`\`\`json
  {
    "content": "string (1-10000 chars, required)",
    "parentId": "string (optional, for threaded replies)"
  }
  \`\`\`
- **Response:** \`{ data: Comment }\` (201 Created)

---

## Projects

### \`GET /projects\`
List all projects with members and counts.

- **Scope:** \`projects:read\`
- **Response:** \`{ data: Project[] }\`

### \`POST /projects\`
Create a project. Auto-creates a default Kanban board with columns: Backlog, To Do, In Progress, Review, Done.

- **Scope:** \`projects:write\`
- **Body:**
  \`\`\`json
  {
    "name": "string (required)",
    "type": "CLIENT | INTERNAL (required)",
    "description": "string",
    "status": "ACTIVE | IN_DEVELOPMENT | ON_HOLD | COMPLETED (default ACTIVE)",
    "clientId": "string (optional, for CLIENT type)",
    "startDate": "ISO 8601 datetime",
    "endDate": "ISO 8601 datetime",
    "techStack": ["string"],
    "memberIds": ["userId"]
  }
  \`\`\`
- **Response:** \`{ data: Project }\` (201)
- **Side effects:** logs \`project_created\` activity

### \`GET /projects/:id\`
Get project with boards, milestones, and members.

- **Scope:** \`projects:read\`
- **Response:** \`{ data: Project }\` with included \`client\`, \`members\`, \`boards\`, \`milestones\`

### \`DELETE /projects/:id\`
Delete a project and all its boards/tasks (cascades).

- **Scope:** \`projects:write\`
- **Response:** \`{ success: true }\`

### \`GET /boards/:id\`
Get a board with all columns, tasks, labels, and column default assignees.

- **Scope:** \`tasks:read\`
- **Response:** \`{ data: Board }\` deeply nested

---

## Clients

### \`GET /clients\`
List all clients.

- **Scope:** \`clients:read\`
- **Response:** \`{ data: Client[] }\` with primary contact

### \`POST /clients\`
Create a client.

- **Scope:** \`clients:write\`
- **Body:**
  \`\`\`json
  {
    "name": "string (required)",
    "website": "string",
    "industry": "string",
    "location": "string",
    "notes": "string"
  }
  \`\`\`
- **Response:** \`{ data: Client }\` (201)
- **Side effects:** logs \`client_created\` activity

### \`GET /clients/:id\`
Get client with contacts, projects, invoices, documents.

- **Scope:** \`clients:read\`

### \`DELETE /clients/:id\`
Delete a client.

- **Scope:** \`clients:write\`
- **Response:** \`{ success: true }\`

---

## Team

### \`GET /team\`
List all active team members. Use this to look up user IDs for assignee operations.

- **Scope:** \`team:read\`
- **Response:** \`{ data: User[] }\` where each User has \`id\`, \`name\`, \`email\`, \`role\`, \`title\`, \`avatar\`

---

## Meetings

### \`GET /meetings\`
List the current user's meetings (where the token's user is an attendee). Returns up to 50 by default, oldest \`startTime\` first.

- **Scope:** \`meetings:read\`
- **Query params:**
  - \`limit?: number\` — max 100. Omitted, non-numeric or \`0\` falls back to 50; anything lower than 1 is raised to 1; anything above 100 is capped at 100.
- **Ordering:** \`startTime\` ascending, then \`id\` ascending. The \`id\` tiebreaker makes the order total, so meetings that share a \`startTime\` come back in the same order on every call.
- **Response:** \`{ data: Meeting[] }\` where each meeting includes \`attendees\`

### \`POST /meetings\`
Schedule a meeting. The token's user is auto-added as an attendee.

- **Scope:** \`meetings:write\`
- **Body:**
  \`\`\`json
  {
    "title": "string (required)",
    "startTime": "ISO 8601 (required)",
    "endTime": "ISO 8601 (required)",
    "description": "string",
    "location": "string (URL or room name)",
    "recurrence": "daily | weekly | biweekly | monthly | null",
    "attendeeIds": ["userId"]
  }
  \`\`\`
- **Validation:** \`endTime\` must be strictly after \`startTime\`. An end at or before the start is rejected with 400 and \`{ error, details: [{ path: ["endTime"], message }] }\`.
- **Response:** \`{ data: Meeting }\` (201)

---

## Finance (admin-bound tokens only)

### \`GET /transactions\`
List income/expense transactions.

- **Scope:** \`finance:read\`
- **Query:** \`type\`, \`startDate\`, \`endDate\`, \`category\`, \`limit\`

### \`POST /transactions\`
Create a transaction.

- **Scope:** \`finance:write\`
- **Body:**
  \`\`\`json
  {
    "type": "INCOME | EXPENSE (required)",
    "amount": "number (required)",
    "description": "string (required)",
    "date": "ISO 8601 (required)",
    "category": "SALARIES | SUBSCRIPTIONS | OFFICE | MARKETING | HOSTING | SOFTWARE | HARDWARE | TRAVEL | UTILITIES | MISCELLANEOUS",
    "currency": "USD | PKR (default USD)",
    "projectId": "string",
    "clientId": "string"
  }
  \`\`\`

### \`PATCH /transactions/:id\` / \`DELETE /transactions/:id\`
Update or delete a transaction. \`finance:write\`.

### \`GET /invoices\`
List invoices. \`finance:read\`. Query params: \`status\`, \`clientId\`.

### \`POST /invoices\`
Create an invoice. \`finance:write\`. Logs \`invoice_created\`.

\`\`\`json
{
  "clientId": "string (required)",
  "items": [
    { "description": "string", "quantity": 1, "rate": 100 }
  ],
  "discount": 0,
  "tax": 0,
  "currency": "USD | PKR",
  "dueDate": "ISO 8601 (required)",
  "projectId": "string",
  "notes": "string"
}
\`\`\`

\`discount\` and \`tax\` are amounts in the invoice currency (not percentages), default 0. The
server derives every figure: each line \`amount\` = quantity × rate rounded to cents, \`subtotal\` =
the sum of those line amounts, \`total\` = subtotal − discount + tax. A line \`amount\`, \`subtotal\`
or \`total\` in the body is ignored. A negative value or a discount above the subtotal is a 400.

### \`GET /invoices/:id\` / \`PATCH /invoices/:id\`
Get or update invoice status. \`finance:read\` / \`finance:write\`.
GET also returns \`issuer: { "name", "address", "taxId" }\` — the token's own workspace as the
seller (its legal name, invoice address and tax ID; an unset address or tax ID is \`null\`).
PATCH body: \`{ "status": "DRAFT | SENT | OVERDUE | CANCELLED" }\`.
The PATCH endpoint enforces valid status transitions and logs \`invoice_sent\` activity. To mark an
invoice PAID, record its payment through the mark-paid workflow instead.

### \`GET /finance/summary\`
Get monthly + yearly income, expenses, profit, and outstanding invoice totals.

- **Scope:** \`finance:read\`
- **Response:** \`{ data: { monthly: {...}, yearly: {...}, ... } }\`

---

# Common workflows

## "Show me my open tickets"
\`\`\`
1. GET /team             → find your user ID by name
2. GET /tasks?assigneeId=<your-id>
3. Filter client-side for column.name != "Done"
\`\`\`

## "Create a high-priority task in WXW Delivery's TODO column"
\`\`\`
1. GET /projects                 → find WXW Delivery, grab projectId
2. GET /projects/:projectId      → grab boardId from boards[0]
3. GET /boards/:boardId          → grab columnId where name == "TODO"
4. POST /tasks { title, columnId, priority: "HIGH" }
\`\`\`

## "Move my task to Dev Done"
\`\`\`
1. GET /tasks/:id                → confirm current column
2. GET /boards/:boardId          → find target columnId
3. PATCH /tasks/:id { columnId: <devDoneId> }
   → server reorders, applies column owners additively, logs task_completed if Done
\`\`\`

## "Add Bakar to task X without removing existing assignees"
\`\`\`
1. GET /team → find Bakar's userId
2. PATCH /tasks/X { addAssigneeIds: ["<bakar-id>"] }
\`\`\`

## "Comment on a task"
\`\`\`
POST /tasks/:id/comments { content: "Deploying the fix now" }
\`\`\`

## "What changed today?"
The activity feed isn't directly exposed via REST yet. Use the dashboard at
${baseUrl}/dashboard to see the live feed.

---

# Activity attribution

When you call write endpoints, the server logs an activity row attributed to
the token's bound user. These show up on the dashboard activity feed and feed
into the team stats page. The following operations are tracked:

| Endpoint | Activity type |
|---|---|
| \`POST /tasks\` | \`task_created\` |
| \`PATCH /tasks/:id\` (move into Done) | \`task_completed\` |
| \`POST /projects\` | \`project_created\` |
| \`POST /clients\` | \`client_created\` |
| \`POST /invoices\` | \`invoice_created\` |
| \`PATCH /invoices/:id\` (status → SENT) | \`invoice_sent\` |

Comments are tracked separately in stats (counted under "comments this week" on
the team insights page) but don't generate dashboard activity rows.

---

# Security notes

- **Never commit tokens.** Treat them like passwords. Store in env vars or a secrets manager.
- **Tokens are one-shot displayed.** When created, the full token is shown once. After that, only the prefix is visible.
- **Revocation is immediate.** Admins can revoke any token from Settings → API Tokens; the next request fails with 401.
- **No IP allowlist.** Tokens work from any network. Treat them with care.
- **Scopes are enforced server-side.** Even if you spoof a request body, the scope check happens on the server.
`;
}
