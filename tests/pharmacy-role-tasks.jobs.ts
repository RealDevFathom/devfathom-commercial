import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { pin, type PharmacyFixture } from './pharmacy-role-tasks.fixture';

export function tasks(f: PharmacyFixture) {
  const { branchId, as, businessDate, id, tenant } = f;
  const subject = as('subject'),
    editor = as('editor'),
    cashier = as('cashier');
  const deviceId = id('main-till');
  async function sale() {
    return cashier.pharmacySales.create({ branchId, deviceId });
  }
  function line(saleId: string, p: typeof f.otc) {
    return {
      saleId,
      branchId,
      medicineId: p.medicineId,
      presentationId: p.presentationId,
      packLevelId: p.packLevelId,
      saleUnit: 'STRIP' as const,
      quantity: 1,
      canonicalUnitsPerSaleUnit: 1,
      idempotencyKey: randomUUID(),
    };
  }
  async function pay(saleId: string, who = subject, device = deviceId) {
    const cart = await cashier.pharmacySales.counterCart({ branchId, saleId });
    const amountMinor = cart.totals.netMinor;
    expect(amountMinor).toBeGreaterThan(0);
    const result = await who.pharmacySales.tender({
      branchId,
      saleId,
      deviceId: device,
      businessDate,
      type: 'CASH',
      amountMinor,
      cashReceivedMinor: amountMinor,
      idempotencyKey: randomUUID(),
    });
    expect(result).toMatchObject({ settled: true });
    expect(
      await tenant((db) => db.pharmacyTender.findFirstOrThrow({ where: { saleId } }))
    ).toMatchObject({ amountMinor });
  }
  async function order(who = as('buyer'), product = f.otc) {
    const po = await who.pharmacyPurchasing.createPurchaseOrder({
      reference: randomUUID(),
      supplierId: f.supplier.id,
      branchId,
      lines: [
        {
          medicineId: product.medicineId,
          packLevelId: product.packLevelId,
          orderedPacks: 2,
          canonicalUnitsPerPack: 1,
          listPricePerPackMinor: 100,
        },
      ],
    });
    const submitted = await who.pharmacyPurchasing.submitPurchaseOrder({ purchaseOrderId: po.id });
    expect(submitted.status).toBe('SUBMITTED');
    return po;
  }
  async function goodsReceipt(receiver: typeof subject, product: typeof f.otc) {
    const po = await order(as('buyer'), product);
    await editor.pharmacyPurchasing.approvePurchaseOrder({
      purchaseOrderId: po.id,
      decision: 'APPROVED',
    });
    await editor.pharmacyPurchasing.sendPurchaseOrder({ purchaseOrderId: po.id });
    const receipt = await receiver.pharmacyPurchasing.createGoodsReceipt({
      reference: randomUUID(),
      branchId,
      supplierId: f.supplier.id,
      purchaseOrderId: po.id,
      supplierInvoiceRef: randomUUID(),
      supplierInvoiceDate: businessDate,
      warrantyEvidenceRef: 'test-warranty',
      receivedAt: new Date(),
      qualifiedPersonUserId: id('user_witness'),
      lines: [
        {
          purchaseOrderLineId: (
            await tenant((db) =>
              db.pharmacyPurchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } })
            )
          ).id,
          medicineId: product.medicineId,
          packLevelId: product.packLevelId,
          batchNumber: randomUUID(),
          printedExpiry: new Date('2099-01-01'),
          printedMrpMinor: 1000,
          expiryPrecision: 'DAY',
          canonicalUnitsPerPack: 1,
          receivedPacks: 2,
          invoicedPricePerPackMinor: 100,
          stockLocationId: f.location.id,
        },
      ],
    });
    await receiver.pharmacyPurchasing.postGoodsReceipt({
      branchId,
      goodsReceiptId: receipt.id,
      staffProfileId: id('staff_witness'),
      approvalPin: pin,
      pin,
    });
    expect(
      await tenant((db) => db.pharmacyGoodsReceipt.findFirstOrThrow({ where: { id: receipt.id } }))
    ).toMatchObject({ status: 'POSTED' });
    return tenant((db) =>
      db.pharmacyGoodsReceiptLine.findFirstOrThrow({ where: { goodsReceiptId: receipt.id } })
    );
  }
  return {
    async sell() {
      const device = id('sell-till');
      await subject.pharmacySales.openDrawer({
        branchId,
        deviceId: device,
        businessDate,
        openingFloatMinor: 0,
      });
      const bill = await subject.pharmacySales.create({ branchId, deviceId: device });
      await subject.pharmacySales.addLine(line(bill.id, f.otc));
      await pay(bill.id, subject, device);
    },
    async prescription() {
      const bill = await sale();
      const added = await subject.pharmacySales.addLine({
        ...line(bill.id, f.rx),
        prescription: { prescriptionLineId: f.rx.prescriptionLineId, patientId: f.patient.id },
      });
      assert('line' in added, 'The prescription line must be accepted before it is signed.');
      const review = await tenant((db) =>
        db.pharmacyPharmacistReviewItem.findFirstOrThrow({ where: { saleLineId: added.line.id } })
      );
      await as('witness').pharmacyDispensing.decideReview({
        reviewItemId: review.id,
        kind: 'SIGN',
      });
      await pay(bill.id, as('editor'));
    },
    async controlled() {
      const bill = await sale();
      const added = await subject.pharmacySales.addLine({
        ...line(bill.id, f.controlled),
        controlledAuthorization: {
          patientId: f.patient.id,
          prescriptionLineId: f.controlled.prescriptionLineId,
          patientAddress: '1 Synthetic Rd',
          staffProfileId: id('staff_witness'),
          pin,
          rxSerialWritten: true,
          emergency: false,
        },
      });
      expect(added).toHaveProperty('line.id');
      const entry = await tenant((db) =>
        db.pharmacyControlledRegisterEntry.findFirstOrThrow({
          where: { prescriptionLineId: f.controlled.prescriptionLineId },
        })
      );
      expect(entry).toMatchObject({ witnessedByUserId: id('user_witness') });
      await pay(bill.id, editor);
    },
    async catalogue() {
      const productName = 'Reviewed test product';
      const edit = await editor.pharmacyMedicine.proposeCatalogueEdit({
        medicineId: f.otc.medicineId,
        changes: { productName },
      });
      await subject.pharmacyMedicine.decideCatalogueEdit({
        editId: edit.id,
        decision: 'APPROVE',
        soloPin: pin,
      });
      expect(
        await tenant((db) => db.medicine.findFirstOrThrow({ where: { id: f.otc.medicineId } }))
      ).toMatchObject({ productName });
    },
    async import() {
      const name = 'Synthetic imported tablet';
      const batch = await f.staging.stageBatch({
        branchId,
        fileName: 'test.csv',
        content: Buffer.from('Product,Pack,MRP\n' + name + ',10,30.00').toString('base64'),
        mapping: { product: 0, pack: 1, mrp: 2 },
      });
      const edit = await editor.pharmacyMedicine.createStagedMedicines({
        batchId: batch.batchId,
        branchId,
      });
      assert('id' in edit, 'The import needs a persisted edit to review.');
      const queue = await subject.pharmacyMedicine.catalogueEdits();
      expect(queue.find((e) => e.id === edit.id)).toBeDefined();
      if (f.role !== 'owner') {
        const preview = await subject.pharmacyMedicine.proposedImport({ editId: edit.id });
        expect(preview.rows).toEqual([expect.objectContaining({ productName: name })]);
      }
      await subject.pharmacyMedicine.decideCatalogueEdit({
        editId: edit.id,
        decision: 'APPROVE',
        soloPin: pin,
      });
      await subject.pharmacyMedicine.runStagedMedicineCreation({ batchId: batch.batchId });
      expect(await tenant((db) => db.medicine.count({ where: { productName: name } }))).toBe(1);
    },
    async raisePurchase() {
      await order(subject);
    },
    async approvePurchase() {
      const po = await order();
      await subject.pharmacyPurchasing.approvePurchaseOrder({
        purchaseOrderId: po.id,
        decision: 'APPROVED',
      });
      expect(
        await tenant((db) => db.pharmacyPurchaseOrder.findFirstOrThrow({ where: { id: po.id } }))
      ).toMatchObject({ status: 'APPROVED' });
    },
    async receive() {
      await goodsReceipt(subject, f.otc);
    },
    async adjust() {
      const position = {
        branchId,
        inventoryLotId: f.otc.lotId,
        stockLocationId: f.location.id,
        disposition: 'AVAILABLE' as const,
      };
      const balance = () =>
        tenant((db) => db.pharmacyStockBalance.findFirstOrThrow({ where: position }));
      const before = await balance();
      const count = await subject.pharmacyInventory.createCount({
        branchId,
        varianceThreshold: 2,
        readings: [
          {
            inventoryLotId: f.otc.lotId,
            stockLocationId: f.location.id,
            countedSealedPacks: before.sealedPacks - 1,
            countedLooseUnits: before.looseUnits,
          },
        ],
      });
      await subject.pharmacyInventory.approveCount({
        branchId,
        countId: count.id,
        idempotencyKeyPrefix: randomUUID(),
        varianceReason: 'Verified physical count',
      });
      expect((await balance()).onHandUnits).toBe(before.onHandUnits - 1);
    },
    async closeShift() {
      const drawer = await editor.pharmacySales.openDrawer({
        branchId,
        deviceId: id('shift-till'),
        businessDate,
        openingFloatMinor: 0,
      });
      const shift = await tenant((db) =>
        db.pharmacyCashShift.findFirstOrThrow({ where: { drawerSessionId: drawer.id } })
      );
      // Cashiers close their own shift. Managers can also close another cashier's shift.
      let shiftId = shift.id;
      if (['cashier', 'pharmacist-cashier', 'owner', 'owner-operator'].includes(f.role)) {
        const own = await subject.pharmacySales.openDrawer({
          branchId,
          deviceId: id('own-till'),
          businessDate,
          openingFloatMinor: 0,
        });
        shiftId = (
          await tenant((db) =>
            db.pharmacyCashShift.findFirstOrThrow({ where: { drawerSessionId: own.id } })
          )
        ).id;
      }
      await subject.pharmacySales.closeShift({ branchId, shiftId, countedCashMinor: 0 });
      expect(
        await tenant((db) => db.pharmacyCashShift.findFirstOrThrow({ where: { id: shiftId } }))
      ).toMatchObject({ status: 'CLOSED' });
    },
    async closeDay() {
      const branchId = f.closeBranchId;
      const countedCashMinor = 500;
      const drawer = await editor.pharmacySales.openDrawer({
        branchId,
        deviceId: id('close-till'),
        businessDate,
        openingFloatMinor: countedCashMinor,
        operatingCashierId: id('user_cashier'),
      });
      const shift = await tenant((db) =>
        db.pharmacyCashShift.findFirstOrThrow({ where: { drawerSessionId: drawer.id } })
      );
      await cashier.pharmacySales.closeShift({ branchId, shiftId: shift.id, countedCashMinor });
      const preview = await subject.pharmacySales.closePreview({ branchId, businessDate });
      expect(preview.drawers).toEqual([
        expect.objectContaining({ id: drawer.id, expectedMinor: countedCashMinor }),
      ]);
      const closed = await subject.pharmacySales.closeDay({
        branchId,
        businessDate,
        sourceHash: preview.totals.sourceHash,
        counts: [{ drawerSessionId: drawer.id, countedCashMinor }],
        varianceNote: '',
      });
      expect(closed).toMatchObject({ branchId, businessDate });
      expect(
        await tenant((db) =>
          db.pharmacyDrawerSession.findFirstOrThrow({ where: { id: drawer.id } })
        )
      ).toMatchObject({ status: 'CLOSED', countedCashMinor });
    },
    async supplierPayment() {
      const posted = await subject.pharmacyFinance.post({
        branchId,
        kind: 'SUPPLIER_PAYMENT',
        amountMinor: 1000,
        idempotencyKey: randomUUID(),
        reference: randomUUID(),
        occurredAt: new Date(),
        counterpartyName: f.supplier.name,
      });
      expect(
        await tenant((db) =>
          db.pharmacyBookkeepingTransaction.findFirstOrThrow({ where: { id: posted.id } })
        )
      ).toMatchObject({ kind: 'SUPPLIER_PAYMENT', amountMinor: 1000 });
    },
    async reports() {
      const day = businessDate.toISOString().slice(0, 10);
      const report = await subject.pharmacyReports.dailyWorkPack({
        branchId,
        from: day,
        to: day,
        asOf: new Date().toISOString(),
      });
      expect(report.mode).toBe('read-only-preparation');
      const kinds = ['stock-dashboard', 'stock-digest'];
      if (f.role === 'owner' || f.role === 'owner-operator')
        kinds.push('anomalies', 'expiry', 'supplier-credit');
      expect(report.sources.map((source) => source.kind)).toEqual(kinds);
      expect(
        report.sources.every(
          (source) => source.scope.branchId === branchId && source.status === 'available'
        )
      ).toBe(true);
    },
    async discount() {
      const bill = await subject.pharmacySales.create({ branchId, deviceId });
      const original = await subject.pharmacySales.addLine(line(bill.id, f.otc));
      assert('line' in original, 'The discount must apply to an accepted sale line.');
      await subject.pharmacySales.discountBillLine({
        branchId,
        saleId: bill.id,
        saleLineId: original.line.id,
        deviceId,
        requestId: randomUUID(),
        discount: { kind: 'AMOUNT', minor: 50 },
        discountApproval: { staffProfileId: id('staff_supervisor'), pin },
      });
      const discounted = await cashier.pharmacySales.counterCart({ branchId, saleId: bill.id });
      expect(discounted.totals.netMinor).toBe(950);
    },
    async team() {
      const target = id('user_teammate');
      await subject.organizationAdmin.updateMember({
        id: target,
        status: 'ACTIVE',
        role: 'EMPLOYEE',
        department: 'LEADERSHIP',
        organizationRoleId: id('inventory'),
        title: 'Senior inventory clerk',
      });
      expect(
        await tenant((db) => db.user.findFirstOrThrow({ where: { id: target } }))
      ).toMatchObject({ title: 'Senior inventory clerk' });
    },
    async controlledReturn() {
      const posted = await goodsReceipt(editor, f.controlled);
      expect(posted.inventoryLotId).toBeTruthy();
      const purchaseReturn = await subject.pharmacyPurchasing.createPurchaseReturn({
        branchId,
        supplierId: f.supplier.id,
        kind: 'PURCHASE_RETURN',
        reference: randomUUID(),
        lines: [
          {
            inventoryLotId: posted.inventoryLotId!,
            stockLocationId: f.location.id,
            quantityUnits: 1,
            expectedCreditMinor: 100,
            reason: 'Supplier collection',
            returnWindowEndsAt: new Date('2099-01-01'),
          },
        ],
      });
      const input = { branchId, purchaseReturnId: purchaseReturn.id };
      await subject.pharmacyPurchasing.submitPurchaseReturn(input);
      await subject.pharmacyPurchasing.dispatchPurchaseReturn({
        ...input,
        idempotencyKey: randomUUID(),
        controlledWitness: { staffProfileId: id('staff_witness'), pin },
      });
      expect(
        await tenant((db) =>
          db.pharmacyPurchaseReturn.findFirstOrThrow({ where: { id: purchaseReturn.id } })
        )
      ).toMatchObject({ status: 'DISPATCHED' });
    },
    async refund() {
      const bill = await sale();
      const key = randomUUID();
      const attempt = await tenant(async (db) => {
        const a = await db.pharmacyCardTerminalAttempt.create({
          data: {
            branchId,
            saleId: bill.id,
            deviceId,
            terminalId: 'test',
            provider: 'FAKE_TERMINAL',
            attemptKey: key,
            amountMinor: 1000,
            currency: 'PKR',
            businessDate,
            actorId: id('user_cashier'),
          },
        });
        await db.pharmacyCardTerminalAttempt.update({
          where: { id: a.id },
          data: { status: 'SENT', sentAt: new Date() },
        });
        return db.pharmacyCardTerminalAttempt.update({
          where: { id: a.id },
          data: { status: 'MANUAL_REVIEW', reviewReason: 'Synthetic slip' },
        });
      });
      await editor.pharmacyCardTerminal.resolveReview({
        branchId,
        attemptKey: key,
        outcome: 'DECLINED',
        resolutionReason: 'Original synthetic decision',
        slipRef: 'fixture-slip',
        managerPin: pin,
      });
      const previousId = 'review:' + attempt.id;
      await subject.pharmacyCardTerminal.recordRefundAction({
        branchId,
        previousId,
        kind: 'OWED',
        verifiedAmountMinor: 1000,
        commandKey: randomUUID(),
        resolutionReason: 'Checked synthetic statement',
        slipRef: 'fixture-slip',
        managerPin: pin,
      });
      expect(
        await tenant((db) =>
          db.pharmacyTerminalRefundEvent.findFirstOrThrow({ where: { previousId } })
        )
      ).toMatchObject({ kind: 'OWED', amountMinor: 1000, actorId: id('user_subject') });
    },
  };
}
