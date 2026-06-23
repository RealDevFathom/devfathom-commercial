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
});

export type AppRouter = typeof appRouter;
