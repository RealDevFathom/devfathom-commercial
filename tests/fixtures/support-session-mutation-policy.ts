/**
 * DEV-1053: the decision for every tRPC mutation: may a platform support session run it?
 *
 * `tests/support-session-mutation-policy.test.ts` fails when a mutation is missing from this
 * file, listed twice, or listed in a way the code does not enforce. Adding a mutation means
 * adding it here, under "may" or "may not".
 *
 * May not: anything that creates or changes a credential, an identity or a privilege, because
 * it would outlive the support session. Those procedures carry `.meta(refuseSupportSession)`
 * and the central rule in `src/server/trpc.ts` refuses them.
 *
 * May: reading, and fixing the data a ticket is about.
 */

/** Refused by the central rule. Keys are paths; `standalone:` marks a router outside `appRouter`. */
export const SUPPORT_MAY_NOT: ReadonlyArray<{ reason: string; mutations: readonly string[] }> = [
  {
    reason:
      'Members: creating, inviting, activating or deactivating a member, or changing who a member is.',
    mutations: [
      'organizationAdmin.createMember',
      'organizationAdmin.updateMember',
      'team.inviteMember',
      'team.adminUpdateMember',
      'team.layOffMember',
      'resignations.review',
      'restaurantStaff.create',
      'restaurantStaff.invite',
      'restaurantStaff.setStatus',
      'restaurantStaff.update',
      'restaurantStaff.provisionMyProfile',
    ],
  },
  {
    reason: 'Roles, permissions and sub-roles, and which branch or property a member may act at.',
    mutations: [
      'organizationAdmin.applyMemberRoleTemplate',
      'organizationAdmin.setMemberSubRole',
      'organizationAdmin.setRoleSubRole',
      'organizationAdmin.upsertRole',
      'organizationAdmin.removeRole',
      'pharmacyBranchAssignments.assign',
      'pharmacyBranchAssignments.unassign',
      'hotelProperty.access.assign',
      'hotelProperty.access.revoke',
      'pharmacySop.setRoleHolding',
      'restaurantStaff.clearStaffCapabilityOverride',
      'restaurantStaff.createJobRole',
      'restaurantStaff.seedDefaultJobRoles',
      'restaurantStaff.setJobRoleCapabilities',
      'restaurantStaff.setStaffAccess',
      'restaurantStaff.setStaffCapabilityOverride',
      'restaurantStaff.setStaffJobRoles',
      'restaurantStaff.updateJobRole',
    ],
  },
  {
    reason: 'Passwords and signed-in sessions.',
    mutations: [
      'organizationAdmin.resetMemberPassword',
      'team.adminResetPassword',
      'team.changePassword',
      'team.signOutEverywhere',
    ],
  },
  {
    reason: 'PINs and operator credentials.',
    mutations: [
      'pharmacyPurchasing.provisionMyPurchasePin',
      'restaurantStaff.issueCredential',
      'restaurantStaff.revokeCredential',
      'restaurantStaff.rotateCredential',
      'standalone:pharmacyPrepaid.setPin',
    ],
  },
  {
    reason: 'Two-step verification and approval authenticators.',
    mutations: [
      'twoFactor.beginEnrollment',
      'twoFactor.confirmEnrollment',
      'twoFactor.disable',
      'approvalAuthenticator.beginEnrollment',
      'approvalAuthenticator.confirmEnrollment',
      'approvalAuthenticator.resetForMember',
      'approvalAuthenticator.setRequired',
      'approvalAuthenticator.useRecoveryCode',
    ],
  },
  {
    reason: 'API tokens and SCIM tokens.',
    mutations: [
      'apiTokens.create',
      'apiTokens.revoke',
      'organizationAdmin.createScimToken',
      'organizationAdmin.revokeScimToken',
    ],
  },
  {
    reason:
      'Webhook and integration secrets, connected mailboxes, and the hosts the business signs in on.',
    mutations: [
      'webhooks.create',
      'webhooks.update',
      'webhooks.delete',
      'restaurantNotifications.configureWebhook',
      'restaurantNotifications.deleteWebhook',
      'organizationAdmin.updateEmail',
      'email.connectStart',
      'email.connectCallback',
      'email.disconnect',
      'organizationAdmin.addDomain',
    ],
  },
  {
    reason: 'Device enrolment and device credentials.',
    mutations: [
      'restaurantDevices.initiateEnrollment',
      'restaurantDevices.initiatePrintBridgeEnrollment',
      'restaurantDevices.revoke',
      'restaurantDevices.rotate',
      'pharmacyOffline.enroll',
      'pharmacyOffline.rotate',
      'pharmacyOffline.revoke',
      'pharmacyPrinting.enrollBridge',
      'pharmacyPrinting.revokeBridge',
      'pharmacyInventory.enrollColdChainSensor',
      'pharmacyInventory.revokeColdChainSensor',
      'pharmacyInventory.rotateColdChainSensorSecret',
      'pharmacyCameras.enrollGateway',
      'pharmacyCameras.register',
      'pharmacyCameras.configure',
      'pharmacyCameras.issueViewerGrant',
      'pharmacyCameras.revokeViewerGrant',
    ],
  },
  {
    reason: 'Access links handed to people outside the business.',
    mutations: [
      'meetings.createGuestInvitation',
      'meetings.revokeGuestInvitation',
      'pharmacyOrdering.portalLink',
      'pharmacySupplierLinks.issue',
      'pharmacySupplierLinks.revoke',
    ],
  },
];

/**
 * Refused for every support session by the router's own rule, which predates the central one
 * and is kept exactly as it was, with its own wording.
 */
export const SUPPORT_MAY_NOT_BY_ROUTER: ReadonlyArray<{
  reason: string;
  mutations: readonly string[];
}> = [
  {
    reason:
      'Restaurant cameras and pharmacy live viewing: a bare FORBIDDEN, checked together with the camera module and the vertical. Proved by restaurant-cameras.access.test.ts and pharmacy-cameras.live.test.ts.',
    mutations: [
      'restaurantCameras.enrollGateway',
      'restaurantCameras.issueStreamGrant',
      'restaurantCameras.register',
      'restaurantCameras.revokeGateway',
      'restaurantCameras.rotateGatewaySecret',
      'restaurantCameras.setRetention',
      'restaurantCameras.testConnection',
      'pharmacyCameras.issueLiveViewGrant',
      'pharmacyCameras.configuredConnectionDiagnostics',
    ],
  },
  {
    reason:
      'Pharmacy staff PINs: both resolvers refuse a support session with "A support session cannot set or reset a PIN." Proved by pharmacy-pin.test.ts.',
    mutations: ['pharmacyPin.resetForMember', 'pharmacyPin.setMine'],
  },
  {
    reason:
      'Owner-only control settings (who must approve, how much discount, cash mode): each resolver refuses a support session with its own owner-only message.',
    mutations: [
      'pharmacyBranchAssignments.setCashMode',
      'pharmacyPharmacistCheck.setPolicy',
      'pharmacyRxSoloShift.setPolicy',
      'pharmacySupplierCompliance.setPolicy',
      'pharmacySales.saveDiscountMaximum',
      'pharmacySales.saveBillDiscountSetting',
    ],
  },
];

/**
 * Support may: every other mutation, by router. Ordinary business data and settings; none
 * creates a member, a credential or a permission. Close calls are explained in
 * `SUPPORT_MAY_NOTES`.
 */
export const SUPPORT_MAY: Readonly<Record<string, string>> = {
  aiSettings:
    'reset setFallbackEnabled setMode setMonthlyCap setProviderOrder setTierModel upsertModelPrice',
  chat: 'addMembers archiveChannel createChannel createOrGetDM deleteChannel deleteMessage editMessage joinChannel leaveChannel markRead removeMember sendMessage setMuted togglePin toggleReaction toggleSave updateChannel',
  clients:
    'addContact addContract create delete deleteContact deleteContract generateInvoiceFromContract setContractStatus sweepExpiredContracts update updateContact updateContract',
  dashboard: 'updateAppearance updatePreferences',
  email: 'markRead refresh sendMessage',
  finance:
    'addPayment createInvoice createRecurringExpense createTransaction deletePayment deleteRecurringExpense deleteTransaction markOverdueInvoices postDueRecurringExpenses sendInvoiceEmail updateInvoice updateInvoiceStatus updateTransaction',
  'hotelProperty.extras': 'create setActive update',
  'hotelProperty.inventory.beds': 'setStatus',
  'hotelProperty.inventory.blocks': 'create release',
  'hotelProperty.inventory.roomTypes': 'create',
  'hotelProperty.inventory.rooms': 'create setStatus',
  'hotelProperty.journeyTemplates': 'approve retire save',
  'hotelProperty.modes': 'set',
  'hotelProperty.spaces.bookings': 'hold release',
  'hotelProperty.spaces': 'create setActive update',
  hotelProperty: 'update',
  'hotelRates.mealPlans': 'create setActive update',
  invitations: 'accept',
  meetings:
    'cancelOccurrence create delete logJoin logLeave markJoined rescheduleOccurrence update',
  notes: 'create delete restoreRevision setShares update',
  organizationAdmin:
    'removeDepartment retryDomain setAskFathomEnabled setDeepStrategyEnabled updateBrand updateProfile upsertDepartment',
  passwordReset: 'request reset',
  pharmacyApInvoices:
    'approveCreditSetOff pay record rejectCreditSetOff requestCreditSetOff reverseCreditSetOff reverseInvoice reverseSettlement',
  pharmacyBranchAssignments: 'setOtherBranchAvailability',
  pharmacyCameras: 'capturePending setRetention testConnection',
  pharmacyCardTerminal: 'charge checkStatus recordRefundAction resolveReview',
  pharmacyDispensing: 'decideReview enqueueReview recordSubstitution selfSignReview',
  pharmacyFinance:
    'closePeriod createSettlementBatch importBankLine post publishTaxProfile reconcile reopenPeriod reverse',
  pharmacyGeneralJournal: 'cancelDraft createDraft post reverse updateDraft',
  pharmacyInventory:
    'acknowledgeRecall acknowledgeSignal allocateForSale allocateRequestedTransfer allocateTransfer approveCount approveSafetyStock approveTransfer breakPack closeRecall configureTemperatureMonitoring confirmDrapPrice confirmDrapRecall createCount createDraftAction createLocation createRecall dismissDrapRecall dismissSignal dispatchTransfer draftExpiryMarkdown draftExpiryReturn draftExpiryReturnClaim importTemperatureCsv ingestDrapFile ingestDrapManual markStaleSignals quarantineExpiring quarantinePart receiveLot receiveTransferLine receiveTransferWithVariance recordTemperature recordUnrecordedBatch refreshStockSignals registerBatch releaseQuarantinedPart reserveSupplierClaim reverseDrapRecall setBatchState setBranchTransfersEnabled snoozeSignal transfer writeOff',
  pharmacyInvoiceCapture: 'read',
  pharmacyMarketing:
    'approve approveTemplate assist attributeReceipts capture createDraft generateBaskets generateGrowth issueVoucher profileHealth resumeSending reviewBasket reviewGrowth reviewReply revokeVoucher sandbox sandboxDue updateSendPolicy',
  pharmacyMedicine:
    'addAlias addBarcode addMedicineDraft configureReferenceConnector confirmPrices createIngredient createMedicine createPackLevel createStagedMedicines decideCatalogueEdit decideReferenceConnectorProposal dismissDrapPriceAlert ingestPriceNotices proposeCatalogueEdit publishAssertions recordPrintedMrp recordReviewDecision revisePackLevel runReferenceConnectorNow runStagedMedicineCreation setPackBarcode setPackPrice setRetailDetails supersedePublication',
  pharmacyOffline: 'recordUnsentOfflineSale setOfflineCashSelling',
  pharmacyOnboarding:
    'recordFbrTier1Check recordGate savePharmacistCoverage saveRegulatoryProfile setBranchProvince',
  pharmacyOrdering:
    'approveSubscriptionCycle cancelMine complete createSubscription deliveryCommand openDueSubscriptionCycles openSubscriptionCycle place portalConfirmPayment portalDecide releaseSubscriptionCycle setSubscriptionStatus startCheckout startSubscriptionCycleCheckout transition',
  pharmacyOwnerImport: 'commit preview upload',
  pharmacyPackLabel: 'read',
  pharmacyPrescriptions:
    'capture captureRefillReminder createPatient createPrescriber draftCartFromSource extractSource fill recordConsent uploadSource',
  pharmacyPrinting: 'enqueueReceipt retryJob',
  pharmacyPurchasing:
    'allocateCentralReceipt allocateSupplierCredit approvePurchaseOrder authenticatePack createCentralPurchaseOrder createGoodsReceipt createPurchaseOrder createPurchaseReturn createRequisition createSupplier decideReceiptDebitNote dispatchPurchaseReturn ignoreLostDemandAdvice issueDebitNote postGoodsReceipt recordQuote recordSupplierCredit recordSupplierLicence requestLostDemandTransfer resolveReceivingException reverseGoodsReceipt sendPurchaseOrder setLostDemandTriggerSettings setSupplierAuthorization submitPurchaseOrder submitPurchaseReturn submitRequisition verifySupplierLicence',
  pharmacyReports:
    'acknowledgeAnomaly acknowledgePackAuthenticationFlag createPharmacovigilanceReport deleteSeasonalWindow proposeExpiryReturn recordPharmacovigilanceSubmission refreshAnomalies saveSeasonalWindow snoozeAnomaly transitionPharmacovigilanceReport updateDigestSetting updatePreferences',
  pharmacySafety:
    'approveRegisterIncident installSopLibrary recordCorrection recordLegalHold setRetentionClass',
  pharmacySales:
    'acknowledgeDuplicateSalt addLine addRestockInterest applyBillDiscount authenticatePack captureDemand captureSafeRestockArrival changeLine checkBillLinePack closeDay closeDrawer closeShift counterReceiptBrowserPrint counterReceiptBrowserPrintDispatched counterReceiptBrowserPrintFailed counterReceiptPrintJob counterReceiptWhatsApp counterSaveKeymap counterSaveReceiptFormat create createPromotion dailyClose declineSubstitute disablePromotion discardTenderAttempt discountBillLine drawerMovement handoverDrawer khataSignup linkCustomer linkRestockRecoveries openDrawer openShift optOutRestockInterest recordCompetitorPrice recordCounterDemand recordKhataPayment recoverDemand recoverRestockInterest redeemPoints refundTender removeLine reopenDay returnAndRefund returnLine returnLines sandboxPayment saveDayEndHour saveDiscountPolicy saveKhataReminderSettings saveManualPaymentSettings scanLoyaltyCard setDemandOutcome settleLostSales tender transition updateLostSalesSettings',
  pharmacySop:
    'addReworkNote claim completeStep createAssignment enableSite generate installLibrary joinSite linkRecord reject setAssignmentActive setAutoSchedule setOverdueEscalation start startOnDemand submit verify',
  pharmacySupplierLinks: 'approveProposal createRelationship recordManual submit',
  pharmacySupplierPriceLists: 'decide import',
  projects:
    'addBlocker addChecklistItem addComment addFile addLabelToTask addMember addTaskAttachment bulkDeleteTasks bulkMoveTasks create createBoard createChecklist createColumn createLabel createMilestone createTask delete deleteBoard deleteChecklist deleteChecklistItem deleteColumn deleteComment deleteFile deleteLabel deleteMilestone deleteTask deleteTaskAttachment deleteTimeEntry logTime moveTask removeBlocker removeLabelFromTask removeMember renameChecklist renameChecklistItem reorderColumns setColumnDefaultAssignees setMemberRole setTaskParent toggleChecklistItem update updateBoard updateColumn updateComment updateLabel updateMilestone updateTask updateTaskAssignees updateTimeEntry',
  resignations: 'submit withdraw',
  restaurantBranches: 'create setActive update',
  restaurantCatalog:
    'activateRecipeVersion addRecipeLineSubstitute attachIngredientAllergen attachModifierGroup attachProductAllergen createAllergen createBrand createCategory createComboGroup createComboOption createIngredient createModifierGroup createModifierOption createProduct createRecipe createRecipeLine createRecipeVersion createUnit createVariant deleteAllergen deleteCategory deleteComboGroup deleteComboOption deleteConversion deleteModifierGroup deleteModifierOption deleteRecipeLine deleteUnit deleteVariant detachIngredientAllergen detachModifierGroup detachProductAllergen ensureDefaultBrand removeRecipeLineSubstitute setBrandStatus setDefaultBrand setProductStatus updateAllergen updateBrand updateCategory updateComboGroup updateComboOption updateIngredient updateModifierGroup updateModifierOption updateProduct updateRecipeLine updateRecipeVersion updateUnit updateVariant upsertConversion',
  restaurantCatering:
    'addExtraCost addLine approveQuote create publishQuote recordDisposition removeExtraCost removeLine setBooking setBranchCapacity setDelivery transition update updateLine',
  restaurantCustomers:
    'anonymize appendConsent appendInteraction assignTag attachToOrder correct create createTag export unassignTag',
  restaurantDashboard: 'updatePreferences',
  restaurantDelivery:
    'createAddress createZone deactivateZone deleteAddress reactivateZone setDefaultAddress updateAddress updateZone',
  restaurantDevices: 'registerPrinters renamePrinter retirePrinter',
  restaurantFloor:
    'assignServer createFloor createRoutingRule createSection createStation createTable deleteFloor deleteRoutingRule deleteSection deleteStation deleteTable setDefaultStation setSectionTables unassignServer updateFloor updateRoutingRule updateSection updateStation updateTable',
  restaurantGrowth: 'generate review',
  restaurantInsights: 'backfill importLabourCost',
  restaurantInventory:
    'addStockCountLine addStockTransferLine completeStockTransfer createLowStockRule createStockCount createStockItem createStockLocation createStockTransfer deleteLowStockRule postSaleReversal postStockCount postWastage setStockLocationActive submitStockCount updateLowStockRule',
  restaurantJobs: 'requeueDeadJob',
  restaurantLoyalty: 'adjust configure enrollAccount redeem',
  restaurantMenuImport: 'commit discard reviewLine upload',
  restaurantMenus:
    'activatePriceListVersion addAvailabilityWindow addPriceEntry clearItemOverride createItem createMenu createPriceList createPriceListVersion createPublication createSection deleteItem deleteMenu deleteSection publishPublication removeAvailabilityException removeAvailabilityWindow removePriceEntry retirePublication setAvailabilityException setItemOverride setPublicationChannels supersedePriceListVersion updateItem updateMenu updatePriceEntry updateSection',
  restaurantNotifications: 'markAllRead markRead retryWebhook testWebhook updateMatrix',
  restaurantOrders:
    'addItem adjustItem advanceItem cancel close fireCourse holdCourse mergeTables moveTable open removeItem requestRemake send unlinkTable voidItem',
  restaurantPayments: 'saveTerminalConfig',
  restaurantPromotions: 'createOffer disableOffer editOffer',
  restaurantPurchasing:
    'addPurchaseOrderLine approvePurchaseOrder cancelPurchaseOrder closePurchaseOrder createPurchaseOrder createSupplier createSupplierReturn receivePurchaseOrder removePurchaseOrderLine setSupplierActive submitPurchaseOrder updatePurchaseOrderLine updateSupplier',
  restaurantShifts:
    'cancel clockIn clockOut correctTime create endBreak requestSwap reviewSwap startBreak update',
  restaurantSop:
    'addStep claimOccurrence createAssignment createDraftVersion createEscalationPolicy createTemplate installAllPacks installPack publishVersion removeEscalationStep removeStep reorderSteps retireVersion setAssignmentActive setEscalationPolicyActive setTemplateActive updateAssignment updateEscalationPolicy updateStep updateTemplate upsertEscalationStep',
  restaurantSopExecution:
    'acknowledge attachEvidence claim completeStep reject start submit verify waive',
  restaurantTax: 'activate endServiceCharge publishCustom publishServiceCharge scheduleEnd',
  reviews: 'addReview closeCycle createCycle reopenCycle submitReview',
  'standalone:cameraPrivacy': 'revokeGrant setRetention',
  'standalone:pharmacyKhata': 'sendReminder',
  'standalone:pharmacyLoyalty':
    'adjustPoints issueCard revokeCard setEarnRate setMembership setReminderLanguage',
  'standalone:pharmacyPrepaid': 'move save',
  'standalone:pharmacyStagedReview.pharmacyMedicine': 'stageBatch stagingUpload',
  team: 'addPerformanceNote cancelLeaveRequest createLeaveRequest deletePerformanceNote markAllNotificationsRead markNotificationRead setLeaveBalance updateLeaveRequest updateLeaveStatus updateNotificationPrefs updateProfile',
  trelloImport: 'importBoard',
};

/** Why the close calls are on the "may" side. */
export const SUPPORT_MAY_NOTES: Readonly<Record<string, string>> = {
  'passwordReset.request':
    'Public. Sends the reset link to the member\u2019s own mailbox; the session plays no part.',
  'passwordReset.reset':
    'Public. Needs the one-time link from the member\u2019s own mailbox; the session plays no part.',
  'invitations.accept':
    'Public. Needs the one-time invitation link from the invited person\u2019s mailbox.',
  'pharmacySupplierLinks.submit':
    'Public. An outside supplier answering a signed one-time link; issuing the link is refused.',
  'projects.addMember': 'Shares one project among existing members. No new person or permission.',
  'projects.removeMember': 'Shares one project among existing members.',
  'projects.setMemberRole': 'Lead or member of one project, not a workspace role.',
  'chat.addMembers': 'Adds existing members to a channel.',
  'chat.removeMember': 'Removes a member from a channel.',
  'notes.setShares': 'Shares one note with existing members.',
  'team.updateProfile': 'Name, phone, bio and skills. It cannot change the sign-in email.',
  'organizationAdmin.retryDomain': 'Re-checks a host the owner added. Adding a host is refused.',
  'organizationAdmin.upsertDepartment': 'A department label, not a permission.',
  'organizationAdmin.removeDepartment': 'A department label, not a permission.',
  'pharmacyCameras.testConnection':
    'Simulator only. With real cameras the router\u2019s own rule refuses a support session.',
  'pharmacyCameras.setRetention':
    'Simulator only. With real cameras the router\u2019s own rule refuses a support session.',
  'pharmacyCameras.capturePending':
    'Simulator only. With real cameras the router\u2019s own rule refuses a support session.',
  'standalone:cameraPrivacy.setRetention':
    'Restaurant cameras refuse a support session in the router. Pharmacy retention is a setting.',
  'standalone:cameraPrivacy.revokeGrant':
    'Only takes live-view access away. Restaurant cameras refuse a support session in the router.',
  'restaurantCustomers.export':
    'One customer\u2019s own record, on request. Not the whole business.',
  'standalone:pharmacyLoyalty.issueCard':
    'A customer loyalty card number, not access to the business.',
  'standalone:pharmacyLoyalty.revokeCard':
    'A customer loyalty card number, not access to the business.',
  'restaurantLoyalty.enrollAccount': 'A customer loyalty account, not access to the business.',
  'restaurantDevices.registerPrinters':
    'Printer routing for an enrolled bridge. Enrolment is refused.',
  'restaurantDevices.renamePrinter': 'A printer label.',
  'restaurantDevices.retirePrinter': 'Removes a printer route. No credential.',
  'restaurantNotifications.testWebhook': 'Sends a test to the endpoint the owner configured.',
  'restaurantNotifications.retryWebhook': 'Re-queues a failed delivery to the configured endpoint.',
  'restaurantPayments.saveTerminalConfig': 'Maps a card terminal to a device. It stores no secret.',
  'pharmacySop.joinSite':
    'Adds the acting member\u2019s own SOP profile at a branch they already work at.',
  'resignations.submit':
    'The acting member\u2019s own notice. Approving one, which deactivates, is refused.',
};
