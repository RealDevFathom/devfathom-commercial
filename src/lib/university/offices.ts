import 'server-only';

import { academicsOffice, admissionsOffice } from './academics';
import { financeOffice } from './finance';
import { integrationOffice } from './events';
import { reportingOffice } from './reporting';
import { researchOffice } from './research';
import { servicesOffice } from './services';
import { scopesOffice } from './scopes';
import { academicSupportOffice } from './academic-support';
import { communityOffice } from './community';
import { retentionOffice } from './retention';
import { importsOffice } from './imports';
import type { UniversityOffice } from './office-types';

export const universityOffices: ReadonlyMap<string, UniversityOffice> = new Map([
  ['scopes', scopesOffice],
  ['student-support', academicSupportOffice],
  ['community', communityOffice],
  ['imports', importsOffice],
  ['admissions', admissionsOffice],
  ['academics', academicsOffice],
  ['finance', financeOffice],
  ['research', researchOffice],
  ['services', servicesOffice],
  ['reporting', reportingOffice],
  ['retention', retentionOffice],
  ['integrations', integrationOffice],
]);
