# DevFathom restaurant guide

> **Status:** Draft (PR 3, `docs/restaurant-guide`). Checked against `origin/main` 16a2a370 on 2026-10-22.
> Co-authorization, comp and job-role wording rechecked against `develop` 616c8eb6 on 2026-11-06.
> Items marked **TODO(confirm)** still need a product decision before this guide is final.
> **Hotel is not covered.** Hotel is out of scope for now.

This guide explains what DevFathom does for a restaurant, in plain words. It is for:

| You are…    | Start with                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Owner**   | [What it does](#1-what-devfathom-does-for-a-restaurant), [Setting up](#2-setting-up-one-time), [Reports](#10-reports-and-insights), [Growth](#11-customers-loyalty-and-growth) |
| **Manager** | [A normal day](#3-a-normal-day), [Menu](#7-menu-and-catalog), [Staff](#8-staff-shifts-and-sops), [Stock](#9-stock-and-purchasing)                                              |
| **Cashier** | [A normal day](#3-a-normal-day), [Orders and tables](#4-orders-and-tables), [Bills, payments and cash](#6-bills-payments-and-cash)                                             |

Words in **bold** are explained in the [restaurant glossary](restaurant-glossary.md). General DevFathom words are in the main [glossary](glossary.md).

The detailed, step-by-step manual for administrators is the [restaurant administrator guide](restaurant-administrator-guide.md). This guide is the short version.

---

## 1. What DevFathom does for a restaurant

DevFathom helps you run a restaurant in one system. It covers:

- **Taking orders**: dine-in, takeaway and delivery.
- **Sending orders to the kitchen** on a screen (**KDS**).
- **Bills and payments**, including the cash **drawer** and the end-of-day **close**.
- **Menus**: items, options, combos, prices, recipes and allergens.
- **Staff**: job roles, what each person may do, shifts and checklists (**SOPs**).
- **Stock and purchasing**: what you have, what you waste, and what you buy.
- **Customers**: loyalty, wallet passes and promotions.
- **Catering and delivery** orders.
- **Reports and insights** about how the restaurant is doing.
- **Growth** suggestions, which a person reviews.
- **Tax** settings for Pakistan.
- **Cameras** (in-store camera viewing), for admins.

### The screens you will use

1. **Back office.** The main web app. Owners and managers use it to set up menus, staff, stock, reports and settings.
2. **Terminals.** Screens made for fast work during service:
   - **POS**: the till, for taking orders and payments.
   - **KDS**: the kitchen screen, which shows orders to cook.
3. **Customer wallet page.** A public page where a customer joins your loyalty program and adds a **wallet pass** to their phone.

### Not every feature may be on your plan

The DevFathom team turns **modules** on or off for each restaurant. Restaurant Core is always on. The others are: POS and Fulfilment, Menu and Costing, Inventory, Purchasing, Restaurant Workforce, SOP and Compliance, Customers and Loyalty, Restaurant Insights, and Integrations and Devices. If a page says the module is not enabled, ask the DevFathom team. Restaurant staff cannot turn modules on themselves.

TODO(confirm): which modules are in which commercial package.

Related docs: [Platform entitlements](platform-entitlements.md).

---

## 2. Setting up (one time)

The DevFathom team creates your restaurant account and turns on your modules. When the account is created, DevFathom automatically adds the standard job roles, a default **Kitchen** station for each branch (it gets all orders until you add routing rules), and gives the administrator the **Owner** job role.

The back office then shows a first-run checklist, in this order:

1. **Branch.** Each location is a **branch**. The first one becomes your main (primary) branch.
2. **Staff and roles.** Add staff, give each a **job role**, and give each their own PIN or badge for the terminals.
3. **Stations and printers** (optional for a test sale). Register your POS and KDS screens as **registered devices**: an admin opens Restaurant → Devices on the screen's browser and chooses "Enroll this browser". This needs the device-management permission.
4. **Published menu.** Build the menu and **publish** it with prices. See [Menu and catalog](#7-menu-and-catalog).
5. **Tax.** Pick a Pakistan tax preset or make a custom tax profile for each branch, using rates from your accountant. DevFathom is not tax advice.
6. **First test sale.** Make one test sale on the POS to prove everything works.

You also set up your floor (areas and tables) in Restaurant → Floor.

**Printing.** Receipts and kitchen tickets print through the **print bridge**, a small program that runs on a computer in your restaurant and sends tickets to your printers (over the network, or through a macOS print queue). It has not yet been tested on real printers, and it does not open a cash drawer. Setting it up is a technical job: follow the [printing guide](modules/printing.md) and test one receipt and one kitchen ticket before you open.

**Logins.** Each person gets their own login and their own PIN. Never share a login or a PIN.

Related docs: [Restaurant administrator guide](restaurant-administrator-guide.md), [Demo restaurants](../demo-restaurants.md).

---

## 3. A normal day

**Opening**

- Each terminal is already a registered device. Staff pick their name and enter their own PIN.
- The cashier opens the **drawer** and records the opening cash (the opening float).
- Staff follow the opening **SOP** checklist, if your restaurant uses one.

**Service**

- Take orders ([section 4](#4-orders-and-tables)).
- The kitchen cooks from the KDS ([section 5](#5-kitchen-kds-and-printing)).
- Take payments ([section 6](#6-bills-payments-and-cash)).
- Use **Lock** when leaving the till, and **Switch operator** when someone else takes over.
- Some actions need a manager to approve them with their own PIN (**co-authorization**). See [section 6](#6-bills-payments-and-cash).

**Closing**

- Settle all open bills.
- Count the drawer and do the **close** ([section 6](#6-bills-payments-and-cash)).
- Staff complete the closing SOP.
- The manager checks the day in reports. Dashboard figures cover closed days, not the shift in progress.

**If the internet drops:** the POS can still start **new** orders from the saved menu and send them when it reconnects. Payments, refunds, the drawer and the close need a live connection.

---

## 4. Orders and tables

**Who uses this:** cashiers, servers, managers.

- The **floor** is a map of your areas and tables.
- On the POS choose **New order**, then **Dine in**, **Takeaway** or **Delivery**.
- For dine-in, pick a free table.
- Add menu items and choose their options (modifiers).
- Send (fire) the order to the kitchen.
- You can **move** an order to another table and **merge** tables from the open ticket.
- Managers can review orders in Restaurant → Orders and Restaurant → Floor.

Related docs: [POS and terminal](modules/pos-terminal.md).

---

## 5. Kitchen (KDS and printing)

**Who uses this:** kitchen staff, managers.

- The **KDS** is a screen at a kitchen **station**. It shows the orders that station must cook.
- **Routing** decides which items go to which station: a rule for a product beats a rule for a category, and anything left over goes to the default station. For example, you can send drinks to a bar station.
- Kitchen staff press **Start**, then **Mark ready**. **Recall** brings a ticket back.
- For delivery orders, the KDS has a handoff board: **Dispatch order**, then **Mark delivered**.
- Kitchen tickets and receipts can also print through the print bridge. It is not yet tested on real printers (see [section 2](#2-setting-up-one-time) and the [printing guide](modules/printing.md)).

- The cashier's POS does not show when an order is ready. Ready status is shown on the KDS only.

Related docs: [KDS](modules/kds.md), [Printing](modules/printing.md).

---

## 6. Bills, payments and cash

**Who uses this:** cashiers, managers.

- A **bill** is what the customer pays. You can split a bill by item, by seat, or into fractions.
- A bill can be paid with one or more **tenders**: **Cash**, **Card** or **Other**.
- **Card is not a real card payment yet.** The cashier records it after taking the card on a separate machine. DevFathom does not connect to a bank or card processor.
- Cash goes into the **drawer**. During the day you record cash added (paid-in), cash taken out (paid-out) and cash removed for safety (drop).
- **Close:** on the POS go to Drawer, preview the close, enter the cash you counted, and close the drawer and day. DevFathom shows the expected cash, your count and the difference (variance). Explain any difference; never change the count to make it match.
- **Tax** is worked out from the branch's tax profile.
- **Discounts and refunds** are supervisor powers. Cashiers do not have them by default.
- A refund done after the day is closed goes into the current day and points back to the original bill.

**Actions that need a second person (co-authorization).** Another manager must approve with their own PIN and give a reason:

- voiding items after the kitchen has started them,
- refunds and corrections,
- correcting a drawer close,
- waiving an SOP,
- removing (revoking) a registered device or a camera gateway.

Giving items away free (comps) is not available in this version. Comp totals on older bills still show on bills and reports.

Exception for one-person restaurants: if you are the owner and the only active staff member, you can approve your own void, refund, bill correction or close correction on the terminal by re-entering your own PIN (a badge does not count). The record notes that the owner approved by PIN. SOP waivers and removing a device or camera gateway are done in the back office and always need a second person.

Managers check money in Restaurant → Money (bills, payments, drawers, daily close).

Related docs: [Tax](tax.md), [POS and terminal](modules/pos-terminal.md).

---

## 7. Menu and catalog

**Who uses this:** owners, managers.

- The **catalog** is the full list of things you sell, with categories and variants.
- **Modifiers** are options on an item, such as size or extra cheese.
- A **combo** is a set of items sold together.
- **Allergens** can be recorded for items.
- **Recipes** list the ingredients in an item. DevFathom uses them to work out the cost of each dish and food-cost %.
- **Price lists** hold your prices. Each change is a new dated version. A menu is published to a branch and a sales channel (for example dine-in or delivery) with a price list, and can have time windows.
- You **publish** a menu to make it live on the POS. Keep changes as drafts until checked.
- **Menu import** reads an existing menu from a photo or file (**OCR**). You check every line, then it creates a **draft** menu. It never publishes by itself.

Related docs: [Menu import (OCR)](menu-import-ocr.md).

---

## 8. Staff, shifts and SOPs

**Who uses this:** owners, managers.

### Job roles

Each staff member has one or more **job roles** at a branch. The standard roles are:

| Job role            | What it is for                                       |
| ------------------- | ---------------------------------------------------- |
| Owner               | Everything on the floor and in the branch            |
| Manager             | Supervising plus running the branch                  |
| Shift Supervisor    | Supervising a shift, including discounts and refunds |
| Cashier             | Taking orders, payments and the drawer               |
| Server              | Taking orders on the floor                           |
| Host                | Seeing orders and customers                          |
| Kitchen / Line Cook | Working the KDS                                      |
| Barista             | Taking orders and working a KDS                      |
| Accountant          | Money and financial reports                          |
| Delivery Rider      | Delivery orders                                      |

Every role except Accountant can read the menu and complete SOPs. Accountant is not a floor role. A job role has **capabilities** (things the person may do). You can give one person an extra capability (**capability grant**) or block one, and every change is recorded.

### Who can do what

There are two separate layers:

1. **Back-office role** (the web login). Each user has one. Restaurant templates include Owner/Administrator (everything), General Manager, Branch Manager, Cashier, Server, Kitchen, Bar/Barista, Inventory Controller, Purchasing Officer, Accountant and SOP/Compliance Auditor. The older Admin, Employee and HR roles still apply to the general business pages. Some pages, such as Cameras, need admin access.
2. **Job role** (the floor). Used on the POS and KDS through the staff member's PIN. A staff member does not need a web login at all.

The two layers do not read each other. Being an admin on the website does not give someone POS powers by itself. When DevFathom sets up a restaurant, it does give the administrator the Owner job role at their branch.

### Shifts and SOPs

- **Shifts** are planned in the staff roster (Restaurant → Staff → Roster). The roster is not payroll.
- **SOPs** are checklists, such as opening and closing. Staff complete them on time, attaching evidence when asked (**SOP execution**). Managers verify, reject or waive them in SOP oversight. A waiver needs a second person.
- SOP reports show results. If nothing was scored, they say "No data", not 0%.

**When an SOP is missed.** If a checklist is not done in time, DevFathom marks it **Missed**. It then sends an alert called "SOP Escalation: <checklist name>" to each person or group in the escalation chain, one step at a time. It waits during quiet hours and stops once someone verifies or acknowledges it. Today alerts arrive in the app and, if set up, at your webhook. Email, SMS, push and WhatsApp alerts are not sent yet.

Related docs: [SOP](sop.md), [Auth and roles (technical)](../dev/auth-and-roles.md).

---

## 9. Stock and purchasing

**Who uses this:** managers, inventory and purchasing staff.

- **Stock** (Restaurant → Inventory) shows what you have, movements, counts, transfers, low stock, adjustments and **wastage**.
- Record waste as waste. Never edit a balance to hide it.
- **Purchasing** steps: draft a purchase order, submit, approve, then receive the goods. Receiving adds stock.
- Every stock change is recorded as a movement.
- When an order is closed, DevFathom uses up the ingredients in each item's recipe. Items with no active recipe do not reduce stock.
- If an item is voided after the kitchen started it, the void is marked as one of three options: **Waste** records it as wastage; **Restock** or **None** record no stock change.
- For catering, stock is used up when an event is marked Ready.

Related docs: [Restaurant administrator guide](restaurant-administrator-guide.md) (sections 4 and 12).

---

## 10. Reports and insights

**Who uses this:** owners, managers, accountants.

- **Reports** (Restaurant → Reports) cover financial, operational, inventory, purchasing, workforce and SOP results, for one branch or all branches, with CSV export. They include wastage, stock movement, food cost, dish profitability and catering reports.
- **Dish profitability** sorts dishes into Stars, Plowhorses, Puzzles and Dogs by sales and margin.
- The **dashboard** shows a management overview for the last 7 or 30 closed days. You can show, hide and move its widgets.
- **Insights** is a separate module that feeds the dashboard.

TODO(confirm): what the Insights page itself shows beyond the dashboard.

Related docs: [Restaurant administrator guide](restaurant-administrator-guide.md) (section 15).

---

## 11. Customers, loyalty and growth

**Who uses this:** owners, managers.

- **Customers**: attach a customer to an order at the POS.
- **Loyalty**: customers earn and redeem points.
- **Wallet passes**: loyalty cards for **Apple Wallet** and **Google Wallet**. Customers join from the public wallet page.
- **Promotions**: offers and discounts with rules and limits.
- **Growth**: DevFathom compares a branch's recent sales with the period before and suggests ideas. A person must review each suggestion. Nothing is sent or changed automatically.

Related docs: [Customers and loyalty](customers-loyalty.md).

---

## 12. Catering and delivery

**Who uses this:** managers, cashiers.

- **Catering** handles event orders. An order moves in order through Draft, Quoted, Confirmed, In production, Ready, Delivered and Closed. A quote and a deposit amount can be recorded on the order. DevFathom works out ingredient cost, extras and margin, and prints a production sheet.
- **Delivery** is your own delivery: set delivery zones per branch and publish a menu to Delivery. The order needs a customer and a saved address. It is either **prepaid** or **cash on delivery**. Outside delivery apps and full rider tracking are not included.

TODO(confirm): how a catering deposit is collected (DevFathom records the amount).

Related docs: [Restaurant administrator guide](restaurant-administrator-guide.md) (sections 9 and 12A).

---

## 13. Other features

- **Notifications**: DevFathom sends SOP notifications. An admin can send them to one secure web address (a **webhook**) from Restaurant → Notifications. This is for technical staff.
- **Terminal webhooks**: card-terminal providers can send payment-terminal events into DevFathom. This is set up by technical staff.
- **Cameras**: admins can connect an in-store camera gateway for a branch, watch live video, look at recordings and set how long they are kept. Video stays on the in-store gateway. There is a camera privacy page in settings. Removing a gateway needs a second person. This has been tested with a simulator, not yet with real camera hardware.

TODO(confirm): whether cameras are part of the MVP.

Related docs: [Notification webhooks](restaurant-notification-webhooks.md), [Terminal webhooks](restaurant-terminal-webhooks.md).

---

## 14. Screenshots

This guide has no screenshots yet. TODO(confirm): which demo restaurant on AWS staging to use. Ask Inky to wake staging before taking screenshots. Never show logins in screenshots.

## 15. Getting help

TODO(confirm): the support contact for restaurant customers.
