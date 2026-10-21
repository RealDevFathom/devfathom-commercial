import type { StageName } from './config';

export interface ResourceNames {
  readonly short: 'stg' | 'prd';
  readonly prefix: string;
  readonly cluster: string;
  readonly webRepo: string;
  readonly migrateRepo: string;
  readonly evolutionRepo: string;
  readonly webService: string;
  readonly evolutionService: string;
  readonly webFamily: string;
  readonly migrateFamily: string;
  readonly evolutionFamily: string;
  readonly executionRole: string;
  readonly webTaskRole: string;
  readonly evolutionTaskRole: string;
  readonly migrateTaskRole: string;
  readonly deployRole: string;
  readonly imageTagParameter: string;
}

export function resourceNames(stage: StageName): ResourceNames {
  const short = stage === 'production' ? 'prd' : 'stg';
  const prefix = `devfathom-${short}`;
  return {
    short,
    prefix,
    cluster: prefix,
    webRepo: `${prefix}-web`,
    migrateRepo: `${prefix}-migrate`,
    evolutionRepo: `${prefix}-evolution`,
    webService: `${prefix}-web`,
    evolutionService: `${prefix}-evolution`,
    webFamily: `${prefix}-web`,
    migrateFamily: `${prefix}-migrate`,
    evolutionFamily: `${prefix}-evolution`,
    executionRole: `${prefix}-ecs-exec`,
    webTaskRole: `${prefix}-web-task`,
    evolutionTaskRole: `${prefix}-evo-task`,
    migrateTaskRole: `${prefix}-migrate-task`,
    deployRole: `${prefix}-gha-deploy`,
    imageTagParameter: `/devfathom/${stage}/deployed-image-tag`,
  };
}
