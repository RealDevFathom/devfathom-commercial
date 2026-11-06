# Restaurant glossary

> **Status:** Draft (PR 3, `docs/restaurant-guide`). Checked against `origin/main` 16a2a370 on 2026-10-22.
> Co-authorization, comp and job-role wording rechecked against `develop` 616c8eb6 on 2026-11-06.

Short meanings of restaurant words used in DevFathom. General DevFathom words (organization, module, roles) are in the main [glossary](glossary.md). How these features are used is in the [restaurant guide](restaurant-guide.md).

## Places and screens

| Word                     | Meaning                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Branch**               | One location of your restaurant.                                                                              |
| **Floor**                | The map of your areas and tables.                                                                             |
| **Station**              | A place in the kitchen or bar that gets its own orders on a KDS. Every branch starts with one called Kitchen. |
| **Back office**          | The main DevFathom web app, used for setup, staff, stock and reports.                                         |
| **POS**                  | Point of sale. The till screen for taking orders and payments.                                                |
| **KDS**                  | Kitchen display system. The kitchen screen that shows orders to cook.                                         |
| **Terminal**             | A POS or KDS screen.                                                                                          |
| **Registered device**    | A screen whose browser an admin has enrolled so it can run a terminal.                                        |
| **Terminal session**     | A period when a staff member is signed in on a terminal.                                                      |
| **Operator credentials** | Each staff member's own PIN or badge, used to sign in on a terminal. It is not a website password.            |

## Orders and money

| Word             | Meaning                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Order**        | What a table or customer asks for. It is dine-in, takeaway or delivery.                                                                                                     |
| **Routing**      | Rules that send each item to the right kitchen station.                                                                                                                     |
| **Print bridge** | A small program on a computer in your restaurant that sends receipts and kitchen tickets to your printers. Not yet tested on real printers; it does not open a cash drawer. |
| **Bill**         | What the customer pays. It can be split by item, seat or fraction.                                                                                                          |
| **Tender**       | A way to pay: Cash, Card or Other. A bill can have more than one tender. Card is recorded by the cashier; it is not a real card payment yet.                                |
| **Drawer**       | The cash drawer, tracked through the day with the opening float, paid-ins, paid-outs and drops.                                                                             |
| **Close**        | The end-of-day count: you enter the cash you counted, and DevFathom shows the expected cash and the difference.                                                             |
| **Variance**     | The difference between expected and counted cash.                                                                                                                           |
| **Tax profile**  | A branch's tax settings, with dates they apply from.                                                                                                                        |

## Menu

| Word                  | Meaning                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| **Catalog**           | The full list of things you sell.                                                                 |
| **Menu**              | What is offered for sale. You **publish** a menu to a branch and channel to make it live.         |
| **Modifier**          | An option on an item, such as size or extra cheese.                                               |
| **Combo**             | A set of items sold together.                                                                     |
| **Recipe**            | The ingredients in an item, used to work out dish cost.                                           |
| **Food cost %**       | Dish cost divided by its price.                                                                   |
| **Allergen**          | An ingredient that can cause an allergy, recorded on an item.                                     |
| **Price list**        | A named set of prices. Each change is a new dated version. A menu is published with a price list. |
| **Menu import (OCR)** | Reading an existing menu from a photo or file so you type less. It makes a draft that you check.  |

## Staff

| Word                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Job role**         | A staff member's job on the floor. Standard roles: Owner, Manager, Shift Supervisor, Cashier, Server, Host, Kitchen / Line Cook, Barista, Accountant, Delivery Rider.                                                                                                                                                                                                                          |
| **Back-office role** | The role on a person's web login. Separate from their job role.                                                                                                                                                                                                                                                                                                                                |
| **Capability**       | Something a person is allowed to do. Job roles come with capabilities.                                                                                                                                                                                                                                                                                                                         |
| **Capability grant** | Giving one person an extra capability. Every grant is recorded.                                                                                                                                                                                                                                                                                                                                |
| **Co-authorization** | Another manager approves an action with their own PIN and a reason. Used for voids after cooking starts, refunds, corrections, drawer-close corrections, SOP waivers, and removing devices or camera gateways. A sole owner can approve their own terminal actions by re-entering their PIN; back-office actions (SOP waivers, device and camera-gateway removal) always need a second person. |
| **Shift**            | A planned period a staff member works, on the roster.                                                                                                                                                                                                                                                                                                                                          |
| **SOP**              | Standard operating procedure. A checklist, such as opening or closing.                                                                                                                                                                                                                                                                                                                         |
| **SOP execution**    | The record that someone completed an SOP, with any evidence.                                                                                                                                                                                                                                                                                                                                   |

## Customers and growth

| Word            | Meaning                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ |
| **Loyalty**     | Points that reward repeat customers.                                                       |
| **Wallet pass** | A loyalty card in Apple Wallet or Google Wallet.                                           |
| **Promotion**   | An offer or discount with rules and limits.                                                |
| **Catering**    | Event orders, with quotes, costs and a production sheet.                                   |
| **Delivery**    | Your own delivery to the customer, prepaid or cash on delivery.                            |
| **Insights**    | Summaries of closed days that feed the dashboard.                                          |
| **Growth**      | Suggestions based on recent sales that a person reviews. Nothing is changed automatically. |

## Stock

| Word           | Meaning                                                 |
| -------------- | ------------------------------------------------------- |
| **Stock**      | What you have on hand.                                  |
| **Wastage**    | Stock lost to waste, spoilage or staff meals.           |
| **Purchasing** | Buying from suppliers: draft, submit, approve, receive. |
