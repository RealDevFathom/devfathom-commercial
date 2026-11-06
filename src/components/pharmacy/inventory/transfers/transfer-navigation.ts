/**
 * Loads the transfers console afresh at `href`. A document load rather than a
 * client-router push: the affected client stalls consuming some RSC navigation
 * streams after a Server Function (WHA-1344), and a transfer step must never
 * look unfinished once its stock movement has committed. It replaces the
 * current history entry so each step does not add another Back click.
 */
export function loadTransfersPage(href: string) {
  window.location.replace(href);
}
