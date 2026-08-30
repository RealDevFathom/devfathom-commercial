import { router } from '../trpc';
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
import { restaurantReportsRouter } from './restaurant-reports';

export const appRouter = router({
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
  restaurantReports: restaurantReportsRouter,
});

export type AppRouter = typeof appRouter;
