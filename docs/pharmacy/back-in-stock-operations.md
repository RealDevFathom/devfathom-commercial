# Back-in-stock operations

The approved `backInStock` utility template has three parameters: the branch's
stored name/address/city and opaque branch token, the request date in
`Asia/Karachi`, and an opaque reference. No requested product, salt, category,
patient name or phone is included in the parameters. Branch location comes
from the branch record, never request text.

Authorized counter staff can use `pharmacySales.restockNotificationReview`
with `branchId` to list captured, failed and uncertain (`PROCESSING`) deliveries.
Pass the customer's `reference` (the `R-...` value) to look up a notice in the
same tenant and branch, including sent notices. Results identify the interest
and notification without returning destinations or patient details. If a token
has multiple matches, the query returns all of them; operators must resolve the
request rather than treating a short hash as a unique database key.

For an uncertain send, verify the outcome in the provider's records, then call
`pharmacySales.reconcileRestockNotification` with `branchId`, `notificationId`
and `outcome`. A `SENT` outcome requires the actual `sentAt` and
`providerMessageId`; a confirmed non-send uses `FAILED`. Reconciliation never
resends or releases the durable claim. Check interrupted claims in the review
queue as well, including a crash after provider acceptance but before saving
its acknowledgement. Do not reconcile a send that is still in flight.

SMS and mismatched Meta sender ownership are recorded as `FAILED` with
`UNSUPPORTED_CHANNEL` or `PROVIDER_ORGANIZATION_MISMATCH`. Mock preparation is
`FAILED` with `MOCK_PREPARED`, because it did not send a customer notice. These
outcomes leave same-SKU manual receipt recovery available and consume the
reservation when recovery succeeds. Each request retains one notice record.

`pharmacySales.restockRecoveryReport` retains its array response.
`pharmacySales.restockRecoveryDashboard` supplies estimated lost, recovered
and net PKR totals grouped by branch, catalog salts and arrival distributor.
Recovered value is after discount and returned goods (including unidentified
returns). Completed-sale cash refunds are capped at those returns, so the
return and its subsequent refund are not deducted twice. Historical duplicate
links count a sale line only once in the dashboard.
