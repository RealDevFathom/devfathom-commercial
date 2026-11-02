import { isModuleGranted, verticalForModuleKey, type EntitlementView } from '@/lib/module-catalog';

export function getSearchCategoryAccess({
  vertical,
  enabledModules,
}: Pick<EntitlementView, 'vertical' | 'enabledModules'>) {
  const allowed = (moduleKey: string) => {
    const moduleVertical = verticalForModuleKey(moduleKey);
    return (
      isModuleGranted(moduleKey, enabledModules) && (!moduleVertical || moduleVertical === vertical)
    );
  };
  const projects = allowed('projects');

  return {
    projects,
    tasks: projects,
    clients: allowed('clients'),
    notes: allowed('notes'),
    team: allowed('hr'),
  };
}
