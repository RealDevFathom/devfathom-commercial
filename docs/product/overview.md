# DevFathom: product overview

_For pharmacy owners, sales staff and customers. No technical knowledge needed._

## What DevFathom is

DevFathom is a point-of-sale and shop-management system built for pharmacies in Pakistan. It runs your counter, stock, buying, prescriptions and records in one place, and it also includes tools to help your business grow.

DevFathom separates each business's information and uses tenant and branch access controls to
limit what staff can reach. These controls still need correct setup and ongoing security testing.

DevFathom includes products for **pharmacies**, **restaurants** and **agencies**. This overview
focuses on pharmacy. For restaurants, see the [restaurant guide](restaurant-guide.md); the agency
guide has not been written yet.

> TODO(confirm): When DevFathom will be generally available to customers, and whether it is currently offered only as a pilot.

## Who it is for

- **Pharmacy owners and managers** who want to see sales, stock and staff activity across one or more branches.
- **Pharmacists** who check prescriptions and hand over medicines.
- **Counter staff** who serve customers and take payments every day.

## What it helps you do

### Serve customers at the counter

Ring up sales, take payment, handle refunds, and keep track of the cash drawer. At the end of the day you close the day so the numbers are checked and recorded.

### Keep track of customers

Run customer credit accounts (khata), link family members together, and reward regular customers with loyalty.

### Know what is on your shelves

Track stock by batch, count stock, and move stock between branches.

### Buy from suppliers

Go from "we need this" to "it has arrived": make a request, get quotes, raise a purchase order, record what was delivered, return goods, and track money owed back by suppliers.

### Keep a clean medicine list

Keep a catalogue of medicines with their ingredients, forms, pack sizes, printed retail price (MRP) and barcodes. Regulated changes proposed by connected sources are reviewed before they go live. TODO(confirm): which kinds of edits made directly by staff also go through review.

### Handle prescriptions properly

Record prescriptions, patients and the doctors who wrote them. Prescriptions go to a pharmacist's queue to be checked.

### Meet your legal duties

Keep a controlled-drugs register and act on medicine recalls, including recall information from DRAP (the Drug Regulatory Authority of Pakistan).

> **DRAFT – pending legal review.** The register and recall features have not yet been checked by a pharmacist or legal reviewer. TODO(confirm): what DevFathom does and does not cover for DRAP rules.

### See how the business is doing

Use reports, bookkeeping, bank reconciliation, settlement and tax records.

### Grow the business

Use marketing and growth tools. The system also has features that look for unusual activity.

> TODO(confirm): Exactly which "AI growth" features are available for pharmacies today, and what each one does. Please don't promise specific features to customers until this is confirmed.

### Move over from your old system

Bring in your opening stock and records, run the old and new systems side by side for a while, and then switch over on a chosen day.

### Keep working during internet problems

Some counter devices can be set up to work offline.

> TODO(confirm): What still works offline, and how data catches up once the connection returns.

## How it keeps you safe

- **Your data is kept separate.** Tenant and branch access controls are designed to limit staff to the business and branches they are allowed to use. Correct configuration and security testing remain important.
- **Everyone has a role.** Owners decide what each staff member can see and do. You can adjust permissions for individual people.
- **Three pharmacy jobs are specially protected.** Dispensing medicines, safety (the controlled-drugs register and its incidents), and approving regulated changes to the medicine list must each be given by name. Being an admin, or holding "all permissions", does not include them. See the [pharmacy guide](pharmacy-guide.md#the-three-protected-jobs) for details.
- **Audited actions are recorded.** Protected workflows and other audited actions write activity records. TODO(confirm): the complete list of audited actions and who can view each record.
- **Extra login protection:** two-step sign-in (a code from an authenticator app) is supported. It is not switched on by default. TODO(confirm): how it is turned on, and whether owners can require it for staff.

## Features and packages

Features are grouped into modules and packages, so a business turns on what it needs. TODO(confirm): which packages exist and what they cost. Please don't quote prices from this document.

## Other DevFathom products

- **Restaurants:** includes counter and kitchen screens, menus, bills and cash, staff shifts and checklists, stock and buying, customers and loyalty, catering, delivery and more.
- **Agencies:** includes clients, projects and task boards, invoices, team and HR, meetings, notes and chat.

Dedicated customer guides for these products are coming later.

Hotel features are not part of the product.

## Learn more

- [Pharmacy guide](pharmacy-guide.md): how each feature works for owners and counter staff.
- [Glossary](glossary.md): what the words mean.
