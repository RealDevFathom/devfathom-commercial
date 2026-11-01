-- WHA-1377: apply only to a NEW task-owned migrated disposable database.
-- Normal constraints/triggers stay enabled. Bootstrap is not sale-write workflow proof.
BEGIN;
INSERT INTO pharmacy_branches(id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt")
SELECT b,o,b,b,'Synthetic','Lahore','PB',now() FROM (VALUES
 ('b1','org_a'),('b2','org_a'),('history','org_a'),('semantics','org_a'),('b3','org_b')) v(b,o);
INSERT INTO pharmacy_patients(id,"organizationId","displayName","updatedAt")
SELECT c,o,'Synthetic',now() FROM (VALUES ('c1','org_a'),('old','org_a'),('new','org_a'),('c2','org_b')) v(c,o);
INSERT INTO pharmacy_customers(id,"organizationId","patientId","displayName","updatedAt")
SELECT id,"organizationId",id,'Synthetic',now() FROM pharmacy_patients;
INSERT INTO pharmacy_medicines(id,"organizationId","productName","productFamily","updatedAt")
VALUES ('m','org_a','Synthetic','PHARMACEUTICAL',now()), ('m_b','org_b','Synthetic','PHARMACEUTICAL',now());
INSERT INTO pharmacy_presentations(id,"organizationId","medicineId",presentation,"updatedAt")
VALUES ('p','org_a','m','Synthetic',now()), ('p_b','org_b','m_b','Synthetic',now());
INSERT INTO pharmacy_pack_levels(id,"organizationId","presentationId","versionGroupId",version,level,"unitsPerParent","effectiveFrom")
VALUES ('pack','org_a','p','pack',1,'UNIT',1,'2020-01-01'), ('pack_b','org_b','p_b','pack_b',1,'UNIT',1,'2020-01-01');
INSERT INTO pharmacy_manufacturing_batches(id,"organizationId","medicineId","batchNumber","expiresAt","updatedAt")
VALUES ('batch','org_a','m','Synthetic','2030-01-01',now());
INSERT INTO pharmacy_inventory_lots(id,"organizationId","branchId","manufacturingBatchId","packLevelId","unitsPerPack","supplierName","supplierInvoiceRef","unitCostMinor","printedMrpMinor","receivedExpiresAt","receivedExpiryPrecision","receivedAt","updatedAt")
SELECT b,'org_a',b,'batch','pack',1,'Synthetic',b,50,100,'2030-01-01','DAY','2020-01-01',now()
FROM (VALUES ('b1'),('semantics')) v(b);
INSERT INTO pharmacy_sales(id,"organizationId","branchId",status,"createdByUserId","completedAt","receiptNumber","customerId","createdAt","updatedAt")
SELECT id,o,b,'COMPLETED','synthetic',d::timestamp,1,c,d::timestamp,d::timestamp FROM (VALUES
 ('a','org_a','b1','2026-01-01','c1'),('b','org_a','b2','2026-01-31','c1'),
 ('anon','org_a','b1','2026-01-02',NULL),('foreign','org_b','b3','2026-01-02','c2'),
 ('new-first','org_a','history','2026-01-01','new'),('new-repeat','org_a','history','2026-01-31','new'),
 ('old-later','org_a','history','2026-01-03','old')) v(id,o,b,d,c);
INSERT INTO pharmacy_sales(id,"organizationId","branchId",status,"createdByUserId","completedAt","receiptNumber","customerId","createdAt","updatedAt")
SELECT 'old-'||i,'org_a','history','COMPLETED','synthetic',timestamp '2025-01-01'+i*interval '1 minute',i,'old',
 timestamp '2025-01-01'+i*interval '1 minute',now() FROM generate_series(1,10001) i;
-- Three selected originals, 1,203 lines: reproduce the reviewed nested-fetch defect.
INSERT INTO pharmacy_sale_lines(id,"organizationId","branchId","saleId","medicineId","presentationId","packLevelId","saleUnit",quantity,"canonicalUnitsPerSaleUnit","canonicalUnits","unitPriceMinor","grossMinor","proRataCeilingMinor","unitCostMinor","idempotencyKey","createdAt")
SELECT s.id||'-line',s."organizationId",s."branchId",s.id,
 CASE WHEN s."organizationId"='org_a' THEN 'm' ELSE 'm_b' END,
 CASE WHEN s."organizationId"='org_a' THEN 'p' ELSE 'p_b' END,
 CASE WHEN s."organizationId"='org_a' THEN 'pack' ELSE 'pack_b' END,
 'PACK',2402,1,2402,100,240200,100,50,s.id||'-line',s."createdAt"
FROM pharmacy_sales s;
INSERT INTO pharmacy_sale_lines(id,"organizationId","branchId","saleId","medicineId","presentationId","packLevelId","saleUnit",quantity,"canonicalUnitsPerSaleUnit","canonicalUnits","unitPriceMinor","grossMinor","proRataCeilingMinor","unitCostMinor","idempotencyKey","createdAt")
SELECT 'extra-'||i,'org_a','b1','a','m','p','pack','PACK',2,1,2,100,200,100,50,'extra-'||i,'2026-01-01' FROM generate_series(1,1200) i;
INSERT INTO pharmacy_tenders(id,"organizationId","branchId","saleId",type,"amountMinor","businessDate","actorId","deviceId","createdAt")
VALUES ('t','org_a','b1','a','CARD',480200,'2026-01-01','synthetic','synthetic','2026-01-01');
INSERT INTO pharmacy_refunds(id,"organizationId","branchId","saleId","originalTenderId","amountMinor","businessDate",reason,"actorId","createdAt")
SELECT 'refund-'||i,'org_a','b1','a','t',1,'2026-01-10','Synthetic','synthetic','2026-01-10' FROM generate_series(1,1201) i;
INSERT INTO pharmacy_sale_returns(id,"organizationId","branchId","originalSaleId","actorId",reason,"createdAt")
SELECT 'return-'||i,'org_a','b1','a','synthetic','Synthetic','2026-01-10' FROM generate_series(1,1201) i;
-- The return-lot guard (20261020000000) caps a lot's returns at what the line allocated from it.
INSERT INTO pharmacy_sale_line_allocations(id,"organizationId","branchId","saleLineId","inventoryLotId","stockLocationId","canonicalUnits","stockMovementId")
VALUES ('a-line-allocation','org_a','b1','a-line','b1','synthetic',2402,'synthetic-allocation');
INSERT INTO pharmacy_sale_return_lines(id,"organizationId","branchId","returnId","saleLineId","inventoryLotId","stockLocationId","canonicalUnits","integrityDecision","stockMovementId","createdAt")
SELECT 'return-line-'||i,'org_a','b1','return-'||i,'a-line','b1','synthetic',1,'RESTOCK','synthetic-'||i,'2026-01-10' FROM generate_series(1,1201) i;
-- Small semantic matrix, separate from the large transfer/history fixtures.
CREATE TEMP TABLE repeat_cases (id text, returned integer, refunded integer, return_at timestamp, header_at timestamp, refund_at timestamp) ON COMMIT DROP;
INSERT INTO repeat_cases VALUES
 ('normal',0,0,'2026-01-10','2026-01-10','2026-01-10'),
 ('full-return',2,0,'2026-01-10','2026-01-10','2026-01-10'),
 ('full-refund',0,200,'2026-01-10','2026-01-10','2026-01-10'),
 ('partial',1,100,'2026-01-10','2026-01-10','2026-01-10'),
 ('late-return',2,0,'2026-05-02','2026-05-02','2026-01-10'),
 ('late-header',2,0,'2026-01-10','2026-05-02','2026-01-10'),
 ('late-refund',0,200,'2026-01-10','2026-01-10','2026-05-02'),
 ('missing-number',0,0,NULL,NULL,NULL), ('missing-time',0,0,NULL,NULL,NULL),
 ('zero',0,0,NULL,NULL,NULL), ('late-line',0,0,NULL,NULL,NULL),
 ('late-import',0,0,NULL,NULL,NULL), ('derived',0,0,NULL,NULL,NULL),
 ('void',0,0,NULL,NULL,NULL), ('same-time',0,0,NULL,NULL,NULL),
 ('boundary-ms',0,0,NULL,NULL,NULL), ('anonymous',0,0,NULL,NULL,NULL);
INSERT INTO pharmacy_patients(id,"organizationId","displayName","updatedAt")
SELECT 'case-'||id,'org_a','Synthetic',now() FROM repeat_cases;
INSERT INTO pharmacy_customers(id,"organizationId","patientId","displayName","updatedAt")
SELECT 'case-'||id,'org_a','case-'||id,'Synthetic',now() FROM repeat_cases;
INSERT INTO pharmacy_sales(id,"organizationId","branchId",status,"createdByUserId","completedAt","receiptNumber","customerId","createdAt","updatedAt","originalSaleId")
SELECT 'case-'||id,'org_a','semantics',
 CASE WHEN id='void' THEN 'VOID' ELSE 'COMPLETED' END::"PharmacySaleStatus",'synthetic',
 CASE WHEN id='missing-time' THEN NULL ELSE timestamp '2026-01-01' END,
 CASE WHEN id='missing-number' THEN NULL ELSE 1 END,
 CASE WHEN id='anonymous' THEN NULL ELSE 'case-'||id END,
 CASE WHEN id='late-import' THEN timestamp '2026-05-02' ELSE timestamp '2026-01-01' END,now(),NULL
FROM repeat_cases WHERE id<>'derived';
INSERT INTO pharmacy_sales(id,"organizationId","branchId",status,"createdByUserId","completedAt","receiptNumber","customerId","createdAt","updatedAt","originalSaleId")
VALUES ('case-derived','org_a','semantics','COMPLETED','synthetic','2026-01-01',1,'case-derived','2026-01-01',now(),'case-normal');
INSERT INTO pharmacy_sales(id,"organizationId","branchId",status,"createdByUserId","completedAt","receiptNumber","customerId","createdAt","updatedAt")
SELECT 'repeat-'||id,'org_a','semantics','COMPLETED','synthetic',
 CASE WHEN id='same-time' THEN timestamp '2026-01-01' WHEN id='boundary-ms' THEN timestamp '2026-01-31 00:00:00.001' ELSE timestamp '2026-01-31' END,
 2,CASE WHEN id='anonymous' THEN NULL ELSE 'case-'||id END,'2026-01-01',now() FROM repeat_cases;
INSERT INTO pharmacy_sale_lines(id,"organizationId","branchId","saleId","medicineId","presentationId","packLevelId","saleUnit",quantity,"canonicalUnitsPerSaleUnit","canonicalUnits","unitPriceMinor","grossMinor","proRataCeilingMinor","unitCostMinor","idempotencyKey","createdAt")
SELECT s.id||'-line','org_a','semantics',s.id,'m','p','pack','PACK',2,1,2,
 CASE WHEN s.id='case-zero' THEN 0 ELSE 100 END,
 CASE WHEN s.id='case-zero' THEN 0 ELSE 200 END,100,50,s.id||'-line',
 CASE WHEN s.id='case-late-line' THEN timestamp '2026-05-02' ELSE timestamp '2026-01-01' END
FROM pharmacy_sales s WHERE s."branchId"='semantics';
INSERT INTO pharmacy_tenders(id,"organizationId","branchId","saleId",type,"amountMinor","businessDate","actorId","deviceId","createdAt")
SELECT 't-'||id,'org_a','semantics','case-'||id,'CARD',200,'2026-01-01','synthetic','synthetic','2026-01-01' FROM repeat_cases WHERE refunded>0;
INSERT INTO pharmacy_refunds(id,"organizationId","branchId","saleId","originalTenderId","amountMinor","businessDate",reason,"actorId","createdAt")
SELECT 'f-'||id,'org_a','semantics','case-'||id,'t-'||id,refunded,refund_at::date,'Synthetic','synthetic',refund_at FROM repeat_cases WHERE refunded>0;
INSERT INTO pharmacy_sale_returns(id,"organizationId","branchId","originalSaleId","actorId",reason,"createdAt")
SELECT 'r-'||id,'org_a','semantics','case-'||id,'synthetic','Synthetic',header_at FROM repeat_cases WHERE returned>0;
INSERT INTO pharmacy_sale_line_allocations(id,"organizationId","branchId","saleLineId","inventoryLotId","stockLocationId","canonicalUnits","stockMovementId")
SELECT 'alloc-'||id,'org_a','semantics','case-'||id||'-line','semantics','synthetic',2,'sm-alloc-'||id FROM repeat_cases WHERE returned>0;
INSERT INTO pharmacy_sale_return_lines(id,"organizationId","branchId","returnId","saleLineId","inventoryLotId","stockLocationId","canonicalUnits","integrityDecision","stockMovementId","createdAt")
SELECT 'rl-'||id,'org_a','semantics','r-'||id,'case-'||id||'-line','semantics','synthetic',returned,'RESTOCK','sm-'||id,return_at FROM repeat_cases WHERE returned>0;
COMMIT;

-- Plan against the loaded cardinalities immediately, without waiting for autovacuum.
-- Empty-table estimates choose repeated nested-loop scans for 10,004 history receipts.
ANALYZE pharmacy_sales;
ANALYZE pharmacy_sale_lines;
ANALYZE pharmacy_sale_returns;
ANALYZE pharmacy_sale_return_lines;
ANALYZE pharmacy_refunds;
