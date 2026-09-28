/**
 * Loads the transfers console afresh at `href`. A document load rather than a
 * client-router push: the affected client stalls consuming some RSC navigation
 * streams after a Server Function (WHA-1344), and a transfer step must never
 * look unfinished once its stock movement has committed.
 */
export function loadTransfersPage(href: string) {
  window.location.assign(href);
}
