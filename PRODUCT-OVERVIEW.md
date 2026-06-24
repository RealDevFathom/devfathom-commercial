# DevFathom Hub

**Internal · DevFathom · Confidential**

The internal operations platform we built and run the company on.

DevFathom Hub is the in-house tool that DevFathom runs day to day. It is not a product we sell. It is the system the whole team works inside, built so we never have to stitch together a dozen separate tools to run the business. It pulls projects, clients, money, people, meetings, chat, and documents into one app, and then puts an AI assistant on top of all of it that can actually do the work, not just answer questions.

Everything in the Hub is permission aware from the ground up, so every feature respects who you are and what you are allowed to see.

## Projects and work management

This is the heart of the Hub and it leans heavily into a Trello style way of working, then goes further than Trello in the places that matter for delivery work.

- Projects with members, roles per member, status, type, priority, and milestones.
- Kanban boards per project with custom columns you can create, rename, reorder, and delete. Each column can have default assignees so cards landing there get picked up automatically.
- Tasks with the full kit: assignees, labels, priorities, due dates, parent and subtask relationships, and blockers so you can mark that one task is waiting on another.
- Rich task detail with comments, checklists (multiple per task, each with their own items), file attachments, and a per task activity feed so you can see who changed what.
- Time tracking on tasks, with time entries, edits, and a rollup so you can see total time logged.
- Bulk actions on the board, so you can move or delete a batch of cards at once.
- Per project files and milestones.
- Board column templates so a new board can start from a sensible default layout instead of a blank slate.
- Trello import. You can bring an existing Trello board straight in, and the importer will create the project for you and tell you how many cards came across.

## Clients and the CRM side

- A client directory with status, contacts, and per client activity history.
- Multiple contacts per client, each editable, with email validation on the way in.
- Contracts per client, with their own statuses and lifecycle. The system tracks contracted value, sweeps expired contracts, and surfaces contracts that are about to expire.
- You can generate an invoice straight from a contract, so the sales side flows into the finance side without re-keying anything.
- Directory privacy that redacts personal information depending on who is looking, so not every role sees every detail.

## Finance

This is one of the deepest areas, and it is where the data integrity work has been most careful.

- Transactions (income and expense) with categories and full create, edit, and delete.
- Invoices with line items, statuses, sending the invoice by email, recording payments against it, and deleting payments.
- Automatic overdue marking for invoices that have passed their due date.
- Recurring expenses, including posting the due cycles automatically so the books reflect them.
- Budget versus actuals tracking.
- A financial summary, a profit and loss report, and a revenue chart.
- Multi currency support, with aggregation that shows a USD base equivalent so totals make sense even when the underlying records are in different currencies.
- Export of filtered transactions to a spreadsheet, so you can pull exactly the slice you are looking at.

## People, HR, and reviews

- A team roster and individual member profiles.
- Leave management end to end: leave requests, balances per person, approval and status updates, cancellation, and a team leave calendar so you can see who is out and when.
- An HR overview console for the people ops side of things.
- Self service resignation. A person can submit a resignation, withdraw it, and HR or an admin reviews it. Approving a resignation triggers off-boarding, which deactivates the account.
- Lay-off flow for the company initiating a separation, with a recorded reason and an email to the affected person, and a clear suspended login message if they try to sign in afterward.
- Performance notes on team members, kept private to the right roles.
- Performance reviews built around review cycles. You open a cycle, collect reviews, submit them, and close or reopen the cycle. People can see the reviews assigned to them.
- Team stats and per person stats.

## Meetings and video

- Meetings with scheduling, upcoming views, and full detail pages.
- Attendance tracking that is correct per occurrence for recurring meetings, rather than a single stale join timestamp, plus an attendance report.
- In-app video calling. Meetings have a real call experience, the system issues the call securely and logs joins and leaves, so attendance and the actual call are tied together.

## Chat

The messaging side is built to feel like a proper Slack grade tool, not a bolt-on.

- Channels (public and private), direct messages, and channel browsing and joining.
- Sending, editing, and deleting messages, with full edit history.
- Reactions, threads, pins, saved messages, and mentions with proper mention targets.
- Read state and per channel mute, channel membership management, archiving, and creating channels or DMs on the fly.
- File attachments on messages.
- Voice messages, so you can record audio and play it back right in the conversation.
- Message search across the workspace.
- It is all realtime, so messages and presence update live.

## Notes and documents

- A notes system with rich content, visibility controls, and sharing to specific people with view or edit permissions.
- Note revisions with full history, the ability to view a past revision, and restore it.
- Linking notes to each other and mentioning people inside a note, including a view of notes that mention you.
- Search across notes.

## The AI assistant

This is the piece that ties everything together and is genuinely the standout. There is an in-app assistant that is a full operator over the product, not a chatbot off to the side. It carries roughly ninety six tools spanning every domain in the app: projects and tasks, clients, finance, meetings, notes, people, resignations, chat, and insights.

It can read across the business and it can also act. The important part is that every action it takes runs through the same permission engine a human would hit, so it can never do something the current user could not do themselves. Writes that matter, like creating records or running a lay-off, are gated behind an approval step so a person confirms before anything happens. It is wired into the real data, so you can ask it about your pipeline, your finances, or your team and have it actually go and do the follow-up work.

## Dashboard, search, and notifications

- A configurable dashboard with stats, recent activity, upcoming deadlines, project cards, your tasks, and a revenue chart, and you can set your own preferences for it.
- Global search across the app.
- An in-app notification system with per user notification preferences, plus email notifications for the events that matter, routed through a single send choke point so messaging stays consistent.

## Accounts, auth, and security

- Email and password sign in, with a team invite flow where adding a member sends an email invitation and the person onboards themselves through an invite link and sets their own password against a live strength checklist. No admin ever sets someone else's password.
- Self service password reset by email.
- Authenticator app based two factor, including enrollment, confirmation, recovery codes, and the ability to disable it.
- Session security: sign out everywhere, a view of your recent sign-ins, and a revocation check so a deactivated user is actually locked out rather than coasting on a live session.
- An admin audit log that records granular actions across the system, with a viewer and filtering, so there is a real trail of who did what.
- Underneath all of it is a full attribute based access control engine. Roles like Admin, HR, and Member, plus user states like active, on leave, and suspended, decide what each person can see and do, and every resource scoped action is guarded at the object level so people only touch records they are actually allowed to. This is the same engine the AI assistant and the internal API both run through.

## Settings and integrations

- A settings area covering profile, password, notification preferences, two factor, API tokens, and webhooks.
- Outbound webhooks you can create, with delivery history, so other internal systems can react to events here.
- An internal API that exposes clients, projects, tasks, boards, meetings, finance, invoices, transactions, and team. It is designed to be driven by our own scripts and automation, it tracks usage per token, and it ships its own docs page. So the Hub is operable by the team in the browser, by the built-in assistant, and by internal automation, all hitting the same permission rules.

---

The short version is that DevFathom Hub is the single operating system we run DevFathom on. Projects, clients, money, people, meetings, chat, and notes all live in one place, everything is permission aware down to the individual record, and there is an AI operator sitting on top that can actually run the business with the team instead of just talking about it.

_DevFathom · Depth in everything we build._
