/**
 * Marketing access denials, one per requirement (DEV-606). The router checks
 * the requirements one at a time and throws the message for the first that is
 * missing, so the page can say exactly what is wrong and what to do next.
 *
 * The owner check runs first and alone: a cashier or pharmacist learns only
 * that Marketing belongs to the owner, never the license, lifecycle or branch
 * state behind it.
 */
export const MARKETING_ACCESS_DENIAL = {
  OWNER:
    'Marketing is for the pharmacy owner. Ask your pharmacy owner to prepare campaigns, or sign in with the owner account.',
  LICENSE:
    'Your workspace does not include Pharmacy CRM, which Marketing needs. Contact DevFathom to add Pharmacy CRM to your plan.',
  PHARMACY: 'Marketing is only available in pharmacy workspaces.',
  WORKSPACE:
    'This pharmacy workspace is not active, so Marketing is paused. Contact DevFathom support to reactivate it.',
  BRANCH:
    'This branch is not active in your workspace. Open Marketing for one of your active branches instead.',
  // Branches are provisioned by DevFathom; owners cannot create or reactivate one.
  NO_BRANCH:
    'Marketing works one branch at a time, and this workspace has no active pharmacy branch yet. Contact DevFathom support to activate a branch.',
} as const;

/** The page's fallback when a denial carries no message of its own. */
export const MARKETING_ACCESS_FALLBACK =
  'You do not have access to Marketing. Ask your pharmacy owner for help.';
