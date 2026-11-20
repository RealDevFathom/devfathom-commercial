/*
 * DevFathom print window (DEV-973). Opened by src/lib/browser-print/print-window.ts.
 *
 * Opened with noopener, so the browser gives this window its own
 * browsing-context group (on https and on a plain-http LAN address alike): the
 * print dialog it opens pauses only this window, never the page that opened
 * it, and it has no reference back to that page. That page sends the finished,
 * escaped document over a BroadcastChannel named after the random id in this
 * URL's fragment; nothing about the document is in the URL, in storage or on
 * the server. This file carries no data of its own. It lives inside the counter
 * service worker's scope, which keeps a copy so offline printing still works.
 */
'use strict';
(function () {
  var CHANNEL_PREFIX = 'devfathom-print-window:';
  var ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Nothing arrived: the page that opened this window is gone.
  var ABANDONED_MS = 120000;
  // Attributes that take a URL a browser could navigate or run.
  var URL_ATTRIBUTES = ['href', 'src', 'action', 'formaction', 'xlink:href', 'srcdoc', 'data'];
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
    if (!received) closeSelf();
  }, ABANDONED_MS);

  function send(type) {
    try {
      channel.postMessage({ type: type });
    } catch (error) {
      // The opening page has gone; nothing to tell.
    }
  }

  // Said before closing: a message sent while the window is being torn down can be lost.
  function closeSelf() {
    send('closed');
    window.close();
  }

  function isScriptUrl(value) {
    // Browsers ignore control characters and spaces before the scheme.
    return /^javascript:/i.test(String(value).replace(/[\u0000- \u007f]+/g, ''));
  }

  /*
   * Defence in depth: the documents are built from escaped text, and this
   * page's Content-Security-Policy refuses inline script. Still, nothing that
   * can run, navigate or re-base this window survives into it.
   */
  function inert(doc) {
    var removed = doc.querySelectorAll('script, meta[http-equiv], base');
    for (var index = 0; index < removed.length; index += 1) removed[index].remove();
    var elements = doc.querySelectorAll('*');
    for (var e = 0; e < elements.length; e += 1) {
      var element = elements[e];
      var names = element.getAttributeNames();
      for (var a = 0; a < names.length; a += 1) {
        var name = names[a];
        var lower = name.toLowerCase();
        if (
          lower.indexOf('on') === 0 ||
          (URL_ATTRIBUTES.indexOf(lower) !== -1 && isScriptUrl(element.getAttribute(name)))
        ) {
          element.removeAttribute(name);
        }
      }
    }
    return doc;
  }

  function show(html) {
    // Parsed, never executed: DOMParser documents run no scripts.
    var parsed = inert(new DOMParser().parseFromString(html, 'text/html'));
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
      closeSelf();
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
        // The document stays on screen; the browser's own Print still works.
      }
    }, 0);
  };

  // Printed or cancelled: the dialog has closed, so this window has done its job.
  window.addEventListener('afterprint', function () {
    if (received) closeSelf();
  });
  window.addEventListener('pagehide', function () {
    send('closed');
  });
  send('ready');
})();
