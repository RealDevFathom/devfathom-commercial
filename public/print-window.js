/*
 * DevFathom print window (DEV-973). Opened by src/lib/browser-print/print-window.ts.
 *
 * Served with Cross-Origin-Opener-Policy: same-origin (next.config.ts), so the
 * browser gives this window its own browsing-context group: the print dialog
 * it opens pauses only this window, never the counter that opened it, and it
 * has no reference back to that page. The page that opened it sends the
 * finished, escaped document over a BroadcastChannel named after the random id
 * in this URL's fragment; nothing about the document is in the URL, in storage
 * or on the server. This file carries no data of its own.
 */
'use strict';
(function () {
  var CHANNEL_PREFIX = 'devfathom-print-window:';
  var ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Nothing arrived: the page that opened this window is gone.
  var ABANDONED_MS = 120000;
  var id = String(location.hash || '').slice(1);
  if (!ID.test(id) || typeof BroadcastChannel !== 'function') return;
  try {
    history.replaceState(null, '', location.pathname);
  } catch (error) {
    // The id only names a channel; keeping it in history is harmless.
  }
  var channel = new BroadcastChannel(CHANNEL_PREFIX + id);
  var received = false;
  var abandoned = setTimeout(function () {
    if (!received) window.close();
  }, ABANDONED_MS);

  function send(type) {
    try {
      channel.postMessage({ type: type });
    } catch (error) {
      // The opening page has gone; nothing to tell.
    }
  }

  function show(html) {
    // Parsed, never executed: DOMParser documents run no scripts, and this
    // page's Content-Security-Policy refuses inline script in any case.
    var parsed = new DOMParser().parseFromString(html, 'text/html');
    var scripts = parsed.querySelectorAll('script');
    for (var index = 0; index < scripts.length; index += 1) scripts[index].remove();
    document.replaceChild(
      document.importNode(parsed.documentElement, true),
      document.documentElement
    );
  }

  channel.onmessage = function (event) {
    var message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'focus') {
      window.focus();
      return;
    }
    if (message.type === 'close') {
      window.close();
      return;
    }
    if (message.type !== 'print' || received || typeof message.html !== 'string') return;
    received = true;
    clearTimeout(abandoned);
    show(message.html);
    window.focus();
    send('printing');
    // Printed from this window's own task, after the message has gone out.
    setTimeout(function () {
      try {
        window.print();
      } catch (error) {
        // The receipt stays on screen; the browser's own Print still works.
      }
    }, 0);
  };

  window.addEventListener('pagehide', function () {
    send('closed');
  });
  send('ready');
})();
