import { pharmacyCamerasRouter } from './pharmacy-cameras';
import { pharmacyMarketingRouter } from './pharmacy-marketing';
import { router } from '../trpc';
import { hotelPropertyRouter } from './hotel-property';
import { hotelRatesRouter } from './hotel-rates';
import { restaurantPromotionsRouter } from './restaurant-promotions';
import { platformHealthRouter } from './platform-health';
import { pharmacyOfflineRouter } from './pharmacy-offline';
import { dashboardRouter } from './dashboard';
import { projectsRouter } from './projects';
import { financeRouter } from './finance';
import { clientsRouter } from './clients';
import { chatRouter } from './chat';
import { teamRouter } from './team';
import { trelloImportRouter } from './trello-import';
import { meetingsRouter } from './meetings';
import { apiTokensRouter } from './api-tokens';
import { notesRouter } from './notes';
import { searchRouter } from './search';
import { teamStatsRouter } from './team-stats';
import { invitationsRouter } from './invitations';
import { auditRouter } from './audit';
import { resignationsRouter } from './resignations';
import { passwordResetRouter } from './password-reset';
import { reviewsRouter } from './reviews';
import { twoFactorRouter } from './two-factor';
import { webhooksRouter } from './webhooks';
import { emailRouter } from './email';
import { organizationAdminRouter } from './organization-admin';
import { restaurantStaffRouter } from './restaurant-staff';
import { restaurantShiftsRouter } from './restaurant-shifts';
import { restaurantDevicesRouter } from './restaurant-devices';
import { restaurantCamerasRouter } from './restaurant-cameras';
import { restaurantCatalogRouter } from './restaurant-catalog';
import { restaurantMenusRouter } from './restaurant-menus';
import { restaurantMenuImportRouter } from './restaurant-menu-import';
import { restaurantFloorRouter } from './restaurant-floor';
import { restaurantOrdersRouter } from './restaurant-orders';
import { restaurantBillsRouter } from './restaurant-bills';
import { restaurantCashRouter } from './restaurant-cash';
import { restaurantPaymentsRouter } from './restaurant-payments';
import { restaurantInventoryRouter } from './restaurant-inventory';
import { restaurantPurchasingRouter } from './restaurant-purchasing';
import { restaurantJobsRouter } from './restaurant-jobs';
import { restaurantSopRouter } from './restaurant-sop';
import { restaurantSopExecutionRouter } from './restaurant-sop-execution';
import { restaurantNotificationsRouter } from './restaurant-notifications';
import { restaurantCustomersRouter } from './restaurant-customers';
import { restaurantLoyaltyRouter } from './restaurant-loyalty';
import { restaurantInsightsRouter } from './restaurant-insights';
import { restaurantTaxRouter } from './restaurant-tax';
import { restaurantDashboardRouter } from './restaurant-dashboard';
import { restaurantReportsRouter } from './restaurant-reports';
import { restaurantBranchesRouter } from './restaurant-branches';
import { restaurantDeliveryRouter } from './restaurant-delivery';
import { restaurantCateringRouter } from './restaurant-catering';
import { restaurantGrowthRouter } from './restaurant-growth';
import { pharmacyMedicineRouter } from './pharmacy-medicine';
import { pharmacyPurchasingRouter } from './pharmacy-purchasing';
import { pharmacyInventoryRouter } from './pharmacy-inventory';
import { pharmacyOwnerImportRouter } from './pharmacy-owner-import';
import { pharmacyPrescriptionsRouter } from './pharmacy-prescriptions';
import { pharmacyDispensingRouter } from './pharmacy-dispensing';
import { pharmacySafetyRouter } from './pharmacy-safety';
import { pharmacySalesRouter } from './pharmacy-sales';
import { pharmacyBranchAssignmentsRouter } from './pharmacy-branch-assignments';
import { pharmacyReportsRouter } from './pharmacy-reports';
import { pharmacyFinanceRouter } from './pharmacy-finance';
import { pharmacyOnboardingRouter } from './pharmacy-onboarding';
import { pharmacyOrderingRouter } from './pharmacy-ordering';
import { pharmacySupplierLinksRouter } from './pharmacy-supplier-links';
import { pharmacyAccessRouter } from './pharmacy-access';

export const appRouter = router({
  hotelProperty: hotelPropertyRouter,
  hotelRates: hotelRatesRouter,
  restaurantPromotions: restaurantPromotionsRouter,
  platformHealth: platformHealthRouter,
  pharmacyOffline: pharmacyOfflineRouter,
  dashboard: dashboardRouter,
  projects: projectsRouter,
  finance: financeRouter,
  clients: clientsRouter,
  chat: chatRouter,
  team: teamRouter,
  trelloImport: trelloImportRouter,
  meetings: meetingsRouter,
  apiTokens: apiTokensRouter,
  notes: notesRouter,
  search: searchRouter,
  teamStats: teamStatsRouter,
  invitations: invitationsRouter,
  audit: auditRouter,
  resignations: resignationsRouter,
  passwordReset: passwordResetRouter,
  reviews: reviewsRouter,
  twoFactor: twoFactorRouter,
  webhooks: webhooksRouter,
  email: emailRouter,
  organizationAdmin: organizationAdminRouter,
  restaurantStaff: restaurantStaffRouter,
  restaurantShifts: restaurantShiftsRouter,
  restaurantDevices: restaurantDevicesRouter,
  restaurantCameras: restaurantCamerasRouter,
  restaurantCatalog: restaurantCatalogRouter,
  restaurantMenus: restaurantMenusRouter,
  restaurantMenuImport: restaurantMenuImportRouter,
  restaurantFloor: restaurantFloorRouter,
  restaurantOrders: restaurantOrdersRouter,
  restaurantBills: restaurantBillsRouter,
  restaurantCash: restaurantCashRouter,
  restaurantPayments: restaurantPaymentsRouter,
  restaurantInventory: restaurantInventoryRouter,
  restaurantPurchasing: restaurantPurchasingRouter,
  restaurantJobs: restaurantJobsRouter,
  restaurantSop: restaurantSopRouter,
  restaurantSopExecution: restaurantSopExecutionRouter,
  restaurantNotifications: restaurantNotificationsRouter,
  restaurantCustomers: restaurantCustomersRouter,
  restaurantLoyalty: restaurantLoyaltyRouter,
  restaurantInsights: restaurantInsightsRouter,
  restaurantTax: restaurantTaxRouter,
  restaurantDashboard: restaurantDashboardRouter,
  restaurantReports: restaurantReportsRouter,
  restaurantBranches: restaurantBranchesRouter,
  restaurantDelivery: restaurantDeliveryRouter,
  restaurantCatering: restaurantCateringRouter,
  restaurantGrowth: restaurantGrowthRouter,
  pharmacyMedicine: pharmacyMedicineRouter,
  pharmacyPurchasing: pharmacyPurchasingRouter,
  pharmacyInventory: pharmacyInventoryRouter,
  pharmacyOwnerImport: pharmacyOwnerImportRouter,
  pharmacyPrescriptions: pharmacyPrescriptionsRouter,
  pharmacyDispensing: pharmacyDispensingRouter,
  pharmacySafety: pharmacySafetyRouter,
  pharmacySales: pharmacySalesRouter,
  pharmacyBranchAssignments: pharmacyBranchAssignmentsRouter,
  pharmacyReports: pharmacyReportsRouter,
  pharmacyCameras: pharmacyCamerasRouter,
  pharmacyMarketing: pharmacyMarketingRouter,
  pharmacyFinance: pharmacyFinanceRouter,
  pharmacyOnboarding: pharmacyOnboardingRouter,
  pharmacyOrdering: pharmacyOrderingRouter,
  pharmacySupplierLinks: pharmacySupplierLinksRouter,
  pharmacyAccess: pharmacyAccessRouter,
});

export type AppRouter = typeof appRouter;
