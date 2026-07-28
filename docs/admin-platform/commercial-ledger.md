# Sales CRM and Commercial Ledger

## Current

The application has client/project and finance concepts, including invoice statuses and transaction types in `prisma/schema.prisma`, plus invoice REST endpoints represented by `src/app/api/v1/spec/route.ts`. This is not evidence of subscriptions, payment processing, taxation, or a general ledger.

## Planned contract

Sales CRM: account, contact, opportunity, quote, quote line, stage history and conversion attribution. Commercial ledger: subscription, invoice, payment, credit, refund, adjustment, tax and reconciliation event. Financial documents are immutable after posting; corrections are compensating entries, never destructive edits. Store provider references and idempotency keys; reconcile external payment events asynchronously.

No payment provider is selected or integrated by this plan. Provider selection must follow the project’s Vercel Marketplace integration process before implementation.
