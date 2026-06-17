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
});

export type AppRouter = typeof appRouter;
