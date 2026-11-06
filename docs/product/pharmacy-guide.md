# Pharmacy guide

_For pharmacy owners, managers, pharmacists and counter staff._

This guide explains what each part of DevFathom does for your pharmacy and who is allowed to use it. It does not yet give click-by-click steps or screenshots. Those will be added once the demo pharmacy is ready to photograph. TODO(confirm): add screenshots from the demo pharmacy only.

New to a word? Check the [glossary](glossary.md).

---

## Contents

1. [Getting started](#1-getting-started)
2. [Counter sales and daily close](#2-counter-sales-and-daily-close)
3. [Customers: khata, family and loyalty](#3-customers-khata-family-and-loyalty)
4. [Medicine list (catalogue)](#4-medicine-list-catalogue)
5. [Stock](#5-stock)
6. [Buying from suppliers](#6-buying-from-suppliers)
7. [Prescriptions and the pharmacist queue](#7-prescriptions-and-the-pharmacist-queue)
8. [Controlled-drugs register and recalls (Draft)](#8-controlled-drugs-register-and-recalls-draft)
9. [Reports, money and tax](#9-reports-money-and-tax)
10. [Growth and marketing](#10-growth-and-marketing)
11. [Working offline](#11-working-offline)
12. [Roles: who can do what](#12-roles-who-can-do-what)
13. [The three protected jobs](#the-three-protected-jobs)

---

## 1. Getting started

### Setting up your pharmacy

When you join, your business is set up in DevFathom with one or more **branches**. Each branch is one shop location.

TODO(confirm): who does the first setup (DevFathom's team or the owner) and what the owner needs to provide.

### Moving from your old system

DevFathom helps you move over in stages:

1. **Bring in your opening stock** and other records from your old system.
2. **Run both systems side by side** (a _parallel run_) so you can check that they match.
3. **Switch over** (_cutover_) on a chosen day, after which you use only DevFathom.

TODO(confirm): which old systems or file formats can be imported, and how long a parallel run usually lasts.

### Adding your staff

Owners invite staff and give each person a **role**. You can then add or remove permissions for individual people, and limit staff to the branches they work in. See [Roles: who can do what](#12-roles-who-can-do-what).

**Never share your login with staff.** Each person should have their own account so the activity log shows who did what.

---

## 2. Counter sales and daily close

_For counter staff and managers._

### Making a sale

Find the medicine (for example by scanning its barcode), choose the pack size, and take payment. A customer can pay with more than one method, such as part cash and part card.

TODO(confirm): which payment methods are supported.

### Refunds

You can refund items a customer returns. TODO(confirm): who is allowed to give refunds, and whether a manager must approve.

### The cash drawer

DevFathom keeps track of the cash in your drawer during the day.

### Closing the day

At the end of the day or shift, you **close the day**. This checks the sales and the cash in the drawer, and records the result.

TODO(confirm): what happens if the cash does not match, and who can approve a close.

### Receipts and tax documents

The system can produce fiscal (tax) documents for sales. TODO(confirm): what printed or digital receipts look like and which tax rules apply.

---

## 3. Customers: khata, family and loyalty

- **Khata (credit account):** let trusted customers take goods now and pay later. DevFathom keeps their running balance.
- **Family:** link family members together. TODO(confirm): what linking family members does, for example a shared khata.
- **Loyalty:** reward regular customers. TODO(confirm): how loyalty points or rewards are earned and spent.

---

## 4. Medicine list (catalogue)

Your **medicine list** holds each medicine with:

- its **ingredients** (active substances)
- its **form**, such as tablet or syrup
- its **pack sizes**, such as strip, box or carton
- its **MRP** (the price printed on the pack)
- its **barcodes**

### Regulated changes are reviewed before they go live

When a connected source proposes a regulated change to the medicine list, the change waits for review. A person with the **catalogue review** job confirms or rejects it. Confirmed changes are then published to the list. TODO(confirm): which kinds of edits made directly by staff also go through review.

Catalogue review is one of the [three protected jobs](#the-three-protected-jobs).

---

## 5. Stock

- **Stock by batch:** DevFathom tracks stock by batch (lot), so you know which packs came in together. TODO(confirm): whether the system warns about medicines close to expiry.
- **Stock counts:** count what is actually on your shelves and compare it to what the system says.
- **Transfers between branches:** move stock from one branch to another.
- **Pack checks:** scans compare encoded pack details with your pharmacy's medicine and batch records and flag mismatches or duplicate serial details. A matching scan does not prove a pack is genuine. Unverifiable scans and mismatch flags are advisory; existing recall blocks still apply. TODO(confirm): the staff procedure for following up a flag.

---

## 6. Buying from suppliers

DevFathom follows your buying from start to finish:

1. **Requisition:** someone records that you need to buy something.
2. **Quote:** suppliers give you prices.
3. **Purchase order (PO):** you place the order.
4. **Goods received note (GRN):** you record what actually arrived and check it against the order.
5. **Returns:** you send back damaged, wrong or unwanted goods.
6. **Supplier credit:** you keep track of money the supplier owes you after a return.

You can also link suppliers to your account. TODO(confirm): what supplier links let you do, for example sending orders directly.

Approving and sending a purchase order, and authorizing a supplier, need the separate **purchase-order approval** permission. The Owner, Owner / Operator and Manager roles have it; the Procurement role raises orders but does not approve them. Nobody approves an order they raised themselves, except the only active member of a one-person workspace.

---

## 7. Prescriptions and the pharmacist queue

_For pharmacists and counter staff._

### Recording a prescription

Record the prescription, the **patient** and the **prescriber** (the doctor who wrote it).

### The pharmacist queue

Prescriptions wait in the **pharmacist queue** until a pharmacist checks them.

### Pharmacist decisions and dispensing

The **dispensing** protected job covers the pharmacist's decisions on a prescription, including any substitution and the evidence for it, and handing the medicine over. See [The three protected jobs](#the-three-protected-jobs).

TODO(confirm): the exact order of steps on screen and what the pharmacist sees when reviewing a prescription.

---

## 8. Controlled-drugs register and recalls (Draft)

> **DRAFT – pending legal review.** This section has not yet been checked by a pharmacist or legal reviewer. Do not rely on it for legal advice. Follow DRAP's official guidance and your own legal duties.

### Controlled-drugs register

DevFathom keeps a **controlled-drugs register** for medicines that the law says must be recorded closely. Working on the register (viewing it, recording corrections, approving register incidents, preparing inspection packs and placing records on legal hold) needs the **safety** protected job.

TODO(confirm): which medicines are covered, what is recorded for each entry, who can make entries, and how long records are kept.

### Recalls

When a medicine or batch is **recalled**, it must be taken off sale. DevFathom can bring in recall information from **DRAP** and helps you act on it.

TODO(confirm): how recall information reaches the system, how staff are told, and whether recalled batches are blocked at the counter.

---

## 9. Reports, money and tax

- **Reports** on sales, stock and other activity. TODO(confirm): which reports are available.
- **Bookkeeping:** keep your accounts.
- **Settlement:** match payments you are due, for example from card payments, with what you actually received. TODO(confirm): which payment providers are covered.
- **Bank reconciliation:** match your bank statement with your records.
- **Tax:** keep tax records for your sales. TODO(confirm): which taxes and filing rules are supported.

---

## 10. Growth and marketing

DevFathom includes tools to help your pharmacy grow, including marketing to customers. It also has features that look for unusual activity (for example, patterns that may need a closer look).

TODO(confirm): exactly which growth and AI features are live for pharmacies, what each one does, and what customer data they use. Do not promise any of these to customers until this is confirmed.

---

## 11. Working offline

Some counter devices can be registered to keep working when the internet is down.

TODO(confirm): which tasks work offline, how long a device can stay offline, and how its data catches up once the connection returns.

---

## 12. Roles: who can do what

### Roles

Every staff member has a **role**. A role is a ready-made set of permissions. The basic roles are:

- **Admin:** wide control over the business's settings and staff.
- **Employee:** day-to-day work.
- **HR:** staff and people matters.

On top of that, there are ready-made **pharmacy roles** that owners can pick:

| Pharmacy role    | What it includes                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| Owner            | All everyday pharmacy permissions and reports, but **not** the three protected jobs                      |
| Owner / Operator | Optional, given on purpose: all everyday pharmacy permissions, reports, and **all three protected jobs** |
| Pharmacist       | Dispensing, catalogue review and daily close                                                             |
| Manager          | Pharmacy management, customer orders and buying from suppliers                                           |
| Cashier          | The counter and customer orders                                                                          |
| Procurement      | Buying from suppliers                                                                                    |
| Inventory        | Stock                                                                                                    |
| Finance          | Financial reports                                                                                        |
| Auditor          | Operational reports                                                                                      |

These ready-made roles are still provisional and may change.

The **Owner / Operator** pharmacy role must be paired with the basic **Admin** role for business and staff actions that require Admin. Giving it to an Employee does not make that person an Admin. Pharmacy permissions do not verify professional qualifications or bypass other workflow checks.

### Changing one person's permissions

On top of their role, you can give or remove a specific permission for one person. This lets you fit permissions to how your shop really works.

### Limiting staff to branches

Staff can be limited to the branches they work in, so they only see those branches.

### Audit trail

Protected workflows and other audited actions write activity records so an authorized reviewer can
later check who did what. The Owner / Operator role and PIN checks do not remove or replace that
audit trail. TODO(confirm): the complete list of audited actions and who can view each record.

---

## The three protected jobs

Three pharmacy jobs carry extra risk, so DevFathom treats them differently from everything else:

| Job                  | What it means                                                                                                                                                          | Where it happens                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Dispensing**       | Handing over medicines against a prescription                                                                                                                          | Prescriptions and pharmacist queue                                 |
| **Safety**           | Working on the controlled-drugs register: corrections, register incidents, inspection packs, record holds; some controlled actions also require an independent witness | Controlled-drugs register and protected controlled-stock workflows |
| **Catalogue review** | Confirming or rejecting regulated medicine-list changes before they go live                                                                                            | Medicine list                                                      |

### The rules in plain words

1. **Nobody gets these jobs automatically.** Being an admin does not include them, and neither does the ready-made Owner role. A person only gets one if they are given a role or permission that names it.
2. **"Give them everything" does not include these jobs.** If you give someone all permissions, or all pharmacy permissions, they still will **not** be able to dispense, work on the controlled-drugs register or review the catalogue. You must give each of the three by name.
3. **Each job is checked on its own.** Having one of them does not give you the others.
4. **One person may hold all three.** In a shop with a single pharmacist, that pharmacist can be given all three jobs.
5. **Capability is not the same as independent approval.** The Owner / Operator role lets one person start any of the three protected jobs, but it does not let that person witness their own controlled purchase or controlled-stock restoration. Those actions require a different qualified user to enter an active, fresh PIN. DevFathom records both the actor and witness in the audit trail.
6. **Taking permissions away.** A matching block on either the person or their role wins over any allow. An allow set for a person cannot override a block on their role. To take a job away from one person, block it on that person. A block on "all permissions" or "all pharmacy permissions" also removes all three jobs.

### Why it works this way

Keeping these jobs separate means a mistake or misuse in one place is less likely to go unnoticed. It also means owners always decide, on purpose, who can hand over medicines and who can change the medicine list.

### Which ready-made roles include them

- **Pharmacist** includes dispensing and catalogue review. Safety must be given separately.
- **Owner / Operator** includes all three. It is optional and is only given on purpose, for example to an owner who is also the pharmacist.
- No other ready-made role includes any of the three, including **Owner**.

These ready-made roles are still provisional and may change.

### Setting it up in your shop

- **Several pharmacists:** give dispensing to each pharmacist, and safety to those who keep the controlled-drugs register. Consider giving catalogue review to only one or two trusted people.
- **One pharmacist:** that pharmacist may hold all three jobs (for example with the Owner / Operator role) and can complete workflows that do not require an independent witness. Controlled purchasing and controlled-stock restoration still need a different qualified user's active, fresh PIN; the owner cannot witness their own action. Arrange qualified cover for those steps rather than sharing a PIN or bypassing the audit trail.
- **Counter staff who are not pharmacists:** usually give none of the three. TODO(confirm): what counter staff can do with a prescription without these jobs.

TODO(confirm): where in the app owners give these jobs to staff.
