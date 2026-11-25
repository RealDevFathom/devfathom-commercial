# Pharmacy warehouse pilot

Use one central store and two receiving branches of the same organization. Warehouse operations are enabled per site. The inventory ledger, purchasing documents, branch transfers, and controlled register remain the records used for reconciliation.

## Prepare the sites

1. Verify both ends of each transfer have active premises profiles, address matches, and current licence evidence. The owner enables recorded transfers in **Stock → Transfers**.
2. Assign staff to their working branches. Inventory staff submit and fill requests, scan stock, and receive deliveries. Transfer approval uses the existing second-person or eligible solo-owner PIN flow. Staff with pharmacy safety access can open **Stock → Warehouse** at their assigned sites to decide quality incidents and propose product temperature limits. Inventory access opens the operational queues. A catalogue reviewer approves product limits for all branches. An eligible owner follows the existing PIN approval flow when no other reviewer is available. Purchasing staff raise direct supplier requisitions for controlled medicines.
3. In **Stock → Warehouse → Setup**, enable the central store and select empty staging bins. Provide temperature-appropriate staging for refrigerated shipments. Configure the minimum remaining shelf life at each receiving branch. Label receiving, storage, and staging bins with their existing location codes. Print lot shelf labels from pharmacy inventory.
4. Count stock by bin and batch and reconcile discrepancies. Submit the labelled range for each refrigerated product in **Quality**. Confirm the approved range is visible before handling it and verify that its storage zones have current readings. Check that an online scanner enters the same product, lot, and bin identifiers as keyboard entry.

## Run and reconcile a delivery

Post a supplier goods receipt in **Buy → Receiving**. In the warehouse **Put-away** queue, verify the product and batch, scan the storage bin, and confirm the quantity. At a receiving branch, submit a request or accept a shortage suggestion. At the warehouse, compare available units with the request, reserve the quantity, pick into staging, pack, approve, and dispatch. Branch staff use **Arrivals** to record the quantity physically received, damage, and transport evidence. Resolve shortages through the transfer variance workflow.

For a controlled medicine, use the branch's **Direct purchase** request to create a draft purchasing requisition for supplier delivery to that site. For a temperature incident, record the quality decision and its evidence. Use the linked supplier-return or witnessed disposal workflow when the decision requires stock to leave the site.

## Decide whether to expand

Use the warehouse overview to compare requested and received units, elapsed time to receipt, bin-count accuracy, expiry write-offs, and unresolved transfer exceptions. The volume and time metrics use a rolling 30-day window. Overdue receipts appear after 48 hours in transit.

Run four exercises with identified pilot stock: two branches requesting the last eligible pack, a pick where the earliest lot misses the receiving branch's shelf-life floor, a recall after one shipment has left and another is packed, and a cold delivery with both a shortage and a temperature excursion. Reconcile the bin, staging, transit, receipt, hold, and journal records before enabling more sites.
